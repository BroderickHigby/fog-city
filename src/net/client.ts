// One connection to the relay: lobby state, the seat token for rejoining, and the match timeline.
// The transport is a seam (src/net/transport.ts): a WebSocket in the game and the relay tests.
import { SIM_VERSION, type SimInput, type World } from "../sim/index.ts";
import { MatchTimeline } from "./match.ts";
import { webSocketTransport, type ConnectTransport, type RelayTransport } from "./transport.ts";
import { ERRORS, NET_VERSION, type ErrorCode, type Hello, type Member, type NetModeId, type NetworkCommand, type Results, type RoomList, type RoomPhase, type ServerMessage, type Visibility, type WorldName } from "./protocol.ts";

export type ConnectionStatus = "offline" | "connecting" | "connected" | "reconnecting" | "error";
export interface Seat { url: string; world: WorldName; code: string; token: string; playerId: string }

export interface ClientInfo {
  status: ConnectionStatus;
  message: string;
  code: string;
  playerId: string;
  phase: RoomPhase | "none";
  mode: NetModeId;
  visibility: Visibility;
  /** Bot teammates the host has asked for. */
  bots: number;
  members: Member[];
  matchId: string;
  /** Round-trip time from the last ping, ms; 0 before the first. */
  rttMs: number;
  /** Relay frames received but not yet stepped. */
  queued: number;
  recovering: boolean;
  results: Results | null;
}

export interface ClientOptions {
  url: string;
  world: World;
  worldName: WorldName;
  fingerprint: string;
  onChange(info: ClientInfo): void;
  /** A new seat (store it for a rejoin) or null (forget it). */
  onSeat(seat: Seat | null): void;
  onResults?(results: Results, playerId: string): void;
  /** Reconnect attempts after an unexpected drop, with backoff. */
  reconnectAttempts?: number;
  /** Defaults to a WebSocket. */
  transport?: ConnectTransport;
  now?: () => number;
}

const RECONNECTABLE = new Set<string>(["slow_client", "idle", "rate_limit"]);
const FORGET_SEAT = new Set<ErrorCode>(["room_missing", "room_expired", "seat_missing", "room_full", "room_started", "replaced", "version_mismatch", "world_mismatch", "world_unavailable"]);

export class RelayClient {
  readonly info: ClientInfo = { status: "offline", message: "", code: "", playerId: "", phase: "none", mode: "botSweep", visibility: "private", bots: 0, members: [], matchId: "", rttMs: 0, queued: 0, recovering: false, results: null };
  match: MatchTimeline | null = null;
  private socket: RelayTransport | null = null;
  private seat: Seat | null = null;
  private readonly options: ClientOptions;
  private actions = 0;
  private commandSequence = 0;
  /** A new connection needs its own snapshot/ack before it may reuse a retained match view. */
  private inputReady = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private leaving = false;
  private disposed = false;

  constructor(options: ClientOptions) { this.options = options; }

  get playerId(): string { return this.info.playerId; }
  isHost(): boolean { return this.info.members.some((m) => m.host && m.id === this.info.playerId); }
  active(): boolean { return this.info.status === "connecting" || this.info.status === "connected" || this.info.status === "reconnecting"; }

  create(): void { this.open({ action: "create" }); }
  /** Join the fullest public lobby for this world, or open a new public room. */
  quick(): void { this.open({ action: "quick" }); }
  join(code: string): void { this.open({ action: "join", code: code.trim().toUpperCase() }); }
  rejoin(seat: Seat): void { this.seat = seat; this.open({ action: "rejoin", code: seat.code, token: seat.token }); }

  ready(ready: boolean): void { this.send({ type: "ready", ready }); }
  setBots(count: number): void { this.send({ type: "bots", count }); }
  start(): void { this.send({ type: "start", mode: this.info.mode }); }
  setMode(mode: NetModeId): void { this.send({ type: "mode", mode }); }
  end(): void { this.send({ type: "end" }); }
  command(command: Omit<NetworkCommand, "sequence">): void { this.send({ type: "command", command: { ...command, sequence: ++this.commandSequence } }); }

  /** Give up the seat for good and close. */
  leave(): void {
    this.leaving = true;
    this.send({ type: "leave" });
    this.forget();
    this.shutdown("offline", "Left the room.");
  }

  dispose(): void { this.disposed = true; this.leaving = true; this.shutdown("offline", ""); }

  /** One local control tick (60 Hz); sent while a match runs. One-shot actions are never lost between ticks. */
  sample(input: SimInput): void {
    this.actions |= input.actions;
    const match = this.match;
    if (!match || !this.inputReady || this.info.phase !== "match" || !this.socket?.open) return;
    const control = { ...input, actions: this.actions };
    const seq = match.sample(control);
    if (seq === null) return;
    this.actions = 0;
    this.send({ type: "input", seq, input: control });
  }

  /** Step the confirmed match by elapsed ticks; returns the steps taken. */
  advance(ticks: number, overBudget?: () => boolean): number {
    const steps = this.match?.advance(ticks, overBudget) ?? 0;
    if (this.match) { this.info.queued = this.match.queued; this.info.recovering = this.match.recovering; }
    return steps;
  }

  private open(hello: Pick<Hello, "action" | "code" | "token">): void {
    if (this.socket || this.disposed) return;
    this.leaving = false;
    this.inputReady = false;
    this.set(this.info.code && hello.action === "rejoin" ? "reconnecting" : "connecting", hello.action === "rejoin" ? "Rejoining your room…" : "Connecting…");
    let socket: RelayTransport | null = null;
    const connect = this.options.transport ?? webSocketTransport;
    try {
      socket = connect(this.options.url, {
        onOpen: () => {
          const message: Hello = { type: "hello", net: NET_VERSION, sim: SIM_VERSION, world: this.options.worldName, fingerprint: this.options.fingerprint, action: hello.action };
          if (hello.code) message.code = hello.code;
          if (hello.token) message.token = hello.token;
          socket?.send(JSON.stringify(message));
        },
        onMessage: (text) => {
          if (this.socket !== socket) return;
          try { this.receive(JSON.parse(text) as ServerMessage); }
          catch { this.set("error", "The server sent incompatible game data."); socket?.close(); }
        },
        onClose: () => {
          if (this.socket !== socket) return;
          this.socket = null;
          this.stopPing();
          if (this.leaving || this.disposed) return;
          if (this.seat && this.attempts < (this.options.reconnectAttempts ?? 8) && (this.info.status !== "error" || RECONNECTABLE.has(this.lastError))) {
            const delay = Math.min(8000, 500 * 2 ** this.attempts++);
            this.set("reconnecting", "Connection lost. Reconnecting…");
            this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.seat) this.rejoin(this.seat); }, delay);
            return;
          }
          if (this.info.status !== "error") this.set("offline", "Disconnected.");
        },
      });
    } catch { this.set("error", "The multiplayer server address is invalid."); return; }
    this.socket = socket;
  }

  private lastError = "";
  private receive(message: ServerMessage): void {
    switch (message.type) {
      case "welcome": {
        if (message.net !== NET_VERSION || message.sim !== SIM_VERSION) { this.set("error", ERRORS.version_mismatch); this.socket?.close(); return; }
        this.attempts = 0; this.lastError = "";
        this.info.code = message.code; this.info.playerId = message.playerId;
        this.seat = { url: this.options.url, world: this.options.worldName, code: message.code, token: message.token, playerId: message.playerId };
        this.options.onSeat(this.seat);
        this.startPing();
        this.set("connected", "Connected");
        return;
      }
      case "room": {
        this.info.phase = message.phase; this.info.mode = message.mode; this.info.members = message.members;
        this.info.visibility = message.visibility; this.info.bots = message.bots;
        if (message.matchId !== this.info.matchId) { this.info.matchId = message.matchId; this.info.results = null; }
        if (message.phase === "lobby") { this.match = null; this.info.results = null; }
        this.emit();
        return;
      }
      case "snapshot": {
        if (this.match && this.match.matchId === message.matchId && (message.reason === "mismatch" || message.reason === "behind")) this.match.snapshot(message);
        else {
          this.match = new MatchTimeline(this.options.world, this.info.playerId, message.matchId, message, (tick, reason) => this.send({ type: "resync", tick, reason }));
          this.commandSequence = 0; this.actions = 0;
        }
        this.inputReady = true;
        this.info.matchId = message.matchId;
        this.emit();
        return;
      }
      case "frame": this.match?.frame(message); return;
      case "results": {
        this.info.results = { matchId: message.matchId, result: message.result, payouts: message.payouts };
        this.options.onResults?.(this.info.results, this.info.playerId);
        this.emit();
        return;
      }
      case "pong": this.info.rttMs = Math.max(0, (this.options.now ?? Date.now)() - message.t); this.emit(); return;
      case "error": {
        this.lastError = message.code;
        if (FORGET_SEAT.has(message.code)) this.forget();
        // Recoverable lobby errors keep the connection.
        if (message.code === "not_host" || message.code === "not_ready" || message.code === "arena_unavailable") { this.info.message = message.message; this.emit(); return; }
        this.set("error", message.message);
        return;
      }
    }
  }

  private forget(): void { this.seat = null; this.options.onSeat(null); }
  private send(value: unknown): void {
    if (!this.socket?.open) return;
    this.socket.send(JSON.stringify(value));
  }
  private startPing(): void {
    this.stopPing();
    const ping = (): void => this.send({ type: "ping", t: (this.options.now ?? Date.now)() });
    ping();
    this.pingTimer = setInterval(ping, 5000);
  }
  private stopPing(): void { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = null; }
  private shutdown(status: ConnectionStatus, message: string): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopPing();
    const socket = this.socket; this.socket = null;
    socket?.close();
    this.match = null;
    this.info.phase = "none"; this.info.members = []; this.info.code = ""; this.info.matchId = ""; this.info.results = null;
    this.set(status, message);
  }
  private set(status: ConnectionStatus, message: string): void { this.info.status = status; this.info.message = message; this.emit(); }
  private emit(): void {
    if (this.match) { this.info.queued = this.match.queued; this.info.recovering = this.match.recovering; }
    this.options.onChange({ ...this.info, members: [...this.info.members] });
  }
}

/** The relay's HTTP base for a WebSocket URL: wss://host/relay → https://host. */
export function relayHttpBase(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = parsed.pathname.replace(/\/relay\/?$/, "") || "/";
  parsed.search = ""; parsed.hash = "";
  return parsed.href.replace(/\/$/, "");
}

/** The public rooms of one world (GET /rooms). Never throws: an unreachable relay lists nothing. */
export async function listRooms(url: string, world: WorldName, fetcher: typeof fetch = fetch): Promise<RoomList | null> {
  try {
    const response = await fetcher(`${relayHttpBase(url)}/rooms?world=${encodeURIComponent(world)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json() as RoomList;
    return Array.isArray(body.rooms) && Number.isSafeInteger(body.online) ? body : null;
  } catch { return null; }
}
