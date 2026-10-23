import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { MAX_MESSAGE_BYTES, parseClientMessage, type ServerMessage, type WorldName } from "../../src/net/protocol.ts";
import { Room } from "./room.ts";
import { FixedClock } from "./clock.ts";
import type { WorldBundle } from "./world.ts";

export interface RelayOptions {
  loadWorld(name: WorldName): Promise<WorldBundle>;
  now?: () => number;
  automaticTicks?: boolean;
  maxRooms?: number;
  allowedOrigins?: readonly string[];
}

const errors: Record<string, string> = {
  invalid_message: "Unsupported message or game version.",
  room_missing: "Room not found. Check the code or create a new room.",
  room_expired: "This room code has expired. Create a new room.",
  room_full: "This room already has four players.",
  world_mismatch: "Your game world differs from this server. Refresh to the same build.",
  server_full: "The server is full. Try again later.",
  already_joined: "Leave the current room before joining another.",
  not_joined: "Join a room first.",
  input_sequence: "Input sequence was invalid. Rejoin the room.",
  input_backlog: "Too many queued inputs. Rejoin the room.",
  rate_limit: "Too many messages. Rejoin after a moment.",
  slow_client: "Your connection fell behind. Rejoin the room.",
  world_unavailable: "This world is not available on the server.",
};
const loopback = (host: string | undefined): boolean => host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";

export function createRelay(options: RelayOptions) {
  const now = options.now ?? Date.now;
  const rooms = new Map<string, Room>();
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: sockets.clients.size }));
    } else { res.writeHead(404); res.end(); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  let creating = 0;
  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return loopback(req.socket.remoteAddress);
    if (options.allowedOrigins?.includes(origin)) return true;
    try {
      const parsed = new URL(origin);
      return loopback(req.socket.remoteAddress) && (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
    } catch { return false; }
  };
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/relay" || !originAllowed(req)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    if (sockets.clients.size >= 64) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
  });
  sockets.on("connection", (socket) => {
    let room: Room | null = null;
    let playerId = "";
    let windowStart = now(), count = 0, queued = 0;
    let chain = Promise.resolve();
    let lastResync = -Infinity;
    let alive = true;
    const deadline = setTimeout(() => { if (!room) socket.close(1008, "join_timeout"); }, 10_000);
    deadline.unref();
    const send = (message: ServerMessage): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 1_048_576) { socket.close(1008, "slow_client"); return; }
      socket.send(JSON.stringify(message));
    };
    const fail = (code: string): void => {
      const safeCode = Object.hasOwn(errors, code) ? code : "world_unavailable";
      send({ type: "error", code: safeCode, message: errors[safeCode]! });
      socket.close(1008, safeCode);
    };
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, 30_000);
    heartbeat.unref();
    socket.on("pong", () => { alive = true; });
    socket.on("message", (bytes, binary) => {
      if (binary) { fail("invalid_message"); return; }
      const time = now();
      if (time - windowStart >= 1000) { windowStart = time; count = 0; }
      count++; queued++;
      if (count > 120 || queued > 16) { queued--; fail("rate_limit"); return; }
      chain = chain.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const message = parseClientMessage(bytes.toString());
        if (message.type === "create" || message.type === "join") {
          if (room) throw new Error("already_joined");
          if (message.type === "create") {
            if (rooms.size + creating >= (options.maxRooms ?? 8)) throw new Error("server_full");
            creating++;
            try {
              const bundle = await options.loadWorld(message.world);
              if (socket.readyState !== WebSocket.OPEN) return;
              if (bundle.fingerprint !== message.fingerprint) throw new Error("world_mismatch");
              let code: string;
              const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
              do { code = Array.from(randomBytes(10), (n) => alphabet[n & 31]!).join(""); } while (rooms.has(code));
              room = new Room(code, bundle, now(), randomBytes(4).readUInt32BE());
              rooms.set(code, room);
            } finally { creating--; }
          } else {
            room = rooms.get(message.code!) ?? null;
            if (!room) throw new Error("room_missing");
            if (room.bundle.name !== message.world || room.bundle.fingerprint !== message.fingerprint) { room = null; throw new Error("world_mismatch"); }
          }
          playerId = room.join({ send, close: fail }, now());
          clearTimeout(deadline);
        } else {
          if (!room || !playerId) throw new Error("not_joined");
          if (message.type === "input") room.input(playerId, message.seq, message.input);
          else if (now() - lastResync >= 1000) { lastResync = now(); send({ type: "snapshot", ...room.snapshot() }); }
        }
      }).catch((error: unknown) => fail(error instanceof Error ? error.message : "invalid_message")).finally(() => { queued--; });
    });
    socket.on("error", () => { /* ws reports malformed/oversized frames here, then closes. */ });
    socket.on("close", () => { clearTimeout(deadline); clearInterval(heartbeat); room?.leave(playerId, now()); });
  });
  const tick = (): void => {
    const time = now();
    for (const [code, room] of rooms) {
      if (!room.members.size && (time >= room.expiresAt || time - room.lastActive > 300_000)) { rooms.delete(code); continue; }
      if (room.members.size || Object.keys(room.state.players).length) room.tick(time);
    }
  };
  // Timers round fractional milliseconds. Accumulate elapsed time instead of running 62.5Hz.
  const clock = new FixedClock(performance.now());
  const timer = options.automaticTicks === false ? null : setInterval(() => {
    for (let remaining = clock.take(performance.now()); remaining > 0; remaining--) tick();
  }, 8);
  timer?.unref();
  return {
    server, rooms, tick,
    async listen(port = 8787, host = "127.0.0.1"): Promise<number> {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("invalid_address");
      return address.port;
    },
    async close(): Promise<void> {
      if (timer) clearInterval(timer);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}
