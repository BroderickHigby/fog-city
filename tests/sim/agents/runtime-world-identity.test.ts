import { describe, expect, it } from "vitest";
import { createInitialState } from "../../../src/sim/step.ts";
import { NEUTRAL_INPUT } from "../../../src/sim/contract.ts";
import { AGENT_SPEC, type AgentState } from "../../../src/sim/agents.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { PROTECTED_AREAS } from "../../../src/content/places.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { agentRuntimeSession, enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";
import { runtimeCombatContext } from "../../../src/sim/agents/runtime-combat.ts";
import { baselineRobotFirmware, robotRuntimeSystem } from "../../../src/sim/robots/runtime-system.ts";

const world = buildWorld([]);
function actor(id: number, x: number, z: number): AgentState {
  return { id, kind: "errandRobot", x, y: 0, z, heading: 0, pitch: 0, speed: 0, vmax: AGENT_SPEC.errandRobot.vmax,
    edge: "", dir: 1, lane: 1, s: 0, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: id + 1, dodge: null };
}

describe("explicit runtime world identity", () => {
  it("retains the loader's identity through normal enabled robot and combat adapters without requiring gameplay metadata", () => {
    const area = PROTECTED_AREAS.find(value => value.id === "tenderloin")!;
    const at = toLocal(area.polygon.reduce((sum, point) => sum + point[0], 0) / area.polygon.length,
      area.polygon.reduce((sum, point) => sum + point[1], 0) / area.polygon.length);
    let bad = 1, good = 1;
    while (baselineRobotFirmware(17, bad, "errandRobot") !== "bad") bad++;
    while (baselineRobotFirmware(17, good, "errandRobot") !== "good") good++;
    const base = createInitialState(world, 17, ["p"], { x: at.x, z: at.z + 20, heading: 0 });
    base.ext.agents = { nextId: Math.max(bad, good) + 1, list: [actor(bad, at.x, at.z), actor(good, at.x, at.z - 2)] };
    const before = enableAgentRuntime(base, { wave: 2, worldName: "sf" });
    expect(world.gameplay).toBeUndefined();
    expect(agentRuntimeSession(JSON.parse(JSON.stringify(before)))?.worldName).toBe("sf");
    const context = { world, previous: before, state: { ...before, tick: 1 }, inputs: { p: NEUTRAL_INPUT }, events: [] };
    const robots = robotRuntimeSystem.step(context);
    const combat = runtimeCombatContext({ ...context, state: robots });
    expect(combat.conversionScopes?.some(scope => scope.id.endsWith("/protected:tenderloin") && scope.cap === 1)).toBe(true);
    const dev = enableAgentRuntime(base, { wave: 2, worldName: "dev" });
    const devContext = { ...context, previous: dev, state: { ...dev, tick: 1 } };
    expect(runtimeCombatContext({ ...devContext, state: robotRuntimeSystem.step(devContext) }).conversionScopes?.some(scope => scope.id.includes("/protected:"))).toBe(false);
  });

  it("keeps old sessions valid and rejects invalid identity slugs", () => {
    const old = enableAgentRuntime(createInitialState(world, 1, ["p"], { x: 0, z: 0, heading: 0 }));
    expect(agentRuntimeSession(old)?.worldName).toBeUndefined();
    for (const worldName of ["../sf", "SF", "", "a".repeat(65)]) {
      expect(() => enableAgentRuntime(old, { worldName })).toThrow(/world name/);
      expect(agentRuntimeSession({ ...old, ext: { ...old.ext, robots: { ...old.ext.robots!, worldName } } })).toBeNull();
    }
  });
});
