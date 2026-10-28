import { describe, expect, it } from "vitest";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { planAgentRuntime, type RuntimeSpawn } from "../../../src/sim/agents/runtime.ts";
const world = buildWorld([]);
function proposal(model: RuntimeSpawn["model"], version: number, speedMultiplier?: number, controlled = false) {
  const sim = { ...createInitialState(world, 17, ["p"], { x: 0, z: -20, heading: 0 }), version };
  const spawn: RuntimeSpawn = { id: "subject", numericId: 10, model, firmware: ["person", "pigeon", "dog"].includes(model) ? "none" : "good",
    x: 0, y: 0, z: 0, heading: 0, radius: .4, height: 1.8 };
  return planAgentRuntime(world, sim, {}, { spawns: [spawn], speedMultiplier, controlledActorIds: controlled ? [spawn.id] : [] }).proposals.find(p => p.id === spawn.id);
}
describe("authored autonomous robot weather speed", () => {
  it("scales accepted target distance and speed only at SIM21, with finite bounds", () => {
    const normal = proposal("footman", 21)!;
    const winter = proposal("footman", 21, .9)!;
    expect(winter.speed).toBeCloseTo(normal.speed * .9);
    expect(Math.hypot(winter.x, winter.z)).toBeCloseTo(Math.hypot(normal.x, normal.z) * .9);
    expect(proposal("footman", 21, -20)!.speed).toBeCloseTo(normal.speed * .5);
    expect(proposal("footman", 21, 20)!.speed).toBe(normal.speed);
    expect(proposal("footman", 21, NaN)!.speed).toBe(normal.speed);
    expect(proposal("footman", 20, .5)).toEqual(proposal("footman", 20));
  });
  it("leaves people, animals, civilian vehicles and controlled bodies alone", () => {
    for (const model of ["person", "pigeon", "robotaxi"] as const) expect(proposal(model, 21, .5)).toEqual(proposal(model, 21));
    expect(proposal("footman", 21, .5, true)).toBeUndefined();
  });
});
