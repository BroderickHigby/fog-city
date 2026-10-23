import { describe, expect, it } from "vitest";
import { Action, NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import type { AgentState } from "../../../src/sim/agents.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { canonicalJson } from "../../../src/sim/serialize.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { completeAgentRuntimeSystem } from "../../../src/sim/agents/runtime-registration.ts";
import { runtimeCombatSystem } from "../../../src/sim/agents/runtime-combat.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { finalizeRoutineEffects } from "../../../src/sim/agents/routine-effects.ts";
import { createRoutineRuntime } from "../../../src/sim/agents/routine-runtime.ts";
import { baselineRobotFirmware, robotRuntimeSystem } from "../../../src/sim/robots/runtime-system.ts";
import { robotMetadata, storeRobotMetadata, type RobotRuntimeMetadata } from "../../../src/sim/robots/metadata.ts";
import { ambientProfilesOf } from "../../../src/sim/agents/ambient-runtime.ts";
import { robotCatalogPresentation, robotCatalogProfileForSource } from "../../../src/sim/robots/catalog.ts";
import { robotTellFrame } from "../../../src/render/robot-tells.ts";

const world = buildWorld([]);
const systems = [completeAgentRuntimeSystem, robotRuntimeSystem, runtimeCombatSystem];
function agent(id: number, x: number, z: number): AgentState {
  return { id, kind: "errandRobot", x, y: 0, z, heading: 0, pitch: 0, speed: 0, vmax: 0,
    edge: "", dir: 1, lane: 1, s: 0, next: "", ndir: 1, nlane: 1, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: id + 1, dodge: null };
}
function scene(): SimState {
  let bad = 1; while (baselineRobotFirmware(17, bad, "errandRobot") !== "bad") bad++;
  let good = bad + 1; while (baselineRobotFirmware(17, good, "errandRobot") !== "good") good++;
  const state = enableAgentRuntime(createInitialState(world, 17, ["p"], { x: 50, z: 50, heading: 0 }), { wave: 3 });
  state.players.p!.mode = "foot"; state.players.p!.foot = makeFoot(0, 0, 5, 0);
  state.ext.agents = { nextId: good + 1, list: [agent(bad, 0, 0), agent(good, 10, 0)] };
  state.ext.robots!.catalogArchetypes = { [bad]: { bad: "snatcher" } };
  return step(world, state, { p: NEUTRAL_INPUT }, [], systems);
}
function full(state: SimState): SimState {
  const { metadataVersion: _encoding, ...robots } = state.ext.robots!;
  return { ...state, ext: { ...state.ext, robots: { ...robots, metadata: robotMetadata(state) } as never } };
}
function compact(state: SimState): SimState {
  const metadata = robotMetadata(state), catalogSources: Record<string, { seed: number; key: string }> = {};
  for (const profile of ambientProfilesOf(state)) catalogSources[String(profile.id)] = { seed: profile.seed, key: profile.key };
  return { ...state, ext: { ...state.ext, robots: { ...state.ext.robots!, metadataVersion: 1,
    metadata: storeRobotMetadata(state.seed, { ...state.ext.robots!, metadata, catalogSources }) } as never } };
}
function clone(state: SimState): SimState { return JSON.parse(JSON.stringify(state)) as SimState; }

// All state fields are compared, not only the metadata subset or its hash.
describe("robot metadata storage", () => {
  it("loads old full rows and exactly reconstructs compact catalog and gameplay metadata", () => {
    const dense = full(scene()), before = canonicalJson(dense), small = compact(dense);
    expect(robotMetadata(dense)).toBe(dense.ext.robots!.metadata);
    expect(robotMetadata(clone(small))).toEqual(robotMetadata(dense));
    expect(canonicalJson(full(small))).toBe(before);
    expect(canonicalJson(dense)).toBe(before);
    const raw = small.ext.robots!.metadata as unknown as Record<string, unknown>[];
    expect(raw.length).toBeGreaterThan(0);
    for (const row of raw) {
      expect(Object.hasOwn(row, "actorId")).toBe(false);
      expect(Object.hasOwn(row, "firmware")).toBe(false);
      expect(Object.hasOwn(row, "catalogArchetypeId")).toBe(false);
      expect(Object.hasOwn(row, "tellIds")).toBe(false);
      expect(Object.hasOwn(row, "pendingTellIds")).toBe(false);
    }
    expect(canonicalJson(small).length).toBeLessThan(canonicalJson(dense).length);
  });

  it("reconstructs catalog identity from retained ambient provenance rather than allocation ID", () => {
    const dense = full(scene()), row = robotMetadata(dense)[0]!;
    const runtime = (dense.ext.agents as unknown as { runtime: Record<string, unknown> }).runtime;
    dense.ext.agents = { ...dense.ext.agents!, runtime: { ...runtime,
      ambient: { version: 1, cursor: 0, squares: [], profiles: [{ id: row.agentId, origin: [3, -2, 4, 1] }] } } } as typeof dense.ext.agents;
    const source = ambientProfilesOf(dense)[0]!, brain = dense.ext.robots!.brain as unknown as { robots: { agentId: number; model: string }[] };
    const model = brain.robots.find(entry => entry.agentId === row.agentId)!.model;
    const profile = robotCatalogProfileForSource(source, model, row.firmware, 1,
      row.firmware === "bad" ? "snatcher" : undefined)!;
    const expected = { ...row, ...robotCatalogPresentation(profile, { tick: dense.tick, x: 0, z: 0, heading: 0,
      hideOneTell: false, sabotageActive: false }) };
    dense.ext.robots = { ...dense.ext.robots!, metadata: [expected] } as never;
    const small = compact(dense);
    expect(Object.hasOwn((small.ext.robots!.metadata as unknown as object[])[0]!, "catalogArchetypeId")).toBe(false);
    expect(robotMetadata(small)).toEqual([expected]);
  });

  it("retains observed decisions, custom fields and any non-derived override", () => {
    const dense = full(scene());
    const rows = robotMetadata(dense).map((row, index) => index === 0 ? { ...row,
      mode: row.mode === "wary" ? "attack" as const : "wary" as const, catalogArchetypeId: "custom-catalog",
      pendingGoalIds: ["observed-goal"], sabotageActive: true, customObservation: { value: 7 },
    } : row);
    const changed = { ...dense, ext: { ...dense.ext, robots: { ...dense.ext.robots!, metadata: rows } as never } };
    expect(robotMetadata(clone(compact(changed)))).toEqual(rows);
  });

  it("keeps prior-combat phase and pre-movement head yaw, including render interpolation", () => {
    const before = full(scene()), rows = robotMetadata(before).map(row => ({ ...row, phase: "active" as const, rust: 0,
      presentation: { bagFull: false, bagSwing: 1.8, faceLight: 0, headYaw: 0.25 } }));
    const first = { ...before, ext: { ...before.ext, robots: { ...before.ext.robots!, metadata: rows } as never } };
    const after = clone(first), id = rows[0]!.actorId;
    (after.ext.robots!.metadata as unknown as RobotRuntimeMetadata[])[0] = { ...rows[0]!, presentation: { ...rows[0]!.presentation!, headYaw: 0.75 } };
    after.ext.agents!.list[0] = { ...after.ext.agents!.list[0]!, x: 20, heading: 2 };
    after.ext.combat!.targets[id] = { ...initialTarget(), phase: "heap", rust: 1 };
    const small = compact(after);
    expect(robotMetadata(small)[0]).toMatchObject({ phase: "active", rust: 0, presentation: { headYaw: 0.75 } });
    expect(robotTellFrame(compact(first), small, 0.25)).toEqual(robotTellFrame(first, after, 0.25));
  });

  it("replays whole serialized state equally through water, scans and an active attack", () => {
    let dense = full(scene());
    const attackerId = robotMetadata(dense)[0]!.actorId;
    dense.ext.combat!.attacks = [{ id: "ad", kind: "ad-blast", attackerId, targetId: "p", startTick: dense.tick,
      resolveTick: dense.tick, endTick: 600, presses: 0, active: true }];
    let small = clone(compact(dense)); const events: string[] = []; let activeAttackFrames = 0;
    for (let index = 0; index < 90; index++) {
      const input = { p: { ...NEUTRAL_INPUT, actions: index < 30 ? Action.fire : Action.scan, aimYaw: 0, aimPitch: 0 } };
      dense = full(step(world, clone(dense), input, [], systems));
      small = step(world, clone(small), input, [], systems);
      events.push(...small.ext.combat!.events.map(event => event.kind));
      if (small.ext.combat!.attacks.some(attack => attack.id === "ad" && attack.active)) activeAttackFrames++;
      expect(canonicalJson(full(small))).toBe(canonicalJson(dense));
    }
    expect(events).toContain("weapon.water"); expect(events).toContain("scan.result"); expect(activeAttackFrames).toBeGreaterThan(0);
    expect(canonicalJson(step(world, clone(dense), {}, [], systems))).toBe(canonicalJson(step(world, clone(small), {}, [], systems)));
  });

  it("preserves a physical safehouse restoration and its next complete simulation tick", () => {
    const before = scene(), dense = full(step(world, clone(before), {}, [], systems));
    const body: RuntimePhysicalBody = { id: "agent:99", numericId: 99, kind: "robot", model: "footman", firmware: "bad",
      x: 10, y: 0, z: 10, previousX: 10, previousZ: 10, heading: 0, previousHeading: 0, speed: 0,
      radius: 0.4, halfLength: 0.4, halfWidth: 0.4, height: 1.6, dodge: null };
    const effect = { id: "restore:99", actorId: body.id, playerId: "p", kind: "recruit.restore-at-safehouse", targetId: "", position: null, amount: 1 };
    const priorRuntime = (dense.ext.agents as unknown as { runtime: Record<string, unknown> }).runtime;
    dense.ext.agents = { ...dense.ext.agents!, runtime: { ...priorRuntime, bodies: [body], routines: createRoutineRuntime(dense.tick), significantAgentIds: [], deliveredAgentIds: [],
      routineOutput: { effects: [effect], actorMetadata: {} }, restorationArrivals: [{ actorId: body.id, effectId: effect.id, playerId: "p", sequence: 1,
        safehouseId: "home", position: { x: 10, y: 0, z: 10 } }], restoreSafehouses: [{ id: "home", x: 10, z: 10 }] } } as typeof dense.ext.agents;
    dense.ext.combat!.targets[body.id] = { ...initialTarget(), phase: "heap", rust: 1 };
    const restoredFull = finalizeRoutineEffects(world, before, dense), restoredSmall = finalizeRoutineEffects(world, before, compact(dense));
    expect(canonicalJson(full(restoredSmall))).toBe(canonicalJson(full(restoredFull)));
    expect(restoredSmall.ext.robots!.restoredAgentIds).toContain(99);
    expect(canonicalJson(step(world, clone(restoredSmall), {}, [], systems)))
      .toBe(canonicalJson(step(world, clone(restoredFull), {}, [], systems)));
  });
});
