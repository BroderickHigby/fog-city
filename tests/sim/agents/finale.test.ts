import { describe, expect, it } from "vitest";
import {
  createFinaleState, finaleFootfallClear, stepFinale,
  type FinaleInput, type FinaleRoute, type FinaleState, type FinaleWaypoint,
} from "../../../src/sim/robots/finale.ts";
import { hashState } from "../../../src/sim/serialize.ts";

const point = { x: 0, z: 0 };
const foot: FinaleWaypoint = { id: "foot-a", phase: "patrol", ...point, footprint: { kind: "circle", radius: 1 }, windupTicks: 60, shedRobots: 0 };
const walker: FinaleRoute = { id: "walker", waypoints: [foot] };
const boss: FinaleRoute = {
  id: "boss",
  waypoints: ["entrance", "march", "pitch", "bridge", "reveal"].map((phase, n) => ({
    ...foot, id: `boss-${n}`, phase: phase as FinaleWaypoint["phase"], shedRobots: phase === "march" || phase === "bridge" ? 2 : 0,
  })),
};

function input(state: FinaleState, route: FinaleRoute, overrides: Partial<FinaleInput> = {}): FinaleInput {
  const tick = overrides.tick ?? state.tick + 1;
  return { tick, route, position: state.position, positionTick: tick, coverage: { tick, complete: true, bodies: [] }, ...overrides };
}

function land(state: FinaleState, route: FinaleRoute): FinaleState {
  let next = stepFinale(state, input(state, route)).state;
  if (!next.landing) next = stepFinale(next, input(next, route, { tick: next.tick + 60, positionTick: next.tick + 60, coverage: { tick: next.tick + 60, complete: true, bodies: [] } })).state;
  expect(next.landing).not.toBeNull();
  const ack = { requestId: next.landing!.id, tick: next.tick + 1, clear: true, ...point };
  return stepFinale(next, input(next, route, { landingAcks: [ack], effectAcks: next.pendingEffects.map(effect => ({ id: effect.id, tick: next.tick + 1 })) })).state;
}

describe("finale clearance and lifecycle", () => {
  it("does not land before the visible windup or fabricate impact from a timer", () => {
    let state = createFinaleState({ kind: "walker", route: walker, position: point });
    state = stepFinale(state, input(state, walker)).state;
    expect(state.status).toBe("evacuate");
    let result = stepFinale(state, input(state, walker, { tick: 60, positionTick: 60, coverage: { tick: 60, complete: true, bodies: [] } }));
    expect(result.intents.some(intent => intent.kind === "land-foot")).toBe(false);
    result = stepFinale(result.state, input(result.state, walker, { tick: 61, positionTick: 61, coverage: { tick: 61, complete: true, bodies: [] } }));
    expect(result.intents.some(intent => intent.kind === "land-foot")).toBe(true);
    const waiting = stepFinale(result.state, input(result.state, walker, { tick: 10000, positionTick: 10000, coverage: { tick: 10000, complete: true, bodies: [] } }));
    expect(waiting.state.waypointIndex).toBe(0);
    expect(waiting.intents.some(intent => intent.kind === "impact")).toBe(false);
  });

  it("requires current complete coverage and actual footprint plus each body's radius", () => {
    const body = { id: "dog", kind: "animal" as const, x: 4.5, z: 0, radius: 0.5 };
    expect(finaleFootfallClear("walker", foot, { tick: 1, complete: true, bodies: [body] }, 1)).toBe(false);
    expect(finaleFootfallClear("walker", foot, { tick: 1, complete: true, bodies: [{ ...body, x: 4.501 }] }, 1)).toBe(true);
    expect(finaleFootfallClear("walker", foot, { tick: 0, complete: true, bodies: [] }, 1)).toBe(false);
    expect(finaleFootfallClear("walker", foot, { tick: 1, complete: false, bodies: [] }, 1)).toBe(false);
    expect(finaleFootfallClear("elizabeth", foot, { tick: 1, complete: true, bodies: [{ ...body, x: 1.5 }] }, 1)).toBe(false);
    expect(finaleFootfallClear("elizabeth", foot, { tick: 1, complete: true, bodies: [{ ...body, x: 1.501 }] }, 1)).toBe(true);
  });

  it("checks polygon edges, vertices and interiors rather than a centre-point distance", () => {
    const polygon: FinaleWaypoint = { ...foot, footprint: { kind: "polygon", vertices: [[-5, -1], [5, -1], [5, 1], [-5, 1]] } };
    const body = { id: "person", kind: "person" as const, x: 5.2, z: 1.2, radius: 0.3 };
    expect(finaleFootfallClear("elizabeth", polygon, { tick: 1, complete: true, bodies: [body] }, 1)).toBe(false);
    expect(finaleFootfallClear("elizabeth", polygon, { tick: 1, complete: true, bodies: [{ ...body, x: 0, z: 0 }] }, 1)).toBe(false);
    expect(finaleFootfallClear("elizabeth", polygon, { tick: 1, complete: true, bodies: [{ ...body, x: 5.4 }] }, 1)).toBe(true);
  });

  it("cancels a pending landing when someone enters and rejects the old acknowledgement", () => {
    let state = createFinaleState({ kind: "walker", route: walker, position: point });
    state = stepFinale(state, input(state, walker)).state;
    state = stepFinale(state, input(state, walker, { tick: 61, positionTick: 61, coverage: { tick: 61, complete: true, bodies: [] } })).state;
    const old = state.landing!.id;
    const blocked = stepFinale(state, input(state, walker, { coverage: { tick: 62, complete: true, bodies: [{ id: "person", kind: "person", ...point, radius: 0.5 }] }, landingAcks: [{ requestId: old, tick: 62, clear: true, ...point }] }));
    expect(blocked.intents).toContainEqual({ kind: "cancel-landing", id: old });
    expect(blocked.intents.some(intent => intent.kind === "impact")).toBe(false);
    const retried = stepFinale(blocked.state, input(blocked.state, walker, { landingAcks: [{ requestId: old, tick: 63, clear: true, ...point }] }));
    expect(retried.state.landing!.id).not.toBe(old);
    expect(retried.intents.some(intent => intent.kind === "impact")).toBe(false);
  });

  it("requires measured travel and rejects an impossible pose jump", () => {
    const route: FinaleRoute = { id: "travel", waypoints: [{ ...foot, x: 20 }] };
    const state = createFinaleState({ kind: "walker", route, position: point });
    const impossible = stepFinale(state, input(state, route, { position: { x: 20, z: 0 } }));
    expect(impossible.state.position).toEqual(point);
    expect(impossible.intents).toContainEqual({ kind: "hold", reason: "missing-pose" });
    const move = stepFinale(state, input(state, route));
    expect(move.intents).toContainEqual({ kind: "move", target: { x: 20, z: 0 }, maxSpeedMps: 3 });
    const arrived = stepFinale(move.state, input(move.state, route, { tick: 401, positionTick: 401, position: { x: 20, z: 0 }, coverage: { tick: 401, complete: true, bodies: [] } }));
    expect(arrived.state.status).toBe("evacuate");
  });

  it("rejects conflicting landing observations independently of their order", () => {
    let state = createFinaleState({ kind: "walker", route: walker, position: point });
    state = stepFinale(state, input(state, walker)).state;
    state = stepFinale(state, input(state, walker, { tick: 61, positionTick: 61, coverage: { tick: 61, complete: true, bodies: [] } })).state;
    const a = { requestId: state.landing!.id, tick: 62, clear: true, ...point };
    const b = { ...a, clear: false };
    const left = stepFinale(state, input(state, walker, { landingAcks: [a, b] }));
    const right = stepFinale(state, input(state, walker, { landingAcks: [b, a] }));
    expect(left).toEqual(right);
    expect(left.state.status).toBe("landing");
  });

  it("requires the current exact landing pose even when a preceding receipt was clear", () => {
    let state = createFinaleState({ kind: "walker", route: walker, position: point });
    state = stepFinale(state, input(state, walker)).state;
    state = stepFinale(state, input(state, walker, { tick: 61, positionTick: 61, coverage: { tick: 61, complete: true, bodies: [] } })).state;
    const receipt = { requestId: state.landing!.id, tick: 62, clear: true, ...point };
    const shifted = stepFinale(state, input(state, walker, { tick: 63, positionTick: 63, position: { x: 0.09, z: 0 }, coverage: { tick: 63, complete: true, bodies: [] }, landingAcks: [receipt] }));
    expect(shifted.intents.some(intent => intent.kind === "impact")).toBe(false);
    const observed = stepFinale(state, input(state, walker, { tick: 63, positionTick: 63, coverage: { tick: 63, complete: true, bodies: [] }, landingAcks: [receipt] }));
    expect(observed.intents.some(intent => intent.kind === "impact")).toBe(true);
    const landed = stepFinale(state, input(state, walker, { tick: 62, positionTick: 62, landingAcks: [{ ...receipt, tick: 61 }] }));
    expect(landed.intents.some(intent => intent.kind === "impact")).toBe(false);
  });

  it("blocks footfalls for seeded people and animals across the full Walker margin", () => {
    let word = 17;
    const random = (): number => { word = (Math.imul(word, 1664525) + 1013904223) >>> 0; return word / 4294967296; };
    for (let n = 0; n < 200; n++) {
      const angle = random() * Math.PI * 2;
      const radius = 0.2 + random();
      const distance = 1 + 3 + radius - 0.001 - random() * 3;
      const body = { id: `body-${n}`, kind: n % 2 ? "animal" as const : "person" as const, x: Math.cos(angle) * distance, z: Math.sin(angle) * distance, radius };
      expect(finaleFootfallClear("walker", foot, { tick: 1, complete: true, bodies: [body] }, 1)).toBe(false);
    }
  });

  it("deduplicates rust and ignores conflicting observations without order dependence", () => {
    const state = createFinaleState({ kind: "walker", route: walker, position: point });
    const hit = { sourceId: "water:1", sequence: 1, weakPointId: "front-left", rust: 0.4 };
    const once = stepFinale(state, input(state, walker, { rustHits: [hit, hit] })).state;
    const twice = stepFinale(once, input(once, walker, { rustHits: [hit] })).state;
    expect(twice.weakPoints[0]!.rust).toBe(0.4);
    const conflicting = { ...hit, rust: 0.7 };
    expect(stepFinale(state, input(state, walker, { rustHits: [hit, conflicting] })).state.weakPoints[0]!.rust).toBe(0);
  });

  it("keeps all five boss phases gated by actual landings, weak points and pitch completion", () => {
    let state = createFinaleState({ kind: "elizabeth", route: boss, position: point, absorbedRobotIds: ["r2", "r1"] });
    state = land(state, boss); // entrance
    state = stepFinale(state, input(state, boss)).state;
    expect(state.phase).toBe("march");
    state = stepFinale(state, input(state, boss, { rustHits: [
      { sourceId: "water", sequence: 1, weakPointId: "left-ankle", rust: 0.6 },
      { sourceId: "water", sequence: 2, weakPointId: "right-ankle", rust: 0.6 },
    ] })).state;
    state = land(state, boss); // march
    expect(state.pendingEffects.some(effect => effect.kind === "shed-robots")).toBe(true);
    state = land(state, boss); // pitch
    const held = stepFinale(state, input(state, boss));
    expect(held.state.phase).toBe("pitch");
    expect(held.intents).toContainEqual({ kind: "hold", reason: "phase-gate" });
    state = stepFinale(state, input(state, boss, { pitchResolved: true })).state;
    expect(state.phase).toBe("bridge");
    state = stepFinale(state, input(state, boss, { rustHits: [
      { sourceId: "water", sequence: 3, weakPointId: "left-knee", rust: 0.8 },
      { sourceId: "water", sequence: 4, weakPointId: "right-knee", rust: 0.8 },
    ] })).state;
    state = land(state, boss); // bridge
    state = land(state, boss); // reveal
    expect(state.status).toBe("restoring");
    const restore = stepFinale(state, input(state, boss, { effectAcks: state.pendingEffects.map(effect => ({ id: effect.id, tick: state.tick + 1 })) }));
    expect(restore.intents).toContainEqual({ kind: "restore-robots", id: "boss:restore", robotIds: ["r1", "r2"] });
    const waiting = stepFinale(restore.state, input(restore.state, boss));
    expect(waiting.state.status).toBe("restoring");
    const done = stepFinale(waiting.state, input(waiting.state, boss, { effectAcks: [{ id: "boss:restore", tick: waiting.state.tick + 1 }] }));
    expect(done.state.status).toBe("complete");
    expect(done.intents).toContainEqual({ kind: "finale-complete", id: "boss:complete" });
    const again = stepFinale(done.state, input(done.state, boss, { effectAcks: [{ id: "boss:complete", tick: done.state.tick + 1 }] }));
    expect(again.intents.some(intent => intent.kind === "restore-robots" || intent.kind === "finale-complete")).toBe(false);
  });

  it("freezes the input snapshot and replays deterministically with bounded effects", () => {
    function replay(): string[] {
      let state = createFinaleState({ kind: "walker", route: walker, position: point });
      const hashes: string[] = [];
      for (let n = 0; n < 20; n++) {
        const before = JSON.stringify(state);
        const frozen = Object.freeze(state);
        const next = land(frozen, walker);
        expect(JSON.stringify(state)).toBe(before);
        expect(next.pendingEffects.length).toBeLessThanOrEqual(16);
        hashes.push(hashState(next));
        state = next;
      }
      return hashes;
    }
    expect(replay()).toEqual(replay());
  });

  it("rejects invalid routes, route replacement and invalid numeric observations", () => {
    expect(() => createFinaleState({ kind: "elizabeth", route: { ...boss, waypoints: [boss.waypoints[1]!] }, position: point })).toThrow();
    expect(() => createFinaleState({ kind: "walker", route: { ...walker, waypoints: [{ ...foot, footprint: { kind: "polygon", vertices: [[0, 0], [1, 0], [0, 0]] } }] }, position: point })).toThrow();
    const state = createFinaleState({ kind: "walker", route: walker, position: point });
    expect(() => stepFinale(state, input(state, { ...walker, waypoints: [{ ...foot, x: 1 }] }))).toThrow("route changed");
    expect(() => stepFinale(state, input(state, walker, { position: { x: NaN, z: 0 } }))).toThrow();
    expect(() => stepFinale(state, input(state, walker, { rustHits: [{ sourceId: "x", sequence: 1, weakPointId: "front-left", rust: Infinity }] }))).toThrow();
  });
});
