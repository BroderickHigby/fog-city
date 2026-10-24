import { describe, expect, it } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import { createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { buildMissionParkingWorld } from "../../../src/sim/missions/parking-world.ts";
import { checkParking } from "../../../src/sim/missions/mechanics/parking.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { sfWorld, CITY_MS } from "../world/load.ts";
import { readJson } from "../../helpers.ts";
import type { ParkingLayer, StreetCleaningLayer } from "../../../src/sim/parking-data.ts";
import type { MissionParkingWorld } from "../../../src/sim/missions/mechanics/runtime.ts";
import type { ActivitiesState, GameplayContext, GameplayFact } from "../../../src/sim/player/types.ts";

const activity = DEFAULT_CATALOG.activities.find(value => value.id === "search-and-park")!;
const street = activity.checkpoints!.at(-1)!;
const bay = { id: "fixture-bay", edge: "fixture-road", side: "R" as const, x: street.x, y: 0, z: street.z, heading: 0, halfLength: 3.5, halfWidth: 1.3 };
function parking(rule: "free" | "no-parking", moving = false): MissionParkingWorld {
  return { bays: [bay], targets: [{ missionId: "search-and-park", stepId: "park", bayIds: [bay.id], expectedStayMinutes: 30 }],
    rules: [{ edge: bay.edge, side: bay.side, kind: rule, days: [], from: null, to: null, hourLimit: null, permitAreas: [] }], cleaning: [],
    clock: { isoWeekday: 2, minute: 600, weekOfMonth: 2, holiday: false },
    vehicles: [{ playerId: "p", x: bay.x, y: 0, z: bay.z, heading: 0, speed: moving ? 3 : 0, lateral: 0, halfLength: 2.2, halfWidth: .95, height: 1.4 }] };
}
function context(at: { x: number; z: number }, patch: Partial<GameplayContext> = {}): GameplayContext {
  return { ...DEFAULT_CATALOG, wave: 3, bodies: [{ id: "p", x: at.x, y: 0, z: at.z, mode: "vehicle", speed: 0 }],
    actors: [], observations: [], facts: [], commands: [], day: 1, month: 1, ...patch };
}
function drive(rule: "free" | "no-parking", facts: GameplayFact[] = [], moving = false): ActivitiesState & { seen: string[] } {
  const seen: string[] = [];
  let state = stepActivities(createActivities(), context(activity, { commands: [{ playerId: "p", sequence: 1, kind: "activity-start", targetId: activity.id }] }), 1, createMissions(), 7);
  for (let tick = 2; tick < 200; tick++) {
    const pressed = tick === 190 ? Action.interact : 0;
    state = stepActivities(state, context(street, { missionParking: parking(rule, moving), actions: { p: pressed }, facts: tick === 3 ? facts : [] }), tick, createMissions(), 7);
    seen.push(...state.events.map(value => value.kind));
  }
  return { ...state, seen };
}

describe("Search & Park", () => {
  it("is offered, and pays for a legal full-hull stop held still before Interact", () => {
    expect(activity).toBeDefined();
    const state = drive("free");
    expect(state.players.p!.completedIds).toEqual(["search-and-park"]);
    expect(state.seen).toEqual(["parking.legalStop", "activity.cash", "activity.xp", "activity.finished"]);
  });
  it("never pays for an illegal space, a moving car or a claimed stop", () => {
    const claim: GameplayFact = { id: "spoof", source: "world", sequence: 1, tick: 3, kind: "parking.legalStop", playerId: "p" };
    expect(drive("no-parking").players.p!.completedIds).toEqual([]);
    expect(drive("free", [], true).players.p!.completedIds).toEqual([]);
    expect(drive("no-parking", [claim]).players.p!.objectiveCount).toBe(0);
  });
});

it("offers a legal signed space on Illinois St from the committed SF rules", () => {
  const world = sfWorld().world, rules = readJson<ParkingLayer>("public/tiles/sf/parking.json"), cleaning = readJson<StreetCleaningLayer>("public/tiles/sf/street-cleaning.json");
  const start = createInitialState(buildWorld([]), 319, ["p"], { x: street.x, z: street.z, heading: 0 });
  const state = { ...start, ext: { ...start.ext, activities: { ...createActivities(), players: { p: { activeActivityId: "search-and-park" } } } } } as unknown as typeof start;
  const result = buildMissionParkingWorld({ world, state, previous: state, inputs: {}, events: [] }, rules.rules, cleaning.rules);
  const target = result.targets.find(value => value.missionId === "search-and-park" && value.stepId === "park")!;
  expect(target.bayIds.length).toBeGreaterThan(0);
  const legal = result.bays.filter(value => target.bayIds.includes(value.id) && checkParking({ playerId: "p", ...value, speed: 0, lateral: 0, halfLength: 2.2, halfWidth: .95, height: 1.4 }, value, { ...result, requests: [] }, state.tick, 30).legal);
  expect(legal.length, `No legal space at ${JSON.stringify(result.clock)}`).toBeGreaterThan(0);
  // Every offered space is on the signed street, inside reach of the checkpoint.
  for (const space of result.bays.filter(value => target.bayIds.includes(value.id))) expect(Math.hypot(space.x - street.x, space.z - street.z)).toBeLessThanOrEqual(street.radius + 60);
}, CITY_MS);
