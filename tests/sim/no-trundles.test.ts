// v26 (owner, 2026-10-27: "We can probably remove the little vacuum robots for now"): no ambient
// Trundles (sidewalkBot). The initial fill is unchanged, because older replays restamp the state
// createInitialState makes; the first v26 step takes the Trundles off the street, and population
// passes give their budget to Footmen (errandRobot), one for one. v25 keeps every Trundle.
import { describe, expect, it } from "vitest";
import {
  SIM_VERSION, TRUNDLE_FREE_VERSION, agentsOf, buildWorld, canonicalJson, createGameSystems, createInitialState,
  step, upgradeState, type AgentKind, type SimState,
} from "../../src/sim/index.ts";
import { planMissionActors, type MissionStage } from "../../src/sim/agents/mission-actors.ts";
import { LONG_RUN_MS, gridCity } from "./fixtures.ts";

const count = (s: SimState, kind: AgentKind): number => agentsOf(s).filter((a) => a.kind === kind).length;
const spawn = { x: 150, z: 40, heading: 0 };

describe("v26: no ambient Trundles", () => {
  it("the initial fill is unchanged; the first v26 step takes every Trundle off the street, a v25 step keeps them", () => {
    expect(TRUNDLE_FREE_VERSION).toBe(SIM_VERSION);
    const world = gridCity();
    const initial = createInitialState(world, 7, ["p1"], spawn);
    expect(count(initial, "sidewalkBot")).toBeGreaterThan(0);
    const before = canonicalJson(initial);
    const v26 = step(world, initial, {});
    const v25 = step(world, { ...initial, version: TRUNDLE_FREE_VERSION - 1 }, {});
    expect(canonicalJson(initial)).toBe(before);
    expect(count(v26, "sidewalkBot")).toBe(0);
    expect(count(v25, "sidewalkBot")).toBe(count(initial, "sidewalkBot"));
    // Nothing else is touched: every other agent is where v25 put it, and no RNG was drawn.
    expect(agentsOf(v26)).toEqual(agentsOf(v25).filter((a) => a.kind !== "sidewalkBot"));
    expect(v26.rng).toEqual(v25.rng);
  });

  it("Footmen take the Trundles' budget one for one in the game composition: no Trundle comes back, no more bodies than v25", () => {
    const world = gridCity(), systems = createGameSystems({ wave: 2 });
    const run = (version: number): SimState => {
      let s: SimState = { ...createInitialState(world, 7, ["p1"], spawn), version };
      for (let t = 0; t < 600; t++) {
        s = step(world, s, {}, [], systems);
        if (version >= TRUNDLE_FREE_VERSION) expect(count(s, "sidewalkBot")).toBe(0);
      }
      return s;
    };
    const old = run(TRUNDLE_FREE_VERSION - 1), now = run(TRUNDLE_FREE_VERSION);
    expect(count(old, "sidewalkBot")).toBeGreaterThan(0);
    const robots = count(old, "errandRobot") + count(old, "sidewalkBot");
    expect(count(now, "errandRobot")).toBeGreaterThan(count(old, "errandRobot"));
    expect(count(now, "errandRobot")).toBeGreaterThanOrEqual(robots - 2);
    expect(agentsOf(now).length).toBeLessThanOrEqual(agentsOf(old).length);
    for (const kind of ["robotaxi", "person"] as const) expect(Math.abs(count(now, kind) - count(old, kind))).toBeLessThanOrEqual(2);
  }, LONG_RUN_MS);

  it("bare step() (no city-life densities) refills the same way", () => {
    const world = gridCity();
    let s = createInitialState(world, 7, ["p1"], spawn);
    const robots = count(s, "errandRobot") + count(s, "sidewalkBot");
    for (let t = 0; t < 300; t++) s = step(world, s, {});
    expect(count(s, "sidewalkBot")).toBe(0);
    expect(count(s, "errandRobot")).toBe(robots);
  }, LONG_RUN_MS);

  it("upgrades a v25 save by restamping only", () => {
    const old = { ...createInitialState(gridCity(), 7, ["p1"], spawn), version: TRUNDLE_FREE_VERSION - 1 };
    const before = canonicalJson(old);
    const upgraded = upgradeState(old);
    expect(upgraded).toEqual({ ...old, version: TRUNDLE_FREE_VERSION });
    expect(upgraded.ext).toBe(old.ext);
    expect(canonicalJson(old)).toBe(before);
  });

  it("missions (and the director's incidents, which stage through the same planner) still stage named Trundles", () => {
    const world = buildWorld([]);
    const state = createInitialState(world, 1, ["p"], { x: 100, z: 100, heading: 0 });
    expect(state.version).toBe(TRUNDLE_FREE_VERSION);
    const stage: MissionStage = { missionId: "spill", stepId: "meet", actorIds: ["sniffer", "courier"],
      definitions: { sniffer: { kind: "badRobot", archetype: "harvester" }, courier: { kind: "goodRobot", archetype: "courierTrundle" } },
      place: { x: 0, y: 0, z: 0 }, radius: 20 };
    const plan = planMissionActors(world, state, stage);
    expect(plan.blocked).toEqual([]);
    expect(plan.actors.map((a) => a.model)).toEqual(["trundle", "trundle"]);
  });
});
