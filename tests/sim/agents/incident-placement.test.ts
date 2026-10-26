import { describe, expect, it } from "vitest";
import { CITY_DIRECTOR_CARDS } from "../../../src/content/cityLife.ts";
import { createActivities } from "../../../src/sim/activities/system.ts";
import { incidentPlace, incidentPlaces } from "../../../src/sim/agents/incidents.ts";
import { buildSidewalkGraph } from "../../../src/sim/agents/navigation.ts";
import { agentsRuntimeOf, type RuntimeSpawn } from "../../../src/sim/agents/runtime.ts";
import { createAgentsSystem } from "../../../src/sim/agents/systems.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { allocateActorIds } from "../../../src/sim/identity.ts";
import { prepareMotionBodies } from "../../../src/sim/motion.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";

const card = CITY_DIRECTOR_CARDS.find(c => c.id === "crosswalk-squatter")!;
const body = { x: 0, z: 0, heading: 0 }, range = [25, 70] as const;
const nodes = Array.from({ length: 10 }, (_, i) => [{ id: `a${i}`, x: -54 + i * 12, z: -38 }, { id: `b${i}`, x: -54 + i * 12, z: -42 }]).flat();
const graph = buildSidewalkGraph({ nodes, edges: Array.from({ length: 10 }, (_, i) => ({ id: `cross${i}`, a: `a${i}`, b: `b${i}`, kind: "crosswalk" as const, points: [[-54 + i * 12, -38], [-54 + i * 12, -42]] })) });
const world = buildWorld([]); world.sidewalks = graph;
const key = "7:100:p1";
const candidates = incidentPlaces(graph, card, body, range, key, () => true, 10);

function fixture(blocked: number, version = 17) {
  let state = createInitialState(world, 7, ["p1"], { x: 300, z: 300, heading: 0 });
  state = { ...state, tick: 100, version, players: { p1: { ...state.players.p1!, mode: "foot", foot: makeFoot(0, 0, 0, 0) } }, ext: { ...state.ext, activities: { ...createActivities(), events: [{ id: 1, tick: 99, kind: "director.stage", playerId: "p1", targetId: card.id, amount: 120, detail: "" }] } } };
  const reserved = allocateActorIds(state, candidates.slice(0, blocked).map((_, i) => `blocker:${i}`));
  state = reserved.state;
  const spawns: RuntimeSpawn[] = candidates.slice(0, blocked).map((at, i) => ({ id: `blocker:${i}`, numericId: reserved.ids[`blocker:${i}`]!, model: "person", firmware: "none", ...at, y: 0, heading: 0, radius: 0.4, height: 1.8, posted: true }));
  const system = createAgentsSystem(() => ({ graph, services: false, spawns, director: { cards: [card], stageM: range, maxActive: 1 }, protectedArea: () => false }), allocateActorIds);
  return { state, system };
}

describe("bounded physical incident placement", () => {
  it("retains the legacy first rank and returns only legal locations", () => {
    expect(candidates).toHaveLength(10);
    expect(candidates[0]).toEqual(incidentPlace(graph, card, body, range, key, () => true));
    expect(incidentPlaces(graph, card, body, range, key, at => at > 0, 8).every(at => at.x > 0)).toBe(true);
    for (const at of candidates) expect(Math.hypot(at.x, at.z)).toBeGreaterThanOrEqual(range[0]);
    for (const at of candidates) expect(Math.hypot(at.x, at.z)).toBeLessThanOrEqual(range[1]);
  });

  it("v17 admits one clear alternative when the first location is occupied; v16 preserves refusal", () => {
    for (const version of [16, 17]) {
      const { state, system } = fixture(1, version), before = JSON.stringify(state);
      const planned = system.prepare({ world, previous: state, state, inputs: {}, events: [] });
      const incidents = Object.values(agentsRuntimeOf(planned.state)!.incidents ?? {});
      expect(incidents).toHaveLength(version === 17 ? 1 : 0);
      if (version === 17) {
        expect(incidents[0]).toMatchObject({ ...candidates[1], targetIds: ["incident:1:trundle"] });
        const admitted = prepareMotionBodies(world, planned.state, planned.motions);
        expect(admitted.ext.agents!.list.some(a => a.runtimeId === "incident:1:trundle")).toBe(true);
      }
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it("stops after eight occupied candidates even when a ninth location is clear", () => {
    const { state, system } = fixture(8);
    const planned = system.prepare({ world, previous: state, state, inputs: {}, events: [] });
    expect(Object.keys(agentsRuntimeOf(planned.state)!.incidents ?? {})).toEqual([]);
    expect(agentsRuntimeOf(planned.state)!.nextIncident).toBe(1);
    expect(agentsRuntimeOf(planned.state)!.actors["incident:1:trundle"]).toBeUndefined();
  });

  it("retains the active incident cap on repeated requests", () => {
    const { state, system } = fixture(0);
    const first = system.prepare({ world, previous: state, state, inputs: {}, events: [] });
    const next = { ...first.state, tick: 101 };
    const repeated = system.prepare({ world, previous: next, state: next, inputs: {}, events: [] });
    expect(Object.keys(agentsRuntimeOf(repeated.state)!.incidents ?? {})).toEqual(["incident:1"]);
    expect(agentsRuntimeOf(repeated.state)!.nextIncident).toBe(2);
  });

  it("v17 uses an actual long sidewalk path when both endpoints are outside the ring", () => {
    const long = buildSidewalkGraph({ nodes: [{ id: "left", x: -100, z: -40 }, { id: "right", x: 100, z: -40 }], edges: [{ id: "long", a: "left", b: "right", kind: "sidewalk", points: [[-100, -40], [100, -40]] }] });
    const walkCard = CITY_DIRECTOR_CARDS.find(c => c.id === "phone-sniffer-bus-stop")!;
    expect(incidentPlace(long, walkCard, body, range, key, () => true)).toBeNull();
    const along = incidentPlaces(long, walkCard, body, range, key, () => true, 8, true);
    expect(along.length).toBeGreaterThan(0);
    for (const at of along) {
      expect(at.z).toBe(-40);
      expect(Math.hypot(at.x, at.z)).toBeGreaterThanOrEqual(range[0]);
      expect(Math.hypot(at.x, at.z)).toBeLessThanOrEqual(range[1]);
    }
    expect(incidentPlaces(long, walkCard, body, range, key, () => false, 8, true)).toEqual([]);
    expect(incidentPlaces(long, card, body, range, key, () => true, 8, true)).toEqual([]);
    expect(incidentPlaces(graph, card, body, range, key, () => true, 8, true)).toEqual(candidates.slice(0, 8));
    for (const version of [16, 17]) {
      const { state } = fixture(0, version);
      state.ext.activities!.events[0]!.targetId = walkCard.id;
      const system = createAgentsSystem(() => ({ graph: long, services: false, director: { cards: [walkCard], stageM: range, maxActive: 1 }, protectedArea: () => false }), allocateActorIds);
      const planned = system.prepare({ world, previous: state, state, inputs: {}, events: [] });
      expect(Object.keys(agentsRuntimeOf(planned.state)!.incidents ?? {})).toHaveLength(version === 17 ? 1 : 0);
    }
  });
});
