// Fleet Week (wave 4) through the composed game on the real SF world: the pitch between jet
// passes (a point made under the jets is lost), the staged thief and escape car, the getaway
// along Marina Blvd (the car drives itself), a real cone on its hood and the on-foot recovery.
// The founder's own traversal is outside this test (the body is placed, keeping pace with the
// car); world, driving, combat and mission outcomes are real.
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { Action, type SimEvent, type SimInput } from "../../../src/sim/contract.ts";
import { loadWorld } from "../../helpers.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { createGameSystems } from "../../../src/sim/game-systems.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { datan2 } from "../../../src/sim/dmath.ts";
import { MISSIONS } from "../../../src/content/catalog.ts";
import { missionPlace, createMissions, createMissionProgress } from "../../../src/sim/missions/system.ts";
import { runtimeCombatActors } from "../../../src/sim/agents/runtime.ts";
import { jetsLoud, PITCH_PERIOD_TICKS, PITCH_LOUD_TICKS, GETAWAY_SPEED_MPS } from "../../../src/sim/missions/mechanics/fleet.ts";
import type { GameplayCommand } from "../../../src/sim/player/types.ts";

function fleetWeek() {
  const mission = MISSIONS.find(value => value.id === "fleet-week")!;
  const first = mission.steps[0]!;
  if (first.type !== "trigger" || first.event.kind !== "enterArea") throw new Error("Missing entry");
  const at = missionPlace(first.event.place);
  const { world } = loadWorld("sf", { roads: true });
  let state = createInitialState(world, 606, ["p"], { x: at.x + 40, z: at.z + 40, heading: 0 });
  const progress = createMissionProgress();
  progress.completedIds = ["hot-desk", "spill", "launch-day", "demoed-correctly", "demo-day"];
  state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(at.x, 0, at.z, 0) } }, ext: { ...state.ext, missions: { ...createMissions(), players: { p: progress } } } };
  const systems = createGameSystems({ wave: 4, protectedArea: () => false });
  const commands: GameplayCommand[] = [];
  const seen: string[] = [];
  function tick(actions = 0, command?: Omit<GameplayCommand, "playerId" | "sequence">, input: Partial<SimInput> = {}) {
    const events: SimEvent[] = [];
    if (command) { const next = { ...command, playerId: "p", sequence: commands.length + 1 }; commands.push(next); events.push({ tick: state.tick + 1, kind: "gameplay.command", playerId: "p", payload: { ...command, sequence: next.sequence } }); }
    state = step(world, state, { p: { throttle: 0, steer: 0, brake: 0, actions, ...input } }, events, systems);
    for (const e of state.ext.missions?.events ?? []) seen.push(e.kind);
  }
  const stepId = () => state.ext.missions!.players.p!.stepId;
  const placeFoot = (x: number, z: number, heading = 0) => { state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(x, 0, z, heading) } } }; };
  const actorId = (alias: string) => state.ext.robots?.missionBindings[`p:fleet-week:${alias}`] ?? state.ext.robots?.missionBindings[`fleet-week:${alias}`] ?? `mission:fleet-week:${alias}`;
  function until(predicate: () => boolean, limit: number, action: () => void) {
    for (let i = 0; i < limit && !predicate(); i++) action();
    expect(predicate(), `stalled at ${stepId()} (${state.ext.missions?.players.p?.status})`).toBe(true);
  }

  tick(0, { kind: "mission-start", targetId: "fleet-week" });
  tick();
  expect(stepId()).toBe("window");
  until(() => stepId() === "pitch", PITCH_PERIOD_TICKS, () => tick());
  const pitch = () => state.ext.missions!.fleet!.pitch.p!;
  // A point made under the jets is lost.
  until(() => jetsLoud(pitch().startTick, state.tick + 1), PITCH_PERIOD_TICKS, () => tick());
  tick(Action.interact); tick();
  expect(pitch().points).toBe(0);
  expect(seen).toContain("pitch.missed");
  // Three points in the quiet gaps.
  until(() => stepId() !== "pitch", 4 * PITCH_PERIOD_TICKS, () => {
    const quiet = !jetsLoud(pitch().startTick, state.tick + 1) && state.tick + 1 - pitch().lastPointTick >= 70;
    tick(quiet ? Action.interact : 0); tick();
  });
  expect(seen.filter(kind => kind === "pitch.point")).toHaveLength(3);
  for (let i = 0; i < 4; i++) tick();
  expect(stepId()).toBe("chase");
  const chase = mission.steps.find(value => value.id === "chase")!;
  if (chase.type !== "goto") throw new Error("Missing chase");
  const car = () => runtimeCombatActors(state).find(value => value.id === actorId("escapeCar"))!;
  expect(car()).toBeDefined();
  const target = missionPlace(chase.target);
  const start = car();
  if (process.env.FLEET_DUMP) writeFileSync(process.env.FLEET_DUMP, JSON.stringify(state));
  // Keep pace with the car from the pavement side (25 m to its left, off the carriageway) until it
  // waits at the target.
  let peak = 0;
  until(() => stepId() !== "chase", 240 * 60, () => {
    const c = car();
    peak = Math.max(peak, Math.abs(c.speed));
    if (process.env.FLEET_DUMP && state.tick % 120 === 0) console.log("CAR", state.tick, c.x.toFixed(1), c.z.toFixed(1), c.speed.toFixed(2), c.heading.toFixed(2));
    const near = Math.hypot(c.x - target.x, c.z - target.z) < 30 && Math.abs(c.speed) < 0.5;
    placeFoot(near ? target.x : c.x - 25 * Math.cos(c.heading), near ? target.z : c.z - 25 * Math.sin(c.heading));
    tick();
  });
  expect(stepId()).toBe("cone");
  expect(Math.hypot(car().x - start.x, car().z - start.z)).toBeGreaterThan(300);
  expect(peak).toBeGreaterThan(3);
  expect(peak).toBeLessThanOrEqual(GETAWAY_SPEED_MPS + 0.5);
  // Stand 6 m ahead of the car and lob a cone onto its hood.
  until(() => stepId() !== "cone", 600, () => {
    const c = car(), px = c.x + 6 * Math.sin(c.heading), pz = c.z - 6 * Math.cos(c.heading), aim = datan2(c.x - px, -(c.z - pz));
    placeFoot(px, pz, aim);
    tick(Action.cone, undefined, { aimYaw: aim, aimPitch: 0.25 }); for (let i = 0; i < 30 && stepId() === "cone"; i++) tick();
  });
  expect(stepId()).toBe("recover");
  until(() => Math.abs(car().speed) < 0.5, 400, () => tick());
  const c = car();
  placeFoot(c.x + 3, c.z);
  tick(); tick(Action.interact); for (let i = 0; i < 4; i++) tick();
  return { state, seen };
}

describe("Fleet Week (wave 4) composed", () => {
  it("pitches between the jets, cones the escape car and recovers it", () => {
    const { state, seen } = fleetWeek();
    expect(seen).toContain("pitch.windowOpened");
    expect(seen).toContain("pitch.windowCompleted");
    expect(seen).toContain("vehicle.recovered");
    expect(state.ext.missions!.players.p!.completedIds).toContain("fleet-week");
    expect(state.ext.economy!.players.p!.ownedSiteIds).toContain("marina-flat");
  }, 600_000);
  it("times the jets from the window's start", () => {
    expect(jetsLoud(100, 100)).toBe(true);
    expect(jetsLoud(100, 100 + PITCH_LOUD_TICKS)).toBe(false);
    expect(jetsLoud(100, 100 + PITCH_PERIOD_TICKS)).toBe(true);
    expect(jetsLoud(100, 99)).toBe(false);
  });
});
