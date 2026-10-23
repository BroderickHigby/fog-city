// The browser's copy of a relay match: the confirmed timeline, stepped from the relay's ordered
// frames with the full deterministic sim, plus a cheap prediction of the local player's own body.
//
// The full Bot Sweep step costs a few milliseconds (121 robots, combat, gameplay reducers), so
// the client never re-simulates the whole match to predict. It replays only its unacknowledged
// controls with core movement (no systems, no robots) on top of the confirmed state, and uses
// that for its own body; everything else is drawn from the confirmed state. A hash from the
// relay once a second detects divergence; only then is a snapshot requested.
import { hashState, NEUTRAL_INPUT, step, type InputFrame, type SimEvent, type SimInput, type SimState, type World } from "../sim/index.ts";
import { SIM_VERSION } from "../sim/contract.ts";
import { arenaWorld } from "../sim/modes/arena.ts";
import { botSweepArena, botSweepView, stepBotSweep } from "../sim/modes/botsweep.ts";
import { MAX_PREDICTION_TICKS, type Frame, type Snapshot } from "./protocol.ts";

/** Frames queued beyond this are consumed at once (the client fell behind the relay). */
const JITTER_FRAMES = 3;
/** Without a time budget, at most this many confirmed steps per call. */
const MAX_STEPS_PER_FRAME = 6;
/** Controls sent but not yet acknowledged by the relay before sending pauses (1 s). */
const MAX_IN_FLIGHT = 60;
/** Controls kept for prediction while the confirmed state catches up. */
const MAX_PENDING = 240;
/** Further behind than this (10 s), a snapshot is cheaper than replaying every frame. */
const MAX_QUEUED_FRAMES = 600;

export interface MatchStats { frames: number; mismatches: number; snapshots: number; predicted: number }

export class MatchTimeline {
  readonly world: World;
  readonly playerId: string;
  readonly matchId: string;
  /** The last state built from relay frames (or a snapshot): authoritative. */
  confirmed: SimState;
  /** The confirmed state before the most recent step, for interpolation. */
  previous: SimState;
  recovering = false;
  readonly stats: MatchStats = { frames: 0, mismatches: 0, snapshots: 0, predicted: 0 };
  private queue: Frame[] = [];
  private pending: Array<{ seq: number; input: SimInput }> = [];
  private seq: number;
  private consumedAck: number;
  /** The newest ack received (frames may wait in the queue before they are stepped). */
  private receivedAck: number;
  private arena: World;
  private waited = 0;
  private predictedCache: { key: SimState; pending: number; state: SimState } | null = null;
  private readonly requestSnapshot: (tick: number, reason: "mismatch" | "behind") => void;

  constructor(world: World, playerId: string, matchId: string, snapshot: Snapshot, requestSnapshot: (tick: number, reason: "mismatch" | "behind") => void) {
    this.world = world; this.playerId = playerId; this.matchId = matchId; this.requestSnapshot = requestSnapshot;
    if (!validSnapshot(snapshot)) throw new Error("invalid_snapshot");
    this.confirmed = snapshot.state; this.previous = snapshot.state;
    this.seq = snapshot.ack; this.consumedAck = snapshot.ack; this.receivedAck = snapshot.ack;
    this.arena = arenaFor(world, snapshot.state);
  }

  get tick(): number { return this.confirmed.tick; }
  get queued(): number { return this.queue.length; }
  get unacknowledged(): number { return this.pending.length; }

  /** Replace the timeline from a relay snapshot (rejoin or mismatch recovery). */
  snapshot(snapshot: Snapshot): void {
    if (!validSnapshot(snapshot)) { this.recovering = false; this.recover("mismatch"); return; }
    this.confirmed = snapshot.state; this.previous = snapshot.state;
    this.queue = this.queue.filter((f) => f.tick > snapshot.state.tick);
    this.consumedAck = snapshot.ack;
    this.receivedAck = Math.max(this.receivedAck, snapshot.ack);
    this.pending = this.pending.filter((p) => p.seq > snapshot.ack);
    if (this.seq < snapshot.ack) this.seq = snapshot.ack;
    this.recovering = false;
    this.stats.snapshots++;
    this.arena = arenaFor(this.world, snapshot.state);
  }

  frame(frame: Frame): void {
    this.receivedAck = Math.max(this.receivedAck, frame.ack);
    if (this.recovering || frame.tick <= (this.queue.at(-1)?.tick ?? this.confirmed.tick)) return;
    this.queue.push(frame);
    if (this.queue.length > MAX_QUEUED_FRAMES) this.recover("behind");
  }

  /**
   * Record one local control for the relay; returns the sequence number to send, or null while a
   * second of controls is already in flight unacknowledged (the relay or the link has stalled).
   * Sending carries on while this client catches up or resynchronises: the relay's acks, not
   * the local stepping, say which controls it has applied.
   */
  sample(input: SimInput): number | null {
    if (this.seq - this.receivedAck >= MAX_IN_FLIGHT) return null;
    const seq = ++this.seq;
    this.pending.push({ seq, input: { ...input } });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    return seq;
  }

  /**
   * Consume queued relay frames for `ticks` elapsed ticks (more when the queue is long). With
   * `overBudget`, catching up continues until it returns true instead of stopping at a fixed
   * count, so a slow device still keeps pace. Returns the number of confirmed steps taken.
   */
  advance(ticks: number, overBudget?: () => boolean): number {
    if (this.recovering) {
      // Ask again if the snapshot has not come within ~2 s (the relay rate-limits these).
      this.waited += Math.max(0, ticks);
      if (this.waited >= 150) { this.waited = 0; this.requestSnapshot(this.confirmed.tick, this.recoveringFor); }
      return 0;
    }
    let want = Math.max(0, Math.floor(ticks));
    if (this.queue.length > JITTER_FRAMES) want = Math.max(want, this.queue.length - JITTER_FRAMES + 1);
    want = Math.min(want, overBudget ? this.queue.length : MAX_STEPS_PER_FRAME, this.queue.length);
    for (let i = 0; i < want; i++) {
      if (overBudget && i >= Math.min(1, want) && overBudget()) return i;
      const frame = this.queue.shift()!;
      if (frame.tick !== this.confirmed.tick + 1) { this.recover("behind"); return i; }
      const next = stepBotSweep(this.world, this.confirmed, frame.inputs, frame.events);
      this.stats.frames++;
      if (frame.hash && hashState(next) !== frame.hash) { this.stats.mismatches++; this.recover("mismatch"); return i; }
      this.previous = this.confirmed; this.confirmed = next;
      this.consumedAck = Math.max(this.consumedAck, frame.ack);
      this.pending = this.pending.filter((p) => p.seq > this.consumedAck);
    }
    return want;
  }

  /** The confirmed state with the local player's body moved by its unacknowledged controls. */
  predicted(): SimState {
    const confirmed = this.confirmed;
    const me = confirmed.players[this.playerId];
    const view = botSweepView(confirmed);
    // Far behind (a slow device catching up), a long replay would only guess: draw the confirmed body.
    if (!me || !this.pending.length || this.pending.length > MAX_PREDICTION_TICKS * 8 || view?.phase !== "active" || view.players[this.playerId]?.down) return confirmed;
    if (this.predictedCache?.key === confirmed && this.predictedCache.pending === this.pending.length) return this.predictedCache.state;
    // Core movement only: walls, buildings and the other players' confirmed bodies.
    let state: SimState = { ...confirmed, ext: {} };
    for (const p of this.pending) {
      const inputs: Record<string, SimInput> = {};
      for (const id of Object.keys(state.players)) inputs[id] = id === this.playerId ? p.input : NEUTRAL_INPUT;
      state = step(this.arena, state, inputs as InputFrame, [], []);
    }
    this.stats.predicted++;
    const body = state.players[this.playerId];
    const result = body ? { ...confirmed, players: { ...confirmed.players, [this.playerId]: body } } : confirmed;
    this.predictedCache = { key: confirmed, pending: this.pending.length, state: result };
    return result;
  }

  private recoveringFor: "mismatch" | "behind" = "mismatch";
  private recover(reason: "mismatch" | "behind"): void {
    if (this.recovering) return;
    this.recovering = true;
    this.recoveringFor = reason;
    this.waited = 0;
    this.queue = [];
    this.requestSnapshot(this.confirmed.tick, reason);
  }
}

function arenaFor(world: World, state: SimState): World {
  const arena = botSweepArena(state);
  return arena ? arenaWorld(world, arena) : world;
}

function validSnapshot(snapshot: Snapshot): boolean {
  const state = snapshot.state as SimState | undefined;
  return !!state && state.version === SIM_VERSION && Number.isSafeInteger(state.tick) && state.tick >= 0 && !!botSweepView(state) &&
    Number.isSafeInteger(snapshot.ack) && snapshot.ack >= 0 && hashState(state) === snapshot.hash;
}

export type { SimEvent };
