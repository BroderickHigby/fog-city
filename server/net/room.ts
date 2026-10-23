import { createInitialState, hashState, NEUTRAL_INPUT, step, type SimEvent, type SimInput, type SimState } from "../../src/sim/index.ts";
import { MAX_PLAYERS, MAX_PREDICTION_TICKS, NAME_PARTS, NET_VERSION, ROOM_LIFETIME_MS, type Frame, type ServerMessage, type Snapshot } from "../../src/net/protocol.ts";
import { SIM_VERSION } from "../../src/sim/contract.ts";
import type { WorldBundle } from "./world.ts";

export interface Peer { send(message: ServerMessage): void; close(code: string): void }
interface Member { peer: Peer; queue: Array<{ seq: number; input: SimInput }>; seq: number; ack: number; name: string }

/** One server-owned 60 Hz timeline. The ring is a bounded replay of accepted inputs and events. */
export class Room {
  readonly code: string;
  readonly bundle: WorldBundle;
  readonly expiresAt: number;
  readonly members = new Map<string, Member>();
  readonly history: Frame[] = [];
  state: SimState;
  lastActive: number;
  private nextId = 1;
  private events: SimEvent[] = [];

  constructor(code: string, bundle: WorldBundle, now: number, seed: number) {
    this.code = code;
    this.bundle = bundle;
    this.expiresAt = now + ROOM_LIFETIME_MS;
    this.lastActive = now;
    this.state = createInitialState(bundle.world, seed, [], bundle.spawn);
  }

  join(peer: Peer, now: number): string {
    if (now >= this.expiresAt) throw new Error("room_expired");
    if (this.members.size >= MAX_PLAYERS) throw new Error("room_full");
    const id = `p${this.nextId++}`;
    const used = new Set([...this.members.values()].map((m) => m.name));
    const name = NAME_PARTS.find((n) => !used.has(n))!;
    this.members.set(id, { peer, queue: [], seq: 0, ack: 0, name });
    this.events.push({ tick: this.state.tick + 1, kind: "player.join", playerId: id, payload: this.bundle.spawn });
    this.lastActive = now;
    peer.send({ type: "welcome", version: NET_VERSION, simVersion: SIM_VERSION, world: this.bundle.name,
      fingerprint: this.bundle.fingerprint, code: this.code, playerId: id, expiresAt: this.expiresAt, ...this.snapshot() });
    return id;
  }

  leave(id: string, now: number): void {
    if (!this.members.delete(id)) return;
    this.events = this.events.filter((e) => !(e.kind === "player.join" && e.playerId === id));
    if (this.state.players[id]) this.events.push({ tick: this.state.tick + 1, kind: "player.leave", playerId: id });
    this.lastActive = now;
  }

  input(id: string, seq: number, input: SimInput): void {
    const member = this.members.get(id);
    if (!member) throw new Error("not_joined");
    if (seq !== member.seq + 1) throw new Error("input_sequence");
    if (member.queue.length >= MAX_PREDICTION_TICKS) throw new Error("input_backlog");
    member.seq = seq;
    member.queue.push({ seq, input: { ...input } });
  }

  snapshot(): Snapshot {
    return { state: this.state, hash: hashState(this.state), ack: this.acks(), players: this.names() };
  }

  tick(now: number): Frame {
    const inputs: Record<string, SimInput> = {};
    for (const [id, member] of this.members) {
      const next = member.queue.shift();
      if (next) member.ack = next.seq;
      // No repetition of one-shot actions or stale held controls, including hidden tabs.
      inputs[id] = next?.input ?? { ...NEUTRAL_INPUT };
    }
    const events = this.events;
    this.events = [];
    this.state = step(this.bundle.world, this.state, inputs, events);
    if (this.members.size) this.lastActive = now;
    const frame: Frame = { type: "frame", tick: this.state.tick, inputs, events, ack: this.acks(), players: this.names() };
    if (this.state.tick % 60 === 0) frame.hash = hashState(this.state);
    this.history.push(frame);
    if (this.history.length > 7200) this.history.shift();
    const snapshot = this.state.tick % 60 === 0 ? { type: "snapshot" as const, ...this.snapshot() } : null;
    for (const { peer } of this.members.values()) {
      peer.send(frame);
      if (snapshot) peer.send(snapshot);
    }
    return frame;
  }

  private acks(): Record<string, number> { return Object.fromEntries([...this.members].map(([id, m]) => [id, m.ack])); }
  private names(): Record<string, string> { return Object.fromEntries([...this.members].map(([id, m]) => [id, m.name])); }
}
