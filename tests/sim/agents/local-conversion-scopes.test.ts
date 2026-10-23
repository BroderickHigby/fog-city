import { describe, expect, it } from "vitest";
import { NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import type { CombatActor, ConversionScope } from "../../../src/sim/combat-contract.ts";
import { createConversionScopeLedger } from "../../../src/sim/combat/conversion-scopes.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { makeCar } from "../../../src/sim/car.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { PROTECTED_AREAS } from "../../../src/content/places.ts";
import { buildWorld, type World } from "../../../src/sim/world.ts";
import { deriveRobotConversionScopes, type RobotConversionBaseline } from "../../../src/sim/robots/conversion-scopes.ts";
import { createRobotRuntime, stepRobotRuntime } from "../../../src/sim/robots/runtime.ts";

function robot(id: number, x: number, z: number, firmware: "good" | "bad" = "bad"): CombatActor {
  return { id: `agent:${id}`, kind: "robot", model: "footman", firmware, x, y: 0, z, heading: 0, speed: 0, radius: 0.4, height: 1.8, inFidelity: true };
}
function world(sf = false): World {
  return buildWorld([], null, null, { version: 1, world: sf ? "sf" : "fixture", sourceSnapshot: "fixture", refills: [], anchors: [], tiles: [], territories: [] });
}
function scene() {
  const actors = [robot(1, 0, 0), robot(2, 0, -2, "good"), robot(3, 5, 0), robot(4, 1000, 0), robot(5, 1000, -2, "good")];
  const baselines: RobotConversionBaseline[] = [{ agentId: 1, firmware: "bad" }, { agentId: 2, firmware: "good" },
    { agentId: 3, firmware: "good" }, { agentId: 4, firmware: "bad" }, { agentId: 5, firmware: "good" }];
  const anchors = [{ id: "p", x: 0, z: 0 }, { id: "q", x: 1000, z: 0 }];
  return { actors, baselines, anchors };
}
function frame(actors: readonly CombatActor[], city: World): SimState {
  const state = createInitialState(city, 15, ["p", "q"], { x: 20, z: 20, heading: 0 });
  state.players.p!.car = makeCar(20, 20, 0);
  state.players.q!.car = makeCar(1020, 20, 0);
  state.ext.combat = createCombatState(15, { actors, players: [], walls: [], refills: [], conversionCap: 4 });
  return state;
}
function step(state: SimState, actors: readonly CombatActor[], conversionScopes?: readonly ConversionScope[], city = world()) {
  return stepRobotRuntime(createRobotRuntime(), { world: city, previous: state, state: { ...state, tick: 1 },
    inputs: { p: NEUTRAL_INPUT, q: NEUTRAL_INPUT }, events: [] }, { actors, conversion: { baseBadCount: 2, protectedArea: false }, conversionScopes });
}

describe("runtime local conversion scopes", () => {
  it("does not let a saturated local population borrow a distant anchor's spare capacity", () => {
    const city = world(), { actors, baselines, anchors } = scene();
    const scopes = deriveRobotConversionScopes(city, anchors, actors, baselines);
    const result = step(frame(actors, city), actors, scopes, city);
    expect(result.attacks.filter(attack => attack.kind === "forced-update")).toMatchObject([{ attackerId: "agent:4", targetId: "agent:5" }]);
    expect(result.attacks.some(attack => attack.targetId === "agent:2")).toBe(false);
    expect(result.locomotion.find(item => item.agentId === 1)?.intent.kind).toBe("errand");
    expect(result.actors.find(item => item.id === "agent:1")?.pursuing).toBe(false);
    expect(step(frame(actors, city), actors, undefined, city).attacks.some(attack => attack.targetId === "agent:2")).toBe(true);
  });

  it("is invariant to anchors, actor and native-baseline order", () => {
    const city = world(), { actors, baselines, anchors } = scene();
    const forward = deriveRobotConversionScopes(city, anchors, actors, baselines);
    const reverse = deriveRobotConversionScopes(city, [...anchors].reverse(), [...actors].reverse(), [...baselines].reverse());
    expect(reverse).toEqual(forward);
    expect(step(frame(actors, city), actors, forward, city)).toEqual(step(frame(actors, city), [...actors].reverse(), reverse, city));
  });

  it("requires room in every overlapping anchor instead of only the nearest one", () => {
    const city = world(), actors = [robot(1, 0, 0), robot(2, 300, 0), robot(3, 500, 0), robot(4, 250, -2, "good")];
    const baselines: RobotConversionBaseline[] = [{ agentId: 1, firmware: "bad" }, { agentId: 2, firmware: "good" }, { agentId: 3, firmware: "bad" }, { agentId: 4, firmware: "good" }];
    const scopes = deriveRobotConversionScopes(city, [{ id: "a", x: 0, z: 0 }, { id: "b", x: 500, z: 0 }], actors, baselines);
    expect(scopes.filter(scope => scope.actorIds.includes("agent:4"))).toHaveLength(2);
    expect(createConversionScopeLedger(actors, scopes)!.allows("agent:4")).toBe(false);
  });

  it("keeps converted native-good bodies out of the baseline and respects explicit empty scopes", () => {
    const city = world(), { actors, baselines, anchors } = scene();
    const before = deriveRobotConversionScopes(city, anchors, actors.map(actor => actor.id === "agent:3" ? { ...actor, firmware: "good" as const } : actor), baselines);
    const after = deriveRobotConversionScopes(city, anchors, actors, baselines);
    expect(after).toEqual(before);
    expect(step(frame(actors, city), actors, [], city).attacks.filter(attack => attack.kind === "forced-update")).toEqual([]);
  });

  it("uses authored protected intersections only for an explicitly identified SF world", () => {
    const area = PROTECTED_AREAS.find(area => area.id === "tenderloin")!;
    const lat = area.polygon.reduce((sum, point) => sum + point[0], 0) / area.polygon.length;
    const lon = area.polygon.reduce((sum, point) => sum + point[1], 0) / area.polygon.length;
    const at = toLocal(lat, lon), actors = [robot(1, at.x, at.z), robot(2, at.x, at.z - 2, "good")];
    const baselines: RobotConversionBaseline[] = [{ agentId: 1, firmware: "bad" }, { agentId: 2, firmware: "good" }];
    const anchors = [{ id: "p", ...at }];
    const sf = deriveRobotConversionScopes(world(true), anchors, actors, baselines);
    expect(sf.some(scope => scope.id.includes("protected:tenderloin") && scope.cap === 1)).toBe(true);
    expect(createConversionScopeLedger(actors, sf)!.allows("agent:2")).toBe(false);
    const fixture = deriveRobotConversionScopes(world(), anchors, actors, baselines);
    expect(fixture).toHaveLength(1);
    expect(createConversionScopeLedger(actors, fixture)!.allows("agent:2")).toBe(true);
    expect(actors[1]!.protected).toBeUndefined();
    expect(actors[1]!.firmware).toBe("good");
  });

  it("explicitly cancels an accepted channel when its current local allowance disappears", () => {
    const city = world(), { actors } = scene();
    const state = frame(actors, city);
    state.ext.combat!.attacks = [{ id: "pending", attackerId: "agent:1", targetId: "agent:2", kind: "forced-update",
      startTick: 0, resolveTick: 360, endTick: 360, presses: 0, active: false }];
    const result = step(state, actors, [{ id: "full", actorIds: ["agent:1", "agent:2", "agent:3"], cap: 2 }], city);
    expect(result.cancellations).toMatchObject([{ attackId: "pending", kind: "forced-update" }]);
    expect(result.attacks.some(attack => attack.kind === "forced-update")).toBe(false);
  });

  it("admits existing channels in canonical order when the scalar cap is tighter", () => {
    const city = world(), actors = [robot(1, 0, 0), robot(2, 0, -2, "good"), robot(3, 20, 0), robot(4, 20, -2, "good")];
    const state = frame(actors, city);
    state.ext.combat!.attacks = [1, 3].map(id => ({ id: `pending:${id}`, attackerId: `agent:${id}`, targetId: `agent:${id + 1}`, kind: "forced-update" as const,
      startTick: 0, resolveTick: 360, endTick: 360, presses: 0, active: false }));
    const result = stepRobotRuntime(createRobotRuntime(), { world: city, previous: state, state: { ...state, tick: 1 }, inputs: {}, events: [] },
      { actors, conversion: { baseBadCount: 3, protectedArea: true }, conversionScopes: [{ id: "all", actorIds: actors.map(actor => actor.id), cap: 4 }] });
    expect(result.cancellations.map(item => item.attackId)).toEqual(["pending:3"]);
    expect(result.attacks).toEqual([]);
  });

  it("releases an invalid earlier channel before admitting a valid later channel", () => {
    const city = world(), actors = [robot(1, 0, 0), robot(2, 0, -2, "good"), robot(3, 20, 0), robot(4, 20, -2, "good")];
    const state = frame(actors, city);
    state.ext.combat!.targets["agent:1"] = { ...initialTarget(), blindUntil: 50 };
    state.ext.combat!.attacks = [1, 3].map(id => ({ id: `pending:${id}`, attackerId: `agent:${id}`, targetId: `agent:${id + 1}`, kind: "forced-update" as const,
      startTick: 0, resolveTick: 360, endTick: 360, presses: 0, active: false }));
    const result = stepRobotRuntime(createRobotRuntime(), { world: city, previous: state, state: { ...state, tick: 1 }, inputs: {}, events: [] },
      { actors, conversion: { baseBadCount: 3, protectedArea: true }, conversionScopes: [{ id: "all", actorIds: actors.map(actor => actor.id), cap: 3 }] });
    expect(result.cancellations.map(item => item.attackId)).toEqual(["pending:1"]);
    expect(result.attacks).toEqual([]);
  });

  it("includes exact authored protected-area boundary points", () => {
    const area = PROTECTED_AREAS.find(area => area.id === "tenderloin")!;
    const [lat, lon] = area.polygon[0]!, at = toLocal(lat, lon);
    const actors = [robot(1, at.x, at.z)], baselines: RobotConversionBaseline[] = [{ agentId: 1, firmware: "bad" }];
    expect(deriveRobotConversionScopes(world(true), [{ id: "p", ...at }], actors, baselines)
      .some(scope => scope.id.includes("protected:tenderloin") && scope.cap === 1)).toBe(true);
  });

  it("does not promote rejected proposals or spend their attack sequence", () => {
    const city = world(), { actors } = scene(), state = frame(actors, city);
    const first = step(state, actors, [], city);
    expect(first.attacks).toEqual([]);
    expect(first.state.robots.every(entry => entry.sequence === 0 && !entry.significant.includes("engaged"))).toBe(true);
    const previous = { ...state, tick: 1, ext: { ...state.ext, combat: { ...state.ext.combat!, tick: 1 } } };
    const second = stepRobotRuntime(first.state, { world: city, previous, state: { ...previous, tick: 2 }, inputs: {}, events: [] },
      { actors, conversion: { baseBadCount: 2, protectedArea: false }, conversionScopes: [] });
    expect(second.state.robots.every(entry => entry.sequence === 0 && !entry.significant.includes("engaged"))).toBe(true);
  });

  it("does not mutate frozen descriptors or baseline records during geographic derivation", () => {
    const { actors, baselines, anchors } = scene();
    for (const actor of actors) Object.freeze(actor);
    for (const baseline of baselines) Object.freeze(baseline);
    Object.freeze(actors); Object.freeze(baselines); Object.freeze(anchors);
    const source = JSON.stringify({ actors, baselines, anchors });
    expect(deriveRobotConversionScopes(world(), anchors, actors, baselines)).toHaveLength(2);
    expect(JSON.stringify({ actors, baselines, anchors })).toBe(source);
  });
});
