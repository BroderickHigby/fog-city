import { hashState, SIM_VERSION, step, type SimInput, type SimState, type World } from "../sim/index.ts";
import { MAX_PREDICTION_TICKS, NET_VERSION, validInput, type ServerMessage, type Snapshot } from "./protocol.ts";

/** Bounded client prediction; every correction replays only unacknowledged local controls. */
export class Prediction {
  playerId = "";
  confirmed: SimState | null = null;
  state: SimState | null = null;
  players: Record<string, string> = {};
  pending: Array<{ seq: number; input: SimInput }> = [];
  recovering = false;
  corrections = 0;
  private seq = 0;
  private readonly world: World;
  private readonly requestSnapshot: () => void;

  constructor(world: World, requestSnapshot: () => void) {
    this.world = world;
    this.requestSnapshot = requestSnapshot;
  }

  predict(input: SimInput): { seq: number; input: SimInput } | null {
    if (!validInput(input)) throw new Error("invalid_input");
    if (!this.confirmed || !this.confirmed.players[this.playerId] || this.recovering || this.pending.length >= MAX_PREDICTION_TICKS) return null;
    const next = { seq: ++this.seq, input: { ...input } };
    this.pending.push(next);
    this.replay();
    return next;
  }

  receive(message: Exclude<ServerMessage, { type: "error" }>): void {
    if (message.type === "welcome") {
      if (message.version !== NET_VERSION || message.simVersion !== SIM_VERSION) throw new Error("version_mismatch");
      this.playerId = message.playerId;
      this.seq = message.ack[this.playerId] ?? 0;
      this.pending = [];
      this.snapshot(message);
      return;
    }
    if (message.type === "snapshot") {
      this.snapshot(message);
      return;
    }
    if (!this.confirmed || this.recovering) return;
    if (message.tick <= this.confirmed.tick) return;
    if (message.tick !== this.confirmed.tick + 1) { this.recover(); return; }
    const next = step(this.world, this.confirmed, message.inputs, message.events);
    if (message.hash && hashState(next) !== message.hash) { this.recover(); return; }
    this.confirmed = next;
    this.players = { ...message.players };
    this.pending = this.pending.filter((p) => p.seq > (message.ack[this.playerId] ?? 0));
    this.replay();
  }

  private snapshot(snapshot: Snapshot): void {
    if (snapshot.state.version !== SIM_VERSION || !Number.isSafeInteger(snapshot.state.tick) || snapshot.state.tick < 0 || hashState(snapshot.state) !== snapshot.hash) {
      this.recover();
      return;
    }
    if (this.confirmed && snapshot.state.tick < this.confirmed.tick) return;
    this.confirmed = snapshot.state;
    this.players = { ...snapshot.players };
    this.pending = this.pending.filter((p) => p.seq > (snapshot.ack[this.playerId] ?? 0));
    this.recovering = false;
    this.corrections++;
    this.replay();
  }

  private recover(): void {
    if (!this.recovering) {
      this.recovering = true;
      this.requestSnapshot();
    }
  }

  private replay(): void {
    let state = this.confirmed;
    if (!state) return;
    for (const p of this.pending) state = step(this.world, state, { [this.playerId]: p.input });
    this.state = state;
  }
}
