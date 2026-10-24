// The Fog City relay: an HTTP server with /health and one WebSocket endpoint, /relay. Rooms are
// private (an 8-letter invitation code from a CSPRNG); everything a peer sends is size-capped,
// rate-limited per socket and per IP, and parsed into a closed message shape before use.
import { createHash, randomBytes } from "node:crypto";
import type { RelayStore } from "../store/store.ts";
import { codeTag, silentLogger, type Logger } from "../ops/log.ts";
import { prometheus, TickStats } from "../ops/metrics.ts";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ERRORS, MAX_MESSAGE_BYTES, MODES, ROOM_ALPHABET, parseClientMessage, type ErrorCode, type Hello, type NetModeId, type RoomList, type ServerMessage, type WorldName } from "../../src/net/protocol.ts";
import { DEFAULT_ROOM_LIMITS, Room, type Peer, type RoomLimits } from "./room.ts";
import { FixedClock } from "./clock.ts";
import type { WorldBundle } from "./world.ts";
import type { Spawn } from "../../src/sim/contract.ts";

export interface RelayLimits {
  maxRooms: number;
  /** Matches running at once. Every match ticks on the one event loop: past what a core can run at
   * 60 Hz, every match slows down, so further starts are refused instead (server/README.md, Capacity). */
  maxMatches: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  /** Rooms one IP may have open at once. */
  maxRoomsPerIp: number;
  /** Failed join/rejoin attempts per IP per minute (room-code guessing). */
  maxFailedJoinsPerIpPerMinute: number;
  /** Messages per socket per second (a match sends 60 inputs a second). */
  maxMessagesPerSecond: number;
  /** Messages per IP per second across all its sockets. */
  maxMessagesPerIpPerSecond: number;
  /** A socket that has not joined a room by then is closed. */
  joinTimeoutMs: number;
  /** A lobby socket that sends nothing for this long is closed (clients ping every 15 s). */
  lobbyIdleMs: number;
  /** A socket whose unsent bytes exceed this is closed rather than buffered without bound. */
  maxBufferedBytes: number;
}
export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxRooms: 16, maxMatches: 2, maxConnections: 128, maxConnectionsPerIp: 8, maxRoomsPerIp: 2, maxFailedJoinsPerIpPerMinute: 20,
  maxMessagesPerSecond: 150, maxMessagesPerIpPerSecond: 600, joinTimeoutMs: 15_000, lobbyIdleMs: 60_000, maxBufferedBytes: 4 * 1024 * 1024,
};

export interface RelayOptions {
  /** Worlds served, already loaded (a relay never loads a world on a peer's request). */
  worlds: ReadonlyMap<WorldName, WorldBundle>;
  /** Approved Bot Sweep arena spawns per world. */
  arenas: ReadonlyMap<WorldName, readonly Spawn[]>;
  /** Exact browser origins allowed to connect, e.g. https://example.github.io. Loopback pages are always allowed. */
  allowedOrigins?: readonly string[];
  /** Read the client IP from this request header (set by a trusted proxy, e.g. fly-client-ip). */
  clientIpHeader?: string;
  limits?: Partial<RelayLimits>;
  room?: Partial<RoomLimits>;
  /** Match history, stats and leaderboards; absent: nothing is remembered between matches. */
  store?: RelayStore;
  now?: () => number;
  /** false: the caller drives tick() (tests). */
  automaticTicks?: boolean;
  /** Structured log sink (server/ops/log.ts); silent by default. */
  logger?: Logger;
  /** When set, GET /metrics requires `Authorization: Bearer <token>`. */
  metricsToken?: string;
}

const loopback = (host: string | undefined): boolean => host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";

export function createRelay(options: RelayOptions) {
  const now = options.now ?? Date.now;
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
  const roomLimits: RoomLimits = { ...DEFAULT_ROOM_LIMITS, ...options.room };
  const log = options.logger ?? silentLogger;
  const startedAt = now();
  const ticks = new TickStats();
  // The whole relay tick (every room, one after another): over 16.7 ms and every match runs slow.
  const loops = new TickStats();
  let relayTicks = 0;
  const totals = { matchesStarted: 0, matchesFinished: 0, roomsCreated: 0, connections: 0 };
  let draining = false;
  const rooms = new Map<string, Room>();
  const perIp = new Map<string, { sockets: number; failed: number[]; window: number; messages: number }>();
  const counters = { refused: 0, rateLimited: 0, invalid: 0, matchesRefused: 0 };
  const ipState = (ip: string) => {
    let entry = perIp.get(ip);
    if (!entry) { entry = { sockets: 0, failed: [], window: 0, messages: 0 }; perIp.set(ip, entry); }
    return entry;
  };
  const roomsOf = (ip: string): number => { let n = 0; for (const room of rooms.values()) if (!room.closed && room.creatorIp === ip) n++; return n; };

  const httpWindows = new Map<string, { start: number; count: number }>();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin && originAllowed(req) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "x-fogcity-device", vary: "Origin" } : { vary: "Origin" };
    if (req.method === "OPTIONS" && (path === "/me" || path === "/leaderboard" || path === "/rooms")) { res.writeHead(204, { ...cors, "access-control-allow-methods": "GET" }); res.end(); return; }
    if (req.method === "GET" && (path === "/leaderboard" || path === "/me")) {
      // Cheap indexed reads, still capped per IP so a script cannot hammer the database.
      const ip = clientIp(req), t = now(), window = httpWindows.get(ip) ?? { start: t, count: 0 };
      if (t - window.start >= 10_000) { window.start = t; window.count = 0; }
      window.count++; httpWindows.set(ip, window);
      if (httpWindows.size > 10_000) httpWindows.clear();
      if (window.count > 30) { res.writeHead(429, cors); res.end(); return; }
      const json = (status: number, body: unknown): void => { res.writeHead(status, { ...cors, "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
      if (!options.store) { json(404, { error: "no_store" }); return; }
      if (path === "/leaderboard") {
        const query = new URL(req.url ?? "/", "http://relay").searchParams, mode = query.get("mode") as NetModeId, period = query.get("period") === "all" ? "all" : "week";
        if (!MODES.includes(mode)) { json(400, { error: "mode" }); return; }
        json(200, { mode, period, entries: options.store.leaderboard(mode, period, t, 10) });
      } else {
        const token = req.headers["x-fogcity-device"];
        if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) { json(400, { error: "device" }); return; }
        json(200, { stats: options.store.stats(createHash("sha256").update(token).digest("hex")) });
      }
      return;
    }
    if (req.method === "GET" && path === "/rooms") {
      // The public lobby list, readable by the game's page (CORS for allowed origins only).
      const headers: Record<string, string> = { ...cors, "content-type": "application/json", "cache-control": "no-store" };
      const world = new URL(req.url ?? "/", "http://relay").searchParams.get("world");
      const list: RoomList = { online: sockets.clients.size, rooms: [...rooms.values()].filter((r) => !r.closed && r.visibility === "public" && r.phase !== "results" && (!world || r.bundle.name === world))
        .sort((a, b) => b.size - a.size || a.createdAt - b.createdAt).slice(0, 50).map((r) => r.listing()) };
      res.writeHead(200, headers);
      res.end(JSON.stringify(list));
      return;
    }
    if (req.method === "GET" && path === "/ready") {
      // Readiness: false while draining, so a load balancer stops sending new players here.
      res.writeHead(draining ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ready: !draining }));
      return;
    }
    if (req.method === "GET" && path === "/metrics") {
      if (options.metricsToken && req.headers.authorization !== `Bearer ${options.metricsToken}`) { res.writeHead(401); res.end(); return; }
      const phases: Record<string, number> = { lobby: 0, match: 0, results: 0 };
      let mismatches = 0, behind = 0, snapshots = 0, dropped = 0, players = 0, spectators = 0;
      for (const room of rooms.values()) {
        phases[room.phase] = (phases[room.phase] ?? 0) + 1;
        mismatches += room.stats.mismatches; behind += room.stats.behind; snapshots += room.stats.snapshots; dropped += room.stats.droppedInputs;
        players += room.size; spectators += room.spectators;
      }
      const memory = process.memoryUsage(), cpu = process.cpuUsage();
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
      res.end(prometheus({
        uptime_seconds: { help: "Seconds since the relay started.", type: "gauge", value: Math.round((now() - startedAt) / 1000) },
        draining: { help: "1 while the relay is draining for a restart.", type: "gauge", value: draining ? 1 : 0 },
        rooms: { help: "Open rooms by phase.", type: "gauge", value: phases },
        connections: { help: "Open WebSocket connections.", type: "gauge", value: sockets.clients.size },
        seated_players: { help: "Players seated in rooms.", type: "gauge", value: players },
        spectators: { help: "Spectators in rooms.", type: "gauge", value: spectators },
        connections_total: { help: "WebSocket connections accepted.", type: "counter", value: totals.connections },
        rooms_created_total: { help: "Rooms created.", type: "counter", value: totals.roomsCreated },
        matches_started_total: { help: "Matches started.", type: "counter", value: totals.matchesStarted },
        matches_finished_total: { help: "Matches finished.", type: "counter", value: totals.matchesFinished },
        hash_mismatches: { help: "Client hash mismatches in open rooms (each answered with one snapshot).", type: "gauge", value: mismatches },
        behind_resyncs: { help: "Snapshots sent to clients too far behind, in open rooms.", type: "gauge", value: behind },
        snapshots: { help: "Snapshots sent in open rooms.", type: "gauge", value: snapshots },
        dropped_inputs: { help: "Inputs dropped from over-full queues in open rooms.", type: "gauge", value: dropped },
        refused_total: { help: "Upgrades refused (origin, path, caps).", type: "counter", value: counters.refused },
        matches_refused_total: { help: "Match starts refused because maxMatches were running.", type: "counter", value: counters.matchesRefused },
        rate_limited_total: { help: "Sockets closed for message rate.", type: "counter", value: counters.rateLimited },
        invalid_total: { help: "Invalid messages.", type: "counter", value: counters.invalid },
        tick_ms_p50: { help: "Median room tick time, ms (last 3600 room ticks).", type: "gauge", value: Math.round(ticks.quantile(.5) * 100) / 100 },
        tick_ms_p99: { help: "99th percentile room tick time, ms.", type: "gauge", value: Math.round(ticks.quantile(.99) * 100) / 100 },
        tick_overruns_total: { help: "Room ticks longer than one 60 Hz frame.", type: "counter", value: ticks.overruns },
        loop_ms_p50: { help: "Median whole relay tick (all rooms) while a match runs, ms.", type: "gauge", value: Math.round(loops.quantile(.5) * 100) / 100 },
        loop_ms_p99: { help: "99th percentile whole relay tick, ms. Over 16.7 and matches run slower than real time.", type: "gauge", value: Math.round(loops.quantile(.99) * 100) / 100 },
        loop_overruns_total: { help: "Whole relay ticks longer than one 60 Hz frame.", type: "counter", value: loops.overruns },
        ticks_total: { help: "Relay ticks run (60 a second when keeping up).", type: "counter", value: relayTicks },
        cpu_seconds_total: { help: "Process CPU time, user plus system.", type: "counter", value: Math.round((cpu.user + cpu.system) / 1000) / 1000 },
        memory_rss_bytes: { help: "Resident memory.", type: "gauge", value: memory.rss },
        heap_used_bytes: { help: "V8 heap in use.", type: "gauge", value: memory.heapUsed },
      }));
      return;
    }
    if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
      let mismatches = 0, snapshots = 0;
      for (const room of rooms.values()) { mismatches += room.stats.mismatches; snapshots += room.stats.snapshots; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, draining, rooms: rooms.size, connections: sockets.clients.size, worlds: [...options.worlds.keys()], mismatches, snapshots, ...counters }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Fog City relay: connect a WebSocket to /relay\n");
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  const clientIp = (req: IncomingMessage): string => {
    if (options.clientIpHeader) {
      const header = req.headers[options.clientIpHeader.toLowerCase()];
      const value = (Array.isArray(header) ? header[header.length - 1] : header)?.split(",").pop()?.trim();
      if (value) return value;
    }
    return req.socket.remoteAddress ?? "unknown";
  };
  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return loopback(req.socket.remoteAddress);
    if (options.allowedOrigins?.includes(origin)) return true;
    try {
      const parsed = new URL(origin);
      return loopback(req.socket.remoteAddress) && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
    } catch { return false; }
  };
  const refuse = (socket: import("node:stream").Duplex, status: string): void => {
    counters.refused++;
    log("warn", "upgrade.refused", { status: Number(status.slice(0, 3)) });
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/relay" || !originAllowed(req)) { refuse(socket, "403 Forbidden"); return; }
    if (sockets.clients.size >= limits.maxConnections) { refuse(socket, "503 Service Unavailable"); return; }
    const ip = clientIp(req), entry = ipState(ip);
    if (entry.sockets >= limits.maxConnectionsPerIp) { refuse(socket, "429 Too Many Requests"); return; }
    entry.sockets++;
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, ip));
  });

  sockets.on("connection", (socket: WebSocket, ip: string) => {
    const entry = ipState(ip);
    totals.connections++;
    let room: Room | null = null, playerId = "", windowStart = now(), count = 0, alive = true, lastMessage = now();
    let released = false;
    const release = (): void => { if (!released) { released = true; entry.sockets--; if (entry.sockets <= 0 && !entry.failed.length) perIp.delete(ip); } };
    const send = (message: ServerMessage): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > limits.maxBufferedBytes) { close("slow_client"); return; }
      socket.send(JSON.stringify(message));
    };
    let closing = false;
    const close = (code: ErrorCode): void => {
      closing = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "error", code, message: ERRORS[code] } satisfies ServerMessage));
        socket.close(code === "replaced" ? 4001 : 4000, code);
      }
    };
    const peer: Peer = { send, close };
    const joinDeadline = setTimeout(() => { if (!room) close("idle"); }, limits.joinTimeoutMs);
    joinDeadline.unref();
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      if (room?.phase !== "match" && now() - lastMessage >= limits.lobbyIdleMs) { close("idle"); return; }
      alive = false;
      socket.ping();
    }, 20_000);
    heartbeat.unref();
    socket.on("pong", () => { alive = true; });

    const hello = (message: Hello): void => {
      if (room) throw new Error("invalid_message");
      const bundle = options.worlds.get(message.world);
      if (!bundle) throw new Error("world_unavailable");
      if (bundle.fingerprint !== message.fingerprint) throw new Error("world_mismatch");
      const t = now();
      // Draining for a restart: people already seated can rejoin; nobody new comes in.
      if (draining && message.action !== "rejoin") throw new Error("draining");
      const quick = message.action === "quick" ? [...rooms.values()].filter((r) => r.open() && r.bundle.name === message.world)
        .sort((a, b) => b.size - a.size || a.createdAt - b.createdAt)[0] : undefined;
      if (quick) {
        playerId = quick.join(peer, t, message.profile, message.device);
        room = quick;
      } else if (message.action === "create" || message.action === "quick") {
        if (rooms.size >= limits.maxRooms) throw new Error("server_full");
        if (roomsOf(ip) >= limits.maxRoomsPerIp) throw new Error("too_many_rooms");
        let code: string;
        do { code = Array.from(randomBytes(8), (n) => ROOM_ALPHABET[n & 31]!).join(""); } while (rooms.has(code));
        const created = new Room(code, bundle, t, ip, options.arenas.get(message.world) ?? [], roomLimits, message.action === "quick" ? "public" : "private");
        const store = options.store;
        created.onStarted = (mode, players) => { totals.matchesStarted++; log("info", "match.started", { room: codeTag(code), mode, players }); };
        created.onFinished = (match) => {
          totals.matchesFinished++;
          log("info", "match.finished", { room: codeTag(code), mode: match.mode, reason: match.reason, people: match.players.length, seconds: Math.round((match.endedAt - match.startedAt) / 1000) });
          if (store) { try { store.recordMatch(match); } catch (error) { log("error", "store.record_failed", { message: error instanceof Error ? error.message : "unknown" }); } }
        };
        totals.roomsCreated++;
        rooms.set(code, created);
        playerId = created.join(peer, t, message.profile, message.device);
        room = created;
        log("info", "room.created", { room: codeTag(code), visibility: created.visibility, world: message.world });
      } else {
        entry.failed = entry.failed.filter((at) => t - at < 60_000);
        if (entry.failed.length >= limits.maxFailedJoinsPerIpPerMinute) throw new Error("rate_limit");
        const found = rooms.get(message.code!);
        try {
          if (!found || found.closed) throw new Error("room_missing");
          if (found.bundle.name !== message.world) throw new Error("world_mismatch");
          playerId = message.action === "join" ? found.join(peer, t, message.profile, message.device)
            : message.action === "spectate" ? found.spectate(peer, t, message.profile, message.device)
            : found.rejoin(peer, message.token!, t, message.profile, message.device);
          room = found;
        } catch (error) {
          entry.failed.push(t);
          throw error;
        }
      }
      clearTimeout(joinDeadline);
    };

    socket.on("message", (bytes, binary) => {
      if (closing) return;
      const t = now();
      lastMessage = t;
      if (t - windowStart >= 1000) { windowStart = t; count = 0; }
      if (t - entry.window >= 1000) { entry.window = t; entry.messages = 0; }
      count++; entry.messages++;
      if (count > limits.maxMessagesPerSecond || entry.messages > limits.maxMessagesPerIpPerSecond) { counters.rateLimited++; log("warn", "socket.rate_limited", { room: room ? codeTag(room.code) : "" }); close("rate_limit"); return; }
      try {
        if (binary) throw new Error("invalid_message");
        const message = parseClientMessage(bytes.toString());
        if (message.type === "hello") { hello(message); return; }
        if (message.type === "ping") { send({ type: "pong", t: message.t }); return; }
        if (!room || !playerId) throw new Error("invalid_message");
        switch (message.type) {
          case "input": room.input(playerId, message.seq, message.input, t); break;
          case "command": room.command(playerId, message.command); break;
          case "ready": room.ready(playerId, message.ready); break;
          case "bots": room.setBots(playerId, message.count); break;
          case "mode": room.setMode(playerId, message.mode); break;
          case "chat": room.chat(playerId, message.phrase, t); break;
          case "rematch": room.rematch(playerId); break;
          case "start": {
            let running = 0;
            for (const other of rooms.values()) if (other.phase === "match") running++;
            if (room.phase === "lobby" && running >= limits.maxMatches) { counters.matchesRefused++; throw new Error("matches_full"); }
            room.start(playerId, message.mode, t);
            break;
          }
          case "end": room.end(playerId); break;
          case "resync": room.resync(playerId, message.reason, t); break;
          case "leave": { const left = room; room = null; left.leave(playerId); playerId = ""; socket.close(1000, "left"); break; }
        }
      } catch (error) {
        const code = error instanceof Error && Object.hasOwn(ERRORS, error.message) ? error.message as ErrorCode : "invalid_message";
        if (code === "invalid_message") counters.invalid++;
        // Lobby mistakes are recoverable; anything else ends this connection.
        if ((code === "not_host" || code === "not_ready" || code === "arena_unavailable" || code === "matches_full") && room) send({ type: "error", code, message: ERRORS[code] });
        else close(code);
      }
    });
    socket.on("error", () => { /* ws reports oversized or malformed frames here, then closes. */ });
    socket.on("close", () => {
      clearTimeout(joinDeadline); clearInterval(heartbeat);
      if (room && playerId) room.disconnect(playerId, peer, now());
      release();
    });
  });

  const tick = (): void => {
    const t = now(), loopStart = performance.now();
    let anyPlaying = false;
    relayTicks++;
    for (const [code, room] of rooms) {
      const playing = room.phase === "match", started = playing ? performance.now() : 0;
      room.tick(t);
      if (playing) { ticks.record(performance.now() - started); anyPlaying = true; }
      if (room.closed) { rooms.delete(code); log("info", "room.closed", { room: codeTag(code) }); }
    }
    if (anyPlaying) loops.record(performance.now() - loopStart);
  };

  /**
   * Graceful restart: refuse new players, tell everyone, let running matches play for up to
   * `graceMs`, then end each one as a recorded decision (so results and payouts still happen once),
   * give clients a moment to receive their results, and resolve. The caller then closes.
   */
  async function drain(graceMs: number, settleMs = 3000): Promise<void> {
    if (draining) return;
    draining = true;
    const endsAt = now() + graceMs, graceUntil = performance.now() + graceMs;
    log("info", "drain.start", { rooms: rooms.size, graceMs });
    for (const room of rooms.values()) room.notify({ type: "notice", kind: "draining", endsAt });
    const wait = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
    // Real time here (the injectable clock drives room logic, not this wait).
    while (performance.now() < graceUntil && [...rooms.values()].some((r) => r.phase === "match")) await wait(250);
    for (const room of rooms.values()) room.forceEnd();
    const settleUntil = performance.now() + settleMs;
    while (performance.now() < settleUntil && [...rooms.values()].some((r) => r.phase === "match")) await wait(100);
    await wait(500);
    log("info", "drain.done", { rooms: rooms.size, matchesFinished: totals.matchesFinished });
  }
  // Timers round fractional milliseconds: accumulate elapsed time and run whole 60 Hz ticks.
  const clock = new FixedClock(performance.now());
  const timer = options.automaticTicks === false ? null : setInterval(() => {
    for (let remaining = clock.take(performance.now()); remaining > 0; remaining--) tick();
  }, 4);
  timer?.unref();

  return {
    server, rooms, tick, counters, drain, isDraining: () => draining,
    async listen(port = 8787, host = "127.0.0.1"): Promise<number> {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("invalid_address");
      return address.port;
    },
    async close(): Promise<void> {
      if (timer) clearInterval(timer);
      for (const room of rooms.values()) room.close("room_expired");
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}
export type Relay = ReturnType<typeof createRelay>;
