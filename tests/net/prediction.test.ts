import { describe, expect, it } from "vitest";
import { Room, type Peer } from "../../server/net/room.ts";
import { worldLoader } from "../../server/net/world.ts";
import { MAX_PREDICTION_TICKS, type ServerMessage } from "../../src/net/protocol.ts";
import { Prediction } from "../../src/net/prediction.ts";
import { hashState, type SimInput } from "../../src/sim/index.ts";
import { ROOT } from "../helpers.ts";

const stressPlayers = process.env.NET_STRESS === "nightly" ? 4 : 2;
const stressTicks = process.env.NET_STRESS === "nightly" ? 36_000 : 7_200;

describe("authoritative rollback with delayed inputs", () => {
  it("starts a new room timeline when a client instance reconnects", async () => {
    const bundle = await worldLoader(`${ROOT}/public`)("dev");
    const client = new Prediction(bundle.world, () => {});
    const peer: Peer = {
      close() {},
      send(message) {
        if (message.type === "error") throw new Error(message.message);
        client.receive(structuredClone(message));
      },
    };
    const oldRoom = new Room("ABCDEFGHIJ", bundle, 0, 11);
    const oldId = oldRoom.join(peer, 0);
    for (let tick = 0; tick < 120; tick++) oldRoom.tick(tick * 1000 / 60);
    expect(client.confirmed?.tick).toBe(120);
    client.predict({ throttle: 1, steer: 0, brake: 0, actions: 0 });
    oldRoom.leave(oldId, 2000);

    const newRoom = new Room("KLMNOPQRST", bundle, 2000, 22);
    newRoom.join(peer, 2000);
    newRoom.tick(2000);
    expect(client.confirmed?.seed).toBe(22);
    expect(client.confirmed?.tick).toBe(1);
    expect(hashState(client.state)).toBe(hashState(newRoom.state));
    expect(client.pending).toHaveLength(0);
    expect(client.recovering).toBe(false);
    expect(client.predict({ throttle: 0, steer: 0, brake: 0, actions: 0 })?.seq).toBe(1);
  });

  it(`converges ${stressPlayers} clients through ${stressTicks / 3600} simulated minutes of 100ms jitter, divergence and corrupt snapshots`, async () => {
    const bundle = await worldLoader(`${ROOT}/public`)("dev");
    const room = new Room("ABCDEFGHIJ", bundle, 0, 77);
    let tick = 0, seed = 318;
    const resyncs = Array<number>(stressPlayers).fill(0);
    let divergenceInjected = false, corruptSnapshotInjected = false;
    const random = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % 7; };
    type Delivery = { at: number; run(): void };
    const down: Delivery[][] = Array.from({ length: stressPlayers }, () => []);
    const up: Delivery[][] = Array.from({ length: stressPlayers }, () => []);
    const lastDown = Array<number>(stressPlayers).fill(0), lastUp = Array<number>(stressPlayers).fill(0);
    const clients: Prediction[] = [];
    const ids: string[] = [];
    const schedule = (queue: Delivery[], last: number[], i: number, run: () => void): void => {
      const at = Math.max(last[i]!, tick + random());
      last[i] = at;
      queue.push({ at, run });
    };
    for (let i = 0; i < stressPlayers; i++) {
      const client = new Prediction(bundle.world, () => {
        resyncs[i] = resyncs[i]! + 1;
        const snapshot = { type: "snapshot" as const, ...structuredClone(room.snapshot()) };
        schedule(down[i]!, lastDown, i, () => client.receive(snapshot));
      });
      clients.push(client);
      const peer: Peer = { close() { throw new Error("unexpected close"); }, send(message: ServerMessage) {
        if (message.type === "error") throw new Error(message.message);
        const copy = structuredClone(message);
        if (message.type === "welcome") client.receive(copy as Exclude<ServerMessage, { type: "error" }>);
        else schedule(down[i]!, lastDown, i, () => {
          // Inject at delivery, before a hash-bearing contiguous frame. Injecting by
          // simulation tick can be silently repaired by an already queued valid snapshot.
          if (i === 0 && copy.type === "frame" && copy.tick >= 1800 && copy.hash &&
              !divergenceInjected && !client.recovering && client.confirmed?.tick === copy.tick - 1) {
            client.confirmed = { ...client.confirmed, rng: [1, 2, 3, 4] };
            divergenceInjected = true;
          }
          if (i === 1 && copy.type === "snapshot" && copy.state.tick >= 3600 &&
              !corruptSnapshotInjected && !client.recovering) {
            copy.hash = "bad";
            corruptSnapshotInjected = true;
          }
          client.receive(copy as Exclude<ServerMessage, { type: "error" }>);
        });
      } };
      ids.push(room.join(peer, 0));
    }
    const deliver = (queues: Delivery[][]): void => {
      for (const queue of queues) while (queue[0] && queue[0].at <= tick) queue.shift()!.run();
    };
    room.tick(0);
    for (tick = 1; tick <= stressTicks; tick++) {
      deliver(down);
      for (let i = 0; i < stressPlayers; i++) {
        const input: SimInput = { throttle: tick % 180 < 90 ? 1 : -0.3, steer: (tick + i * 80) % 120 < 60 ? 0.4 : -0.4, brake: tick % 200 > 180 ? 1 : 0, actions: 0 };
        const accepted = clients[i]!.predict(input);
        if (accepted) schedule(up[i]!, lastUp, i, () => room.input(ids[i]!, accepted.seq, accepted.input));
        expect(clients[i]!.pending.length).toBeLessThanOrEqual(MAX_PREDICTION_TICKS);
      }
      deliver(up);
      room.tick(tick * 1000 / 60);
      // Let the runner enforce its timeout during the longer nightly simulation.
      if (tick % 600 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (; tick <= stressTicks + 20; tick++) { deliver(up); room.tick(tick * 1000 / 60); deliver(down); }
    tick += 10;
    deliver(down);
    expect(divergenceInjected).toBe(true);
    expect(corruptSnapshotInjected).toBe(true);
    expect(resyncs[0]).toBeGreaterThanOrEqual(1);
    expect(resyncs[1]).toBeGreaterThanOrEqual(1);
    for (const client of clients) {
      expect(client.pending).toHaveLength(0);
      expect(client.recovering).toBe(false);
      expect(hashState(client.confirmed)).toBe(hashState(room.state));
      expect(hashState(client.state)).toBe(hashState(room.state));
    }
    expect(room.history).toHaveLength(7200);
  }, stressPlayers === 4 ? 600_000 : 60_000);
});
