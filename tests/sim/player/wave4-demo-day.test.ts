// Demo Day (wave 4) through the composed game: the forced-update interrupt, two real melts, the
// five-star attention grant, then the bell duel at the Powell & Market turntable played with
// interact on the producer's own response ticks. Route traversal is outside this test (bodies
// are placed); world, combat, heat and economy outcomes are real.
import { fogDensity } from "../../../src/sim/fog/index.ts";
import { describe, expect, it } from "vitest";
import { Action, type SimState, type SimEvent, type SimInput } from "../../../src/sim/contract.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { createGameSystems } from "../../../src/sim/game-systems.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { datan2 } from "../../../src/sim/dmath.ts";
import { MISSIONS } from "../../../src/content/catalog.ts";
import { missionPlace, createMissions, createMissionProgress } from "../../../src/sim/missions/system.ts";
import { runtimeCombatActors } from "../../../src/sim/agents/runtime.ts";
import { TURNTABLES } from "../../../src/sim/missions/mechanics/bell.ts";
import { BELL_TOLERANCE_TICKS } from "../../../src/sim/missions/mechanics/bell-duel.ts";
import type { GameplayCommand } from "../../../src/sim/player/types.ts";

function demoDay(outcome: "win" | "lose") {
  const mission = MISSIONS.find(value => value.id === "demo-day")!;
  const first = mission.steps[0]!;
  if (first.type !== "trigger" || first.event.kind !== "enterArea") throw new Error("Missing entry");
  const at = missionPlace(first.event.place);
  const hydrant = { id: "fixture-hydrant", kind: "hydrant" as const, x: at.x + 12, y: 0, z: at.z + 12, radius: 4, salt: false };
  const world = buildWorld([], null, null, { version: 1, world: "fixture", sourceSnapshot: "fixture", refills: [hydrant], anchors: [], tiles: [], territories: [] });
  let state = createInitialState(world, 505, ["p"], { x: at.x + 40, z: at.z + 40, heading: 0 });
  const progress = createMissionProgress();
  progress.completedIds = ["hot-desk", "spill", "launch-day", "demoed-correctly"];
  state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(at.x, 0, at.z, 0) } }, ext: { ...state.ext, missions: { ...createMissions(), players: { p: progress } } } };
  const systems = createGameSystems({ wave: 4, protectedArea: () => false });
  const commands: GameplayCommand[] = [];
  const seen = new Set<string>();
  function tick(actions = 0, command?: Omit<GameplayCommand, "playerId" | "sequence">) {
    const events: SimEvent[] = [];
    if (command) { const next = { ...command, playerId: "p", sequence: commands.length + 1 }; commands.push(next); events.push({ tick: state.tick + 1, kind: "gameplay.command", playerId: "p", payload: { ...command, sequence: next.sequence } }); }
    const input: SimInput = { throttle: 0, steer: 0, brake: 0, actions, ...((actions & Action.fire) ? { aimPitch: -.25 } : {}) };
    state = step(world, state, { p: input }, events, systems);
    for (const e of state.ext.missions?.events ?? []) seen.add(e.kind);
  }
  const stepId = () => state.ext.missions!.players.p!.stepId;
  const placeFoot = (x: number, z: number, heading = 0) => { state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(x, 0, z, heading) } } }; };
  const actorId = (alias: string) => state.ext.robots?.missionBindings[`p:demo-day:${alias}`] ?? state.ext.robots?.missionBindings[`demo-day:${alias}`] ?? `mission:demo-day:${alias}`;
  const face = (alias: string, distance = 3) => {
    const actor = runtimeCombatActors(state).find(value => value.id === actorId(alias));
    if (!actor) throw new Error(`Missing ${alias} at ${stepId()}`);
    placeFoot(actor.x, actor.z + distance, datan2(0, distance));
  };
  const refillIfDry = () => {
    if ((state.ext.combat?.players.p?.water ?? 8) > 0.5) return;
    placeFoot(hydrant.x, hydrant.z);
    for (let i = 0; i < 200 && (state.ext.combat!.players.p!.water < 8); i++) tick(Action.interact);
    tick();
  };
  function until(predicate: () => boolean, limit: number, action: () => void) {
    for (let i = 0; i < limit && !predicate(); i++) action();
    expect(predicate(), `stalled at ${stepId()} (${state.ext.missions?.players.p?.status})`).toBe(true);
  }

  tick(0, { kind: "mission-start", targetId: "demo-day" });
  for (let i = 0; i < 4; i++) tick();
  expect(stepId()).toBe("interrupt");
  // The pusher channels a forced update into the guest; water on the pusher breaks it.
  // Bad firmware sabotages only unobserved: stand off and look away until the channel starts.
  const standOff = () => { const guest = runtimeCombatActors(state).find(v => v.id === actorId("guest"))!; placeFoot(guest.x, guest.z + 24, Math.PI); };
  until(() => (state.ext.combat?.attacks ?? []).some(a => a.kind === "forced-update" && a.attackerId === actorId("pusher")), 2400, () => { standOff(); tick(); });
  until(() => stepId() !== "interrupt", 600, () => { refillIfDry(); face("pusher"); tick(Action.fire); });
  expect(stepId()).toBe("melt");
  until(() => stepId() !== "melt", 2400, () => { refillIfDry(); face("sticker"); tick(Action.fire); });
  until(() => stepId() !== "melt-pusher", 2400, () => { refillIfDry(); face("pusher"); tick(Action.fire); });
  tick();
  expect(stepId()).toBe("corner");
  // Five stars on the melts, then the plaza's real fog at this hour (0.5) halves the time to
  // the first decay (heat/system.ts): four stars by the corner.
  expect(fogDensity(world, state, state.players.p!.foot!.x, state.players.p!.foot!.z)).toBeGreaterThan(0.4);
  expect(state.ext.heat!.players.p!.vcQuarters).toBe(16);
  const cashBefore = state.ext.economy!.players.p!.cashCents;

  // Cornered at the Powell & Market turntable: interact on foot starts the duel.
  const table = TURNTABLES.find(t => t.id === "powell-market")!;
  placeFoot(table.x + 1, table.z);
  tick(); tick(Action.interact); tick();
  expect(stepId()).toBe("bell");
  expect(seen.has("bell.duelStarted")).toBe(true);
  // Repeat the pattern: press on each response tick (win) or a beat late (lose).
  let presses = 0;
  until(() => state.ext.missions!.players.p!.status !== "active" || stepId() !== "bell", 4000, () => {
    const duel = state.ext.missions!.bell?.duels.p;
    const due = duel?.phase === "response" ? duel.responseTicks[duel.ringIndex] : undefined;
    // Losing: the first ring on time, every later ring a beat past the ±120 ms window.
    const late = outcome === "lose" && (duel?.ringIndex ?? 0) > 0 ? BELL_TOLERANCE_TICKS + 3 : 0;
    const press = due !== undefined && state.tick + 1 === due + late;
    if (press) presses++;
    tick(press ? Action.interact : 0);
  });
  // Heat, economy and the player act on the mission's events on the following tick.
  for (let i = 0; i < 3; i++) tick();
  return { state, seen, presses, cashBefore };
}

describe("Demo Day (wave 4) composed", () => {
  it("interrupts the update, melts both bad robots and wins the bell duel at the turntable", () => {
    const { state, seen, presses, cashBefore } = demoDay("win");
    expect(seen.has("bell.roundWon")).toBe(true);
    expect(seen.has("bell.duelWon")).toBe(true);
    expect(presses).toBeGreaterThanOrEqual(8);
    expect(state.ext.missions!.players.p!.status).toBe("complete");
    expect(state.ext.missions!.players.p!.completedIds).toContain("demo-day");
    // Win: back to two stars, $500 and the mission's $1,800.
    expect(state.ext.heat!.players.p!.vcQuarters).toBe(8);
    expect(state.ext.economy!.players.p!.cashCents - cashBefore).toBe(50_000 + 180_000);
  }, 120_000);

  it("loses the duel by ringing late: ACQUI-HIRED, the 10% fee, and a retry from the start", () => {
    const { state, seen, cashBefore } = demoDay("lose");
    expect(seen.has("bell-duel.lost")).toBe(true);
    expect(seen.has("bell.duelWon")).toBe(false);
    const progress = state.ext.missions!.players.p!;
    expect(progress.completedIds).not.toContain("demo-day");
    expect(progress.status).toBe("retry");
    expect(progress.retryFrom).toBe("start");
    expect(state.ext.economy!.players.p!.cashCents).toBe(Math.floor(cashBefore * 0.9));
    expect(state.ext.heat!.players.p!.vcQuarters).toBe(0);
  }, 120_000);

  it("is unavailable at wave 3", () => {
    expect(MISSIONS.find(m => m.id === "demo-day")!.wave).toBe(4);
  });
});
