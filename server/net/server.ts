// The Fog City relay: an HTTP server with /health and one WebSocket endpoint, /relay. Rooms are
// private (an 8-letter invitation code from a CSPRNG); everything a peer sends is size-capped,
// rate-limited per socket and per IP, and parsed into a closed message shape before use.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ERRORS, MAX_MESSAGE_BYTES, ROOM_ALPHABET, parseClientMessage, type ErrorCode, type Hello, type RoomList, type ServerMessage, type WorldName } from "../../src/net/protocol.ts";
import { DEFAULT_ROOM_LIMITS, Room, type Peer, type RoomLimits } from "./room.ts";
import { FixedClock } from "./clock.ts";
import type { WorldBundle } from "./world.ts";
import type { Spawn } from "../../src/sim/contract.ts";

export interface RelayLimits {
  maxRooms: number;
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
  maxRooms: 16, maxConnections: 128, maxConnectionsPerIp: 8, maxRoomsPerIp: 2, maxFailedJoinsPerIpPerMinute: 20,
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
  now?: () => number;
  /** false: the caller drives tick() (tests). */
  automaticTicks?: boolean;
  log?: (line: string) => void;
}

const loopback = (host: string | undefined): boolean => host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";

export function createRelay(options: RelayOptions) {
  const now = options.now ?? Date.now;
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
  const roomLimits: RoomLimits = { ...DEFAULT_ROOM_LIMITS, ...options.room };
  const log = options.log ?? (() => {});
  const rooms = new Map<string, Room>();
  const perIp = new Map<string, { sockets: number; failed: number[]; window: number; messages: number }>();
  const counters = { refused: 0, rateLimited: 0, invalid: 0 };
  const ipState = (ip: string) => {
    let entry = perIp.get(ip);
    if (!entry) { entry = { sockets: 0, failed: [], window: 0, messages: 0 }; perIp.set(ip, entry); }
    return entry;
  };
  const roomsOf = (ip: string): number => { let n = 0; for (const room of rooms.values()) if (!room.closed && room.creatorIp === ip) n++; return n; };

  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/rooms") {
      // The public lobby list, readable by the game's page (CORS for allowed origins only).
      const origin = req.headers.origin;
      const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store", vary: "Origin" };
      if (origin && originAllowed(req)) headers["access-control-allow-origin"] = origin;
      const world = new URL(req.url ?? "/", "http://relay").searchParams.get("world");
      const list: RoomList = { online: sockets.clients.size, rooms: [...rooms.values()].filter((r) => !r.closed && r.visibility === "public" && r.phase !== "results" && (!world || r.bundle.name === world))
        .sort((a, b) => b.size - a.size || a.createdAt - b.createdAt).slice(0, 50).map((r) => r.listing()) };
      res.writeHead(200, headers);
      res.end(JSON.stringify(list));
      return;
    }
    if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
      let mismatches = 0, snapshots = 0;
      for (const room of rooms.values()) { mismatches += room.stats.mismatches; snapshots += room.stats.snapshots; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: sockets.clients.size, worlds: [...options.worlds.keys()], mismatches, snapshots, ...counters }));
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
        rooms.set(code, created);
        playerId = created.join(peer, t, message.profile, message.device);
        room = created;
        log(`room ${code.slice(0, 2)}… created`);
      } else {
        entry.failed = entry.failed.filter((at) => t - at < 60_000);
        if (entry.failed.length >= limits.maxFailedJoinsPerIpPerMinute) throw new Error("rate_limit");
        const found = rooms.get(message.code!);
        try {
          if (!found || found.closed) throw new Error("room_missing");
          if (found.bundle.name !== message.world) throw new Error("world_mismatch");
          playerId = message.action === "join" ? found.join(peer, t, message.profile, message.device) : found.rejoin(peer, message.token!, t, message.profile, message.device);
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
      if (count > limits.maxMessagesPerSecond || entry.messages > limits.maxMessagesPerIpPerSecond) { counters.rateLimited++; close("rate_limit"); return; }
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
          case "start": room.start(playerId, message.mode, t); break;
          case "end": room.end(playerId); break;
          case "resync": room.resync(playerId, message.reason, t); break;
          case "leave": { const left = room; room = null; left.leave(playerId); playerId = ""; socket.close(1000, "left"); break; }
        }
      } catch (error) {
        const code = error instanceof Error && Object.hasOwn(ERRORS, error.message) ? error.message as ErrorCode : "invalid_message";
        if (code === "invalid_message") counters.invalid++;
        // Lobby mistakes are recoverable; anything else ends this connection.
        if ((code === "not_host" || code === "not_ready" || code === "arena_unavailable") && room) send({ type: "error", code, message: ERRORS[code] });
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
    const t = now();
    for (const [code, room] of rooms) {
      room.tick(t);
      if (room.closed) rooms.delete(code);
    }
  };
  // Timers round fractional milliseconds: accumulate elapsed time and run whole 60 Hz ticks.
  const clock = new FixedClock(performance.now());
  const timer = options.automaticTicks === false ? null : setInterval(() => {
    for (let remaining = clock.take(performance.now()); remaining > 0; remaining--) tick();
  }, 4);
  timer?.unref();

  return {
    server, rooms, tick, counters,
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
