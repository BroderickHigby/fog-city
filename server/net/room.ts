// One private invitation room: a lobby, then one server-owned 60 Hz Bot Sweep timeline, then
// results. The relay runs the same deterministic sim as every browser; it orders inputs keyed by
// player id, records joins/leaves/decisions as SimEvents with their tick, and sends a full
// snapshot only to a client that joins mid-match, rejoins, or reports a hash mismatch.
import { createHash, randomBytes } from "node:crypto";
import { profileName, type Profile } from "../../src/net/identity.ts";
import { hashState, NEUTRAL_INPUT, type SimEvent, type SimInput, type SimState } from "../../src/sim/index.ts";
import { MAX_PLAYERS, MAX_PREDICTION_TICKS, NET_VERSION, type ErrorCode, type Frame, type Member, type NetModeId, type NetworkCommand, type RoomListing, type RoomPhase, type ServerMessage, type Visibility } from "../../src/net/protocol.ts";
import { SIM_VERSION } from "../../src/sim/contract.ts";
import { ArenaUnavailableError, botSweepView, createBotSweep, stepBotSweep } from "../../src/sim/modes/botsweep.ts";
import { MODE_END_EVENT } from "../../src/sim/modes/systems.ts";
import type { Spawn } from "../../src/sim/contract.ts";
import type { WorldBundle } from "./world.ts";

export interface Peer { send(message: ServerMessage): void; close(code: ErrorCode): void }

export interface RoomLimits {
  /** Hard lifetime of a room, whatever happens in it. */
  lifetimeMs: number;
  /** How long a disconnected seat is held for a rejoin before it is given up. */
  rejoinGraceMs: number;
  /** A connected player who sends no input during a match for this long is disconnected. */
  matchIdleMs: number;
  /** How long a finished room keeps its results for reloading players. */
  resultsMs: number;
  /** Minimum time between snapshots sent to one seat on mismatch reports. */
  resyncIntervalMs: number;
  /** Match length in ticks (Bot Sweep: at most 12 minutes). */
  matchTicks?: number;
}
export const DEFAULT_ROOM_LIMITS: RoomLimits = { lifetimeMs: 2 * 3600_000, rejoinGraceMs: 120_000, matchIdleMs: 45_000, resultsMs: 10 * 60_000, resyncIntervalMs: 2000 };

interface Seat {
  id: string; name: string; look: number; token: string; ready: boolean;
  /** SHA-256 of the device's guest token: the key for stats, never the token itself. */
  device: string;
  peer: Peer | null; disconnectedAt: number;
  queue: Array<{ seq: number; input: SimInput }>; seq: number; ack: number; lastInputAt: number;
  commandSequence: number; lastResyncAt: number;
}

export interface RoomStats { mismatches: number; behind: number; snapshots: number; droppedInputs: number; ticks: number }

export class Room {
  readonly code: string;
  readonly bundle: WorldBundle;
  readonly createdAt: number;
  readonly creatorIp: string;
  readonly stats: RoomStats = { mismatches: 0, behind: 0, snapshots: 0, droppedInputs: 0, ticks: 0 };
  phase: RoomPhase = "lobby";
  readonly visibility: Visibility;
  /** Bot teammates the host asked for; trimmed whenever people need the seats. */
  bots = 0;
  mode: NetModeId = "botSweep";
  matchId = "";
  state: SimState | null = null;
  closed = false;
  private readonly seats = new Map<string, Seat>();
  private readonly limits: RoomLimits;
  private readonly arenas: readonly Spawn[];
  private events: SimEvent[] = [];
  private finishedAt = 0;
  private arenaCursor: number;

  constructor(code: string, bundle: WorldBundle, now: number, creatorIp: string, arenas: readonly Spawn[], limits: RoomLimits = DEFAULT_ROOM_LIMITS, visibility: Visibility = "private") {
    this.visibility = visibility;
    this.code = code; this.bundle = bundle; this.createdAt = now; this.creatorIp = creatorIp; this.limits = limits; this.arenas = arenas;
    this.arenaCursor = randomBytes(1)[0]! % Math.max(1, arenas.length);
  }

  get expiresAt(): number { return this.createdAt + this.limits.lifetimeMs; }
  get hostId(): string { return [...this.seats.keys()].sort()[0] ?? ""; }
  get size(): number { return this.seats.size; }
  connectedCount(): number { let n = 0; for (const seat of this.seats.values()) if (seat.peer) n++; return n; }

  /** A new player in the lobby. Throws Error(ErrorCode). Returns the seat id. */
  join(peer: Peer, now: number, profile: Profile, device: string): string {
    if (this.closed || now >= this.expiresAt) throw new Error("room_expired");
    if (this.phase !== "lobby") throw new Error("room_started");
    if (this.seats.size >= MAX_PLAYERS) throw new Error("room_full");
    let id = "";
    for (let n = 1; n <= MAX_PLAYERS && !id; n++) if (!this.seats.has(`p${n}`)) id = `p${n}`;
    const seat: Seat = { id, ...this.identify(profile, device, id), token: randomBytes(16).toString("hex"), ready: false, peer, disconnectedAt: 0,
      queue: [], seq: 0, ack: 0, lastInputAt: now, commandSequence: 0, lastResyncAt: 0 };
    this.seats.set(id, seat);
    this.bots = Math.min(this.bots, MAX_PLAYERS - this.seats.size);
    this.welcome(seat);
    this.broadcastRoom();
    return id;
  }

  /** Reattach a seat by its secret token (after a reload or a dropped connection). */
  rejoin(peer: Peer, token: string, now: number, profile: Profile, device: string): string {
    if (this.closed || now >= this.expiresAt) throw new Error("room_expired");
    const seat = [...this.seats.values()].find((s) => s.token === token);
    if (!seat) throw new Error("seat_missing");
    if (seat.peer && seat.peer !== peer) seat.peer.close("replaced");
    Object.assign(seat, this.identify(profile, device, seat.id));
    seat.peer = peer; seat.disconnectedAt = 0; seat.lastInputAt = now; seat.queue = []; seat.seq = seat.ack;
    this.welcome(seat);
    if (this.phase === "match") this.sendSnapshot(seat, "rejoin", now);
    this.broadcastRoom();
    if (this.phase === "results") this.sendResults(seat);
    return seat.id;
  }

  /** The socket went away; the seat waits for a rejoin. */
  disconnect(id: string, peer: Peer, now: number): void {
    const seat = this.seats.get(id);
    if (!seat || seat.peer !== peer) return;
    seat.peer = null; seat.disconnectedAt = now; seat.queue = [];
    this.broadcastRoom();
  }

  /** The player chose to leave: the seat is given up for good. */
  leave(id: string): void {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.seats.delete(id);
    if (this.phase === "match" && this.state?.players[id]) this.events.push({ tick: this.state.tick + 1, kind: "player.leave", playerId: id });
    if (!this.seats.size) this.closed = true;
    else this.broadcastRoom();
  }

  ready(id: string, ready: boolean): void {
    const seat = this.seats.get(id);
    if (!seat || this.phase !== "lobby") return;
    seat.ready = ready;
    this.broadcastRoom();
  }

  /** Host only: how many bot teammates join the match. */
  setBots(id: string, count: number): void {
    if (id !== this.hostId) throw new Error("not_host");
    if (this.phase !== "lobby") return;
    this.bots = Math.max(0, Math.min(count, MAX_PLAYERS - this.seats.size));
    this.broadcastRoom();
  }

  /** Host only, in the lobby: the mode the room will play. */
  setMode(id: string, mode: NetModeId): void {
    if (id !== this.hostId) throw new Error("not_host");
    if (this.phase !== "lobby" || mode === this.mode) return;
    this.mode = mode;
    this.broadcastRoom();
  }

  /** Quick play: a public lobby with a free seat. */
  open(): boolean { return !this.closed && this.visibility === "public" && this.phase === "lobby" && this.seats.size < MAX_PLAYERS; }
  listing(): RoomListing { return { code: this.code, mode: this.mode, phase: this.phase, players: this.seats.size, bots: this.bots, max: MAX_PLAYERS, world: this.bundle.name }; }

  /** Host only: build the arena and start the match with every seat in the lobby. */
  start(id: string, mode: NetModeId, now: number): void {
    if (id !== this.hostId) throw new Error("not_host");
    if (this.phase !== "lobby") throw new Error("room_started");
    for (const seat of this.seats.values()) if (!seat.ready || !seat.peer) throw new Error("not_ready");
    const players = [...this.seats.keys()].sort();
    const matchId = `${this.code}-${randomBytes(3).toString("hex")}`;
    const seed = randomBytes(4).readUInt32BE() & 0x7fffffff;
    let state: SimState | null = null;
    for (let tries = 0; tries < this.arenas.length && !state; tries++) {
      const spawn = this.arenas[this.arenaCursor++ % this.arenas.length]!;
      try {
        state = createBotSweep(this.bundle.world, { id: matchId, mode, seed, players, spawn, bots: Math.min(this.bots, MAX_PLAYERS - players.length), ...(this.limits.matchTicks ? { durationTicks: this.limits.matchTicks } : {}) });
      } catch (error) { if (!(error instanceof ArenaUnavailableError)) throw error; }
    }
    if (!state) throw new Error("arena_unavailable");
    this.mode = mode; this.matchId = matchId; this.state = state; this.phase = "match"; this.events = [];
    for (const seat of this.seats.values()) { seat.queue = []; seat.seq = 0; seat.ack = 0; seat.lastInputAt = now; seat.commandSequence = 0; }
    this.broadcastRoom();
    for (const seat of this.seats.values()) this.sendSnapshot(seat, "start", now);
  }

  /** Host only: a recorded server decision ends the match now (results still pay out). */
  end(id: string): void {
    if (id !== this.hostId) throw new Error("not_host");
    if (this.phase !== "match" || !this.state) return;
    if (!this.events.some((e) => e.kind === MODE_END_EVENT)) this.events.push({ tick: this.state.tick + 1, kind: MODE_END_EVENT });
  }

  input(id: string, seq: number, input: SimInput, now: number): void {
    const seat = this.seats.get(id);
    if (!seat || this.phase !== "match") return;
    if (seq !== seat.seq + 1) throw new Error("input_sequence");
    seat.seq = seq; seat.lastInputAt = now;
    seat.queue.push({ seq, input });
    // A client running fast (or flushing a backlog) never grows the relay's queue: the oldest
    // controls are dropped and the ack tells the client which ones were applied.
    // A dropped control's one-shot actions (fire, enter/exit...) carry into the next one.
    while (seat.queue.length > MAX_PREDICTION_TICKS) {
      const dropped = seat.queue.shift()!, next = seat.queue[0]!;
      next.input = { ...next.input, actions: next.input.actions | dropped.input.actions };
      this.stats.droppedInputs++;
    }
  }

  command(id: string, command: NetworkCommand): void {
    const seat = this.seats.get(id);
    if (!seat || this.phase !== "match" || !this.state) return;
    if (command.sequence !== seat.commandSequence + 1) throw new Error("input_sequence");
    if (this.events.length >= 64) return;
    seat.commandSequence = command.sequence;
    this.events.push({ tick: this.state.tick + 1, kind: "gameplay.command", playerId: id, payload: { ...command } });
  }

  /**
   * A client's hash differed from the relay's (or it fell too far behind to replay): count it,
   * and send that client, only, a snapshot.
   */
  resync(id: string, reason: "mismatch" | "behind", now: number): void {
    const seat = this.seats.get(id);
    if (!seat || this.phase !== "match" || now - seat.lastResyncAt < this.limits.resyncIntervalMs) return;
    if (reason === "mismatch") this.stats.mismatches++; else this.stats.behind++;
    this.sendSnapshot(seat, reason, now);
  }

  /** One 60 Hz tick of housekeeping and, during a match, of the sim. */
  tick(now: number): void {
    if (this.closed) return;
    if (now >= this.expiresAt) { this.close("room_expired"); return; }
    for (const seat of [...this.seats.values()]) {
      if (!seat.peer && seat.disconnectedAt && now - seat.disconnectedAt >= this.limits.rejoinGraceMs) this.leave(seat.id);
      else if (seat.peer && this.phase === "match" && now - seat.lastInputAt >= this.limits.matchIdleMs) { const peer = seat.peer; this.disconnect(seat.id, peer, now); peer.close("idle"); }
    }
    if (this.closed) return;
    if (this.phase === "results" && now - this.finishedAt >= this.limits.resultsMs) { this.close("room_expired"); return; }
    if (this.phase !== "match" || !this.state) return;
    const inputs: Record<string, SimInput> = {};
    for (const id of [...this.seats.keys()].sort()) {
      const seat = this.seats.get(id)!;
      if (!this.state.players[id]) continue;
      const next = seat.queue.shift();
      if (next) seat.ack = next.seq;
      // No repeated one-shot actions or stale held controls while a player is away.
      inputs[id] = next?.input ?? { ...NEUTRAL_INPUT };
    }
    const tick = this.state.tick + 1;
    const events = this.events.filter((e) => e.tick === tick);
    this.events = this.events.filter((e) => e.tick > tick);
    this.state = stepBotSweep(this.bundle.world, this.state, inputs, events);
    this.stats.ticks++;
    const hash = this.state.tick % 60 === 0 ? hashState(this.state) : undefined;
    for (const seat of this.seats.values()) {
      if (!seat.peer) continue;
      const frame: Frame = { type: "frame", tick: this.state.tick, inputs, events, ack: seat.ack };
      if (hash) frame.hash = hash;
      seat.peer.send(frame);
    }
    const view = botSweepView(this.state);
    if (view?.phase === "finished") {
      this.phase = "results"; this.finishedAt = now;
      this.broadcastRoom();
      for (const seat of this.seats.values()) this.sendResults(seat);
    }
  }

  close(code: ErrorCode): void {
    if (this.closed) return;
    this.closed = true;
    for (const seat of this.seats.values()) seat.peer?.close(code);
    this.seats.clear();
  }

  members(): Member[] {
    const host = this.hostId;
    return [...this.seats.values()].sort((a, b) => a.id < b.id ? -1 : 1).map((s) => ({ id: s.id, name: s.name, look: s.look, ready: s.ready, connected: !!s.peer, host: s.id === host }));
  }

  /** The name others see: the profile's vetted name, numbered if someone in the room already has it. */
  private identify(profile: Profile, device: string, id: string): { name: string; look: number; device: string } {
    const base = profileName(profile.name[0], profile.name[1]) ?? "Guest";
    const taken = new Set([...this.seats.values()].filter((s) => s.id !== id).map((s) => s.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
    return { name, look: profile.look, device: createHash("sha256").update(device).digest("hex") };
  }

  private welcome(seat: Seat): void {
    seat.peer?.send({ type: "welcome", net: NET_VERSION, sim: SIM_VERSION, code: this.code, playerId: seat.id, token: seat.token, expiresAt: this.expiresAt });
  }
  private broadcastRoom(): void {
    const message: ServerMessage = { type: "room", phase: this.phase, mode: this.mode, members: this.members(), matchId: this.matchId, visibility: this.visibility, bots: this.bots };
    for (const seat of this.seats.values()) seat.peer?.send(message);
  }
  private sendSnapshot(seat: Seat, reason: "start" | "rejoin" | "mismatch" | "behind", now: number): void {
    if (!seat.peer || !this.state) return;
    if (reason === "mismatch" || reason === "behind") seat.lastResyncAt = now;
    this.stats.snapshots++;
    seat.peer.send({ type: "snapshot", matchId: this.matchId, reason, state: this.state, hash: hashState(this.state), ack: seat.ack });
  }
  private sendResults(seat: Seat): void {
    const view = this.state ? botSweepView(this.state) : null;
    if (!seat.peer || !view?.result) return;
    seat.peer.send({ type: "results", matchId: this.matchId, result: view.result, payouts: [...view.payouts] });
  }
}
