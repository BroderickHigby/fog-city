import { describe, expect, it } from "vitest";
import { Room, type Peer } from "../../server/net/room.ts";
import { worldLoader } from "../../server/net/world.ts";
import { MAX_PREDICTION_TICKS, type ServerMessage } from "../../src/net/protocol.ts";
import { Prediction } from "../../src/net/prediction.ts";
import { hashState, type SimInput } from "../../src/sim/index.ts";
import { ROOT } from "../helpers.ts";

describe("authoritative rollback with delayed inputs", () => {
  it("converges two clients through 2 simulated minutes of 100ms jitter, divergence and corrupt snapshots", async () => {
    const bundle = await worldLoader(`${ROOT}/public`)("dev");
    const room = new Room("ABCDEFGHIJ", bundle, 0, 77);
    let tick = 0, seed = 318, resyncs = 0;
    const random = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % 7; };
    type Delivery = { at: number; run(): void };
    const down: Delivery[][] = [[], []], up: Delivery[][] = [[], []];
    const lastDown = [0, 0], lastUp = [0, 0];
    const clients: Prediction[] = [];
    const ids: string[] = [];
    const schedule = (queue: Delivery[], last: number[], i: number, run: () => void): void => {
      const at = Math.max(last[i]!, tick + random());
      last[i] = at;
      queue.push({ at, run });
    };
    for (let i = 0; i < 2; i++) {
      const client = new Prediction(bundle.world, () => {
        resyncs++;
        const snapshot = { type: "snapshot" as const, ...structuredClone(room.snapshot()) };
        schedule(down[i]!, lastDown, i, () => client.receive(snapshot));
      });
      clients.push(client);
      const peer: Peer = { close() { throw new Error("unexpected close"); }, send(message: ServerMessage) {
        if (message.type === "error") throw new Error(message.message);
        const copy = structuredClone(message);
        if (message.type === "welcome") client.receive(copy as Exclude<ServerMessage, { type: "error" }>);
        else schedule(down[i]!, lastDown, i, () => client.receive(copy as Exclude<ServerMessage, { type: "error" }>));
      } };
      ids.push(room.join(peer, 0));
    }
    const deliver = (queues: Delivery[][]): void => {
      for (const queue of queues) while (queue[0] && queue[0].at <= tick) queue.shift()!.run();
    };
    room.tick(0);
    for (tick = 1; tick <= 7200; tick++) {
      deliver(down);
      for (let i = 0; i < 2; i++) {
        const input: SimInput = { throttle: tick % 180 < 90 ? 1 : -0.3, steer: (tick + i * 80) % 120 < 60 ? 0.4 : -0.4, brake: tick % 200 > 180 ? 1 : 0, actions: 0 };
        const accepted = clients[i]!.predict(input);
        if (accepted) schedule(up[i]!, lastUp, i, () => room.input(ids[i]!, accepted.seq, accepted.input));
        expect(clients[i]!.pending.length).toBeLessThanOrEqual(MAX_PREDICTION_TICKS);
      }
      deliver(up);
      room.tick(tick * 1000 / 60);
      if (tick === 1800) clients[0]!.confirmed = { ...clients[0]!.confirmed!, rng: [1, 2, 3, 4] };
      if (tick === 3600) clients[1]!.receive({ type: "snapshot", ...structuredClone(room.snapshot()), hash: "bad" });
    }
    for (; tick <= 7220; tick++) { deliver(up); room.tick(tick * 1000 / 60); deliver(down); }
    tick += 10;
    deliver(down);
    expect(resyncs).toBeGreaterThanOrEqual(2);
    for (const client of clients) {
      expect(client.pending).toHaveLength(0);
      expect(client.recovering).toBe(false);
      expect(hashState(client.confirmed)).toBe(hashState(room.state));
      expect(hashState(client.state)).toBe(hashState(room.state));
    }
    expect(room.history).toHaveLength(7200);
  }, 60_000);
});
