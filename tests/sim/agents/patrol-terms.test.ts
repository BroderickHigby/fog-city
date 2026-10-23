import { describe, expect, it } from "vitest";
import { TICK_HZ, type SimState } from "../../../src/sim/contract.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { buildWorld, type World } from "../../../src/sim/world.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { createAgentRuntimeSystem, agentsRuntimeOf, type AgentRuntimeData } from "../../../src/sim/agents/runtime-system.ts";
import { enableAgentRuntime, type RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { createRoutineRuntime, type RoutineRuntimeEffect, type RoutineRuntimeState } from "../../../src/sim/agents/routine-runtime.ts";
import { finalizeRoutineEffects, type RoutineEffectState } from "../../../src/sim/agents/routine-effects.ts";

const world = buildWorld([]);
const actorId = "agent:2000";
const effect: RoutineRuntimeEffect = { id: `${actorId}/terms/1`, kind: "patrol.terms", actorId, playerId: "p", targetId: "p", amount: 0, position: null };
type TestRuntime = AgentRuntimeData & { routines: RoutineRuntimeState; routineOutput: { effects: RoutineRuntimeEffect[]; actorMetadata: Record<string, Partial<CombatActor>> }; effectState?: RoutineEffectState };
const runtime = (state: SimState): TestRuntime => (state.ext.agents as unknown as { runtime: TestRuntime }).runtime;
const descriptors = (state: SimState): CombatActor[] => state.ext.robots!.actors as unknown as CombatActor[];

function fixture(city = world): SimState {
  const start = enableAgentRuntime(createInitialState(city, 41, ["p"], { x: 1000, z: 1000, heading: 0 }), { wave: 3 });
  const before: SimState = { ...start, players: { p: { ...start.players.p!, mode: "foot", foot: makeFoot(0, 0, -2, 0) } } };
  const base = createAgentRuntimeSystem({ animalLimit: { pigeons: 0, dogs: 0 } }).step({ world: city, previous: before, state: { ...before, tick: 1 }, inputs: {}, events: [] });
  const body: RuntimePhysicalBody = { id: actorId, numericId: 2000, kind: "robot", model: "patrol", firmware: "bad", operational: true,
    x: 0, y: 0, z: 0, previousX: 0, previousZ: 0, heading: 0, previousHeading: 0, speed: 0, radius: 0.8, halfLength: 1, halfWidth: 0.8, height: 1.6, dodge: null };
  const actor: CombatActor = { id: actorId, kind: "robot", model: "patrol", firmware: "bad", x: 0, y: 0, z: 0, radius: 0.8, height: 1.6, heading: 0, speed: 0 };
  const combat = createCombatState(41, { actors: [actor], players: [{ id: "p", x: 0, y: 0, z: -2, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1 }], walls: [], refills: [] }, 1);
  const data: TestRuntime = { ...agentsRuntimeOf(base)!, effectState: undefined, bodies: [body], routines: createRoutineRuntime(1),
    routineOutput: { effects: [{ ...effect }], actorMetadata: { [actorId]: { firmware: "bad" } } } };
  const after = { ...base, ext: { ...base.ext, combat, robots: { ...base.ext.robots!, actors: [actor] }, agents: { ...base.ext.agents!, runtime: data } } } as unknown as SimState;
  return finalizeRoutineEffects(city, before, after);
}

function advance(previous: SimState, change?: (state: SimState) => void, city = world): SimState {
  const next = JSON.parse(JSON.stringify(previous)) as SimState;
  next.tick++;
  next.ext.combat!.tick = next.tick;
  runtime(next).tick = next.tick;
  change?.(next);
  return finalizeRoutineEffects(city, previous, next);
}
function toTick(previous: SimState, tick: number): SimState {
  let state = previous;
  while (state.tick < tick) state = advance(state);
  return state;
}

const disabled: { name: string; apply: (state: SimState) => void; recover: (state: SimState) => void }[] = [
  { name: "blinded", apply: state => { state.ext.combat!.targets[actorId]!.blindUntil = 100; }, recover: state => { state.ext.combat!.targets[actorId]!.blindUntil = 0; } },
  { name: "stopped", apply: state => { state.ext.combat!.targets[actorId]!.stoppedUntil = 100; }, recover: state => { state.ext.combat!.targets[actorId]!.stoppedUntil = 0; } },
  { name: "seized", apply: state => { state.ext.combat!.targets[actorId]!.phase = "seized"; }, recover: state => { state.ext.combat!.targets[actorId]!.phase = "active"; } },
  { name: "restored descriptor", apply: state => { descriptors(state)[0]!.firmware = "good"; }, recover: state => { descriptors(state)[0]!.firmware = "bad"; } },
  { name: "explicit restoration", apply: state => { state.ext.robots!.restoredAgentIds = [2000]; }, recover: state => { state.ext.robots!.restoredAgentIds = []; } },
];

describe("Patrol Terms of Service finalization", () => {
  it("waits a full second, applies one two-second stop and does not reapply the effect", () => {
    let state = fixture();
    expect(runtime(state).effectState?.terms[0]?.startedTick).toBe(1);
    state = toTick(state, TICK_HZ);
    expect(state.ext.combat!.targets.p!.stoppedUntil).toBe(0);
    expect(runtime(state).effectState?.applied).not.toContain(effect.id);
    state = advance(state);
    expect(state.ext.combat!.targets.p!.stoppedUntil).toBe(1 + 3 * TICK_HZ);
    expect(runtime(state).effectState?.events.filter(event => event.kind === "patrol.terms")).toHaveLength(1);
    state = toTick(state, 1 + 3 * TICK_HZ);
    expect(runtime(state).effectState?.terms).toEqual([]);
    expect(state.ext.combat!.targets.p!.stoppedUntil).toBe(state.tick);
    expect(advance(state).ext.combat!.targets.p!.stoppedUntil).toBe(state.tick);
  });

  for (const condition of disabled) it(`cancels a ${condition.name} source mid-windup without resuming its stale effect`, () => {
    const before = toTick(fixture(), 30);
    let state = advance(before, condition.apply);
    expect(runtime(state).effectState?.terms).toEqual([]);
    expect(runtime(state).effectState?.acks).toContain(effect.id);
    expect(runtime(state).effectState?.events.filter(event => event.kind === "patrol.terms-cancelled")).toHaveLength(1);
    expect(runtime(state).bodies[0]!.firmware).toBe("bad");
    state = advance(state, condition.recover);
    state = toTick(state, 2 * TICK_HZ);
    expect(state.ext.combat!.targets.p!.stoppedUntil).toBe(0);
    expect(runtime(state).effectState?.terms).toEqual([]);
    expect(runtime(state).effectState?.applied).toContain(effect.id);
  });

  it("rechecks the source on the exact impact tick", () => {
    const state = advance(toTick(fixture(), TICK_HZ), next => { next.ext.combat!.targets[actorId]!.blindUntil = 100; });
    expect(state.tick).toBe(TICK_HZ + 1);
    expect(state.ext.combat!.targets.p!.stoppedUntil).toBe(0);
    expect(runtime(state).effectState?.events.some(event => event.kind === "patrol.terms")).toBe(false);
  });

  it("releases only a stop owned by the disabled Patrol", () => {
    for (const unrelatedUntil of [0, 300]) {
      const before = toTick(fixture(), TICK_HZ + 1);
      const state = advance(before, next => {
        if (unrelatedUntil) next.ext.combat!.targets.p!.stoppedUntil = unrelatedUntil;
        next.ext.combat!.targets[actorId]!.blindUntil = 100;
      });
      expect(state.ext.combat!.targets.p!.stoppedUntil).toBe(unrelatedUntil || state.tick);
      expect(runtime(state).effectState?.terms).toEqual([]);
    }
  });

  it("requires current physical line of sight before starting a windup", () => {
    const city = buildWorld([{ tileId: "wall", ground: null, buildings: [{ id: "wall", baseY: 0, topY: 4,
      footprint: [[-3, -1.1], [3, -1.1], [3, -0.9], [-3, -0.9]] }] }]);
    const state = fixture(city);
    expect(state.ext.combat!.targets.p!.stoppedUntil).toBe(0);
    expect(runtime(state).effectState?.terms).toEqual([]);
    expect(runtime(state).effectState?.events.some(event => event.kind === "patrol.terms-cancelled")).toBe(true);
  });
});
