// Runtime-actor motion on stacked structural surfaces (src/sim/motion.ts): admission and the
// accepted step test buildings and other bodies at the actor's own vertical band, as a player on
// foot does (foot.ts), so a body in a tunnel bore, on a deck or on the street under it is held by
// what stands at its height and never by the hill above or a body on another level.
import { describe, expect, it } from "vitest";
import { applyMotionBodies, createInitialState, prepareMotionBodies, surfaceHeight, type AgentMotionProposal, type SimState } from "../../src/sim/index.ts";
import { overpassY, surfaceWorld } from "./fixtures.ts";

describe("runtime walkers on decks, bores and stacked levels", () => {
  const world = surfaceWorld(true);
  const initial = (): SimState => createInitialState(world, 3, ["p1"], { x: 250, z: 250, heading: 0 });
  const walker = (numericId: number, x: number, y: number, z: number, heading: number, changes: Partial<AgentMotionProposal> = {}): AgentMotionProposal => ({
    id: `mission:test:${numericId}`, numericId, legacyId: null, kind: "walker", bodyKind: "robot",
    x, y, z, heading, speed: 1.2, radius: 0.4, height: 1.8, sourceX: x, sourceY: y, sourceZ: z, ...changes,
  });
  /** Admit, then propose one 1.2 m/s step from where the body stands; the accepted body. */
  const stepOnce = (state: SimState, m: AgentMotionProposal, dx: number, dz: number) => {
    const ready = prepareMotionBodies(world, state, [m]);
    const body = ready.ext.agents!.list.find((a) => a.id === m.numericId);
    expect(body, `admitted at ${m.sourceX},${m.sourceY},${m.sourceZ}`).toBeDefined();
    const next = applyMotionBodies(world, ready, [{ ...m, x: body!.x + dx, z: body!.z + dz, y: body!.y }]);
    return { before: body!, after: next.ext.agents!.list.find((a) => a.id === m.numericId)! };
  };

  it("walks through the tunnel bore at its floor, under the house on the ridge", () => {
    const y = surfaceHeight(world, 0, -100, 0);
    expect(y).toBeLessThan(0.5);
    expect(surfaceHeight(world, 0, -100, 30)).toBeGreaterThan(15);
    const { before, after } = stepOnce(initial(), walker(101, 0, y, -100, 0), 0, -0.02);
    expect(after.z).toBeLessThan(before.z);
    expect(after.y).toBeLessThan(0.5);
  });

  it("walks along the overpass deck at deck height", () => {
    const y = surfaceHeight(world, 30, 130, overpassY(130));
    expect(y).toBeCloseTo(overpassY(130), 1);
    const { before, after } = stepOnce(initial(), walker(102, 30, y, 130, Math.PI), 0, 0.02);
    expect(after.z).toBeGreaterThan(before.z);
    expect(after.y).toBeCloseTo(y, 1);
  });

  it("admits a body on the deck over one on the street below, and the reverse, but never two on one level", () => {
    const deckY = surfaceHeight(world, 30, 130, overpassY(130));
    const streetY = surfaceHeight(world, 30, 130, 0);
    expect(deckY - streetY).toBeGreaterThan(5);
    const below = prepareMotionBodies(world, initial(), [walker(103, 30, streetY, 130, Math.PI / 2)]);
    expect(below.ext.agents!.list.map((a) => a.id)).toContain(103);
    const both = prepareMotionBodies(world, below, [walker(104, 30, deckY, 130, Math.PI)]);
    expect(both.ext.agents!.list.map((a) => a.id)).toContain(104);
    const above = prepareMotionBodies(world, initial(), [walker(105, 30, deckY, 130, Math.PI)]);
    expect(prepareMotionBodies(world, above, [walker(106, 30, streetY, 130, Math.PI / 2)]).ext.agents!.list.map((a) => a.id)).toContain(106);
    // Same level, same spot: deferred, as before.
    expect(prepareMotionBodies(world, below, [walker(107, 30.3, streetY, 130, Math.PI / 2)]).ext.agents!.list.map((a) => a.id)).not.toContain(107);
  });

  it("is still held by a building at its own height", () => {
    // The house over the bore stands on the ridge: a body on the ridge walking into it is held.
    const ridge = surfaceHeight(world, 0, -100, 30);
    let s = initial();
    let held = false;
    for (const x of [-12, -10, -8, -6, 6, 8, 10, 12]) {
      const m = walker(110, x, surfaceHeight(world, x, -100, 30), -100, x < 0 ? Math.PI / 2 : -Math.PI / 2);
      const ready = prepareMotionBodies(world, s, [m]);
      const body = ready.ext.agents!.list.find((a) => a.id === 110);
      if (!body) continue;
      const toward = x < 0 ? 0.02 : -0.02;
      let cur = ready;
      for (let t = 0; t < 1200; t++) {
        const b = cur.ext.agents!.list.find((a) => a.id === 110)!;
        const next = applyMotionBodies(world, cur, [{ ...m, x: b.x + toward, z: b.z, y: b.y }]);
        const a = next.ext.agents!.list.find((q) => q.id === 110)!;
        if (a.x === b.x) {
          held = Math.abs(a.x) > 0.4 && a.y > ridge - 5;
          break;
        }
        cur = next;
      }
      s = initial();
      if (held) break;
    }
    expect(held, "a ridge walker meets the house on the ridge").toBe(true);
  });
});
