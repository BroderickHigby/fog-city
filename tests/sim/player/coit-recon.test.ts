import { describe, expect, it } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import { ACTIVITY_DEFINITIONS } from "../../../src/content/gameplay.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { activityAvailable } from "../../../src/sim/activities/availability.ts";
import { RECON_RELAYS } from "../../../src/sim/activities/recon.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { circleBlocked } from "../../../src/sim/world.ts";
import { sfWorld, CITY_MS } from "../world/load.ts";
import type { ActivitiesState, ActivityDefinition, GameplayContext, GameplayFact } from "../../../src/sim/player/types.ts";

const definition = ACTIVITY_DEFINITIONS.find(value => value.id === "coit-recon")!;
const recon: ActivityDefinition = { id: definition.id, kind: definition.kind, wave: definition.wave, ...toLocal(definition.checkpoints[0]!.lat, definition.checkpoints[0]!.lon), y: 0,
  radius: definition.checkpoints[0]!.radiusM, objective: definition.objective, timeLimitS: definition.timeLimitS, rewardCents: definition.reward.cashCents, rewardXp: definition.reward.xp,
  checkpoints: definition.checkpoints.map(point => ({ id: point.id, ...toLocal(point.lat, point.lon), y: 0, radius: point.radiusM })) };
function context(at: { x: number; z: number }, patch: Partial<GameplayContext> = {}, mode: "foot" | "vehicle" = "foot"): GameplayContext {
  return { ...DEFAULT_CATALOG, activities: [recon], wave: 4, bodies: [{ id: "p", x: at.x, y: 0, z: at.z, mode, speed: 0 }],
    actors: [], observations: [], facts: [], commands: [], day: 1, month: 1, ...patch };
}
function run(at: { x: number; z: number }, ticks: number, actions: number, mode: "foot" | "vehicle" = "foot", facts: GameplayFact[] = []): ActivitiesState & { seen: string[] } {
  let state = stepActivities(createActivities(), context(recon, { commands: [{ playerId: "p", sequence: 1, kind: "activity-start", targetId: recon.id }] }), 1, createMissions(), 7, 21);
  const seen: string[] = [];
  // Walk the path to the overlook, then work at the relay.
  state = stepActivities(state, context(recon.checkpoints![1]!), 2, createMissions(), 7, 21);
  for (let tick = 3; tick < 3 + ticks; tick++) {
    state = stepActivities(state, context(at, { actions: { p: actions }, facts: tick === 3 ? facts : [] }, mode), tick, createMissions(), 7, 21);
    seen.push(...state.events.map(value => value.kind));
  }
  return { ...state, seen };
}

describe("Coit Tower Recon", () => {
  it("follows the design's wave four and has a measured producer", () => {
    expect(definition.wave).toBe(4);
    expect(activityAvailable(recon)).toBe(true);
    // The wave-three game does not offer it.
    expect(DEFAULT_CATALOG.activities.some(value => value.id === "coit-recon")).toBe(false);
  });
  it("reads a relay's signal after a held one-second Bot Check beside it, and pays once on the route", () => {
    const relay = RECON_RELAYS[0]!;
    const state = run({ x: relay.x + 3, z: relay.z }, 80, Action.scan);
    expect(state.seen).toEqual(["recon.signalFound", "activity.cash", "activity.xp", "activity.finished"]);
    expect(state.players.p!.completedIds).toEqual(["coit-recon"]);
  });
  it("ignores scans out of range, from a car, released early, and claimed signals", () => {
    const relay = RECON_RELAYS[0]!, claim: GameplayFact = { id: "spoof", source: "world", sequence: 1, tick: 3, kind: "recon.signalFound", playerId: "p" };
    expect(run({ x: relay.x + 20, z: relay.z }, 200, Action.scan).seen).not.toContain("recon.signalFound");
    expect(run({ x: relay.x + 3, z: relay.z }, 200, Action.scan, "vehicle").seen).not.toContain("recon.signalFound");
    expect(run({ x: relay.x + 3, z: relay.z }, 50, Action.scan).seen).not.toContain("recon.signalFound");
    expect(run({ x: relay.x + 20, z: relay.z }, 200, 0, "foot", [claim]).players.p!.objectiveCount).toBe(0);
  });
});

it("stands every relay and the overlook on open ground on Telegraph Hill", () => {
  const { world } = sfWorld();
  const view = recon.checkpoints![1]!;
  expect(circleBlocked(world, view.x, view.z, .5)).toBe(false);
  for (const relay of RECON_RELAYS) {
    expect(circleBlocked(world, relay.x, relay.z, .5), `${relay.id} is inside a building`).toBe(false);
    expect(Math.hypot(relay.x - view.x, relay.z - view.z)).toBeLessThan(150);
  }
}, CITY_MS);
