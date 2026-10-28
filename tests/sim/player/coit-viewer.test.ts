import { describe, expect, it } from "vitest";
import { advanceCoitViewer, cloneCoitViewer, coitAngles, coitCameraPose, coitFidelityAnchors, coitGuideVoice, coitSessionActive, COIT_VIEWER, COIT_VIEW,
  type CoitPlayerContext, type CoitViewerSession } from "../../../src/sim/activities/coit-viewer.ts";
import { coitLineOfSight, coitPlayerContext } from "../../../src/sim/activities/coit-observation.ts";
import { createAgentsRuntime } from "../../../src/sim/agents/runtime.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { ACTIVITY_DEFINITIONS } from "../../../src/content/gameplay.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { startRecon, stepRecon } from "../../../src/sim/activities/recon.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { createWallet, createEconomy, stepEconomy } from "../../../src/sim/economy/system.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { gameplayCommandFromEvent, type GameplayBody, type GameplayCommand, type GameplayEvent } from "../../../src/sim/gameplay-contract.ts";
import type { ActivityDefinition, GameplayContext } from "../../../src/sim/player/types.ts";

const body = { ...COIT_VIEWER, id: "p", y: 0, mode: "foot" as const, speed: 0 };
const observed: CoitPlayerContext = { cashCents: 25, usable: true, aimYaw: Math.PI, aimPitch: -.2,
  actors: [{ id: "real:bad", behavior: "forced-update", visible: true, firmware: "bad", protected: false, active: true }],
  landmark: { id: "ferry-building", label: "Ferry Building", x: 0, y: 30, z: 0 } };
const command = (choiceId: string, sequence: number): GameplayCommand => ({ playerId: "p", kind: "coit-viewer", targetId: "coit-recon", choiceId, sequence });
function session() {
  let viewer: CoitViewerSession | undefined;
  const events: { kind: string; targetId: string; amount: number; detail: string }[] = [];
  function tick(at: number, commands: GameplayCommand[] = [], context: CoitPlayerContext = observed, currentBody: GameplayBody = body) {
    const result = advanceCoitViewer(viewer, context, currentBody, commands, at, 7, (kind, targetId, amount = 0, detail = "") => events.push({ kind, targetId, amount, detail }));
    viewer = result.viewer;
    return result;
  }
  return { tick, events, get viewer() { return viewer; } };
}

describe("Coit paid viewer", () => {
  it("charges a real quarter once, observes behavior and corrects a seeded wrong label before settling at thirty seconds", () => {
    const run = session(); run.tick(1, [command("open", 1)]);
    for (let tick = 2; tick <= 60; tick++) run.tick(tick);
    run.tick(61, [command("tag", 2)]);
    for (let tick = 62; tick <= 181; tick++) run.tick(tick);
    expect(run.viewer!.guide!.claimedLabel).not.toBe("Ferry Building");
    expect(run.viewer!.guide!.flagUntilTick - run.viewer!.guide!.startedTick).toBe(300);
    run.tick(182, [command("flag", 3)]);
    expect(run.viewer!.taggedIds).toEqual(["real:bad"]); expect(run.viewer!.flaggedIds).toHaveLength(1);
    expect(coitGuideVoice(run.viewer!).text).toBe("You're absolutely right! That is the Ferry Building.");
    expect(run.tick(1800).completed).toBe(false);
    expect(run.tick(1801).completed).toBe(true);
    expect(run.tick(1802).completed).toBe(false);
    expect(run.events.filter(event => event.kind === "activity.cash")).toEqual([{ kind: "activity.cash", targetId: "coit-recon", amount: -25, detail: "viewer-quarter" }]);
    expect(run.events.filter(event => event.kind === "recon.viewerCompleted")).toHaveLength(1);
  });

  it("does not turn benign, protected, occluded, inactive, interrupted or unobserved behavior into a tag", () => {
    for (const patch of [{ firmware: "good" as const }, { protected: true }, { visible: false }, { active: false }, { behavior: "" }]) {
      const run = session(), context = { ...observed, actors: [{ ...observed.actors[0]!, ...patch }] };
      run.tick(1, [command("open", 1)], context);
      for (let tick = 2; tick <= 100; tick++) run.tick(tick, [], context);
      run.tick(101, [command("tag", 2)], context); expect(run.viewer!.taggedIds).toEqual([]);
    }
    const run = session(); run.tick(1, [command("open", 1)]);
    for (let tick = 2; tick <= 40; tick++) run.tick(tick);
    run.tick(41, [], { ...observed, actors: [] });
    run.tick(42, [command("tag", 2)]); expect(run.viewer!.taggedIds).toEqual([]);
  });

  it("retains a genuinely seen short attack while the same visible robot remains under observation", () => {
    const run = session(); run.tick(1, [command("open", 1)]);
    const afterAttack = { ...observed, actors: [{ ...observed.actors[0]!, behavior: "" }] };
    for (let tick = 2; tick <= 60; tick++) run.tick(tick, [], afterAttack);
    run.tick(61, [command("tag", 2)], afterAttack);
    expect(run.viewer!.taggedIds).toEqual(["real:bad"]);
    expect(run.events.find(event => event.kind === "coit.robotTagged")?.detail).toBe("forced-update");
  });

  it("enforces the five-second flag deadline even when audio is missing, skipped, or commands are replayed", () => {
    const run = session(); run.tick(1, [command("open", 1)]); run.tick(181);
    const first = structuredClone(run.viewer!.guide);
    run.tick(182, [command("skip", 2)]); run.tick(183, [command("flag", 3)]);
    run.tick(184, [command("flag", 3)]); expect(run.viewer!.flaggedIds).toHaveLength(1);
    expect(run.viewer!.guide!.flagUntilTick).toBe(first!.flagUntilTick);
    const late = session(); late.tick(1, [command("open", 1)]); late.tick(181); late.tick(482, [command("flag", 2)]);
    expect(late.viewer!.flaggedIds).toEqual([]); expect(late.tick(1801).completed).toBe(false);
  });

  it("refuses unaffordable, distant, moving and vehicle use without a charge; batched close/reopen cannot spend the same quarter twice", () => {
    for (const context of [{ ...observed, cashCents: 24 }, { ...observed, usable: false }]) {
      const run = session(); run.tick(1, [command("open", 1)], context); expect(run.events).toEqual([]);
    }
    for (const patch of [{ x: body.x + 4 }, { speed: 1 }, { mode: "vehicle" as const }]) {
      const run = session(); run.tick(1, [command("open", 1)], observed, { ...body, ...patch }); expect(run.events).toEqual([]);
    }
    const run = session(); run.tick(1, [command("open", 1), command("close", 2), command("open", 3)]);
    expect(run.events.filter(event => event.kind === "activity.cash")).toHaveLength(1); expect(run.viewer!.closed).toBe(true);
  });

  it("deduplicates failed opening commands in the producer and cannot complete from claimed relay/viewer facts", () => {
    const state = createActivities(1), run = startRecon();
    const context: GameplayContext = { ...DEFAULT_CATALOG, wave: 4, bodies: [body], actors: [], observations: [], facts: [], commands: [command("open", 1)], day: 1, month: 1,
      coit: { players: { p: { ...observed, cashCents: 24 } } } };
    expect(stepRecon(run, context, body, state)).toBe(0); expect(run.viewer).toBeUndefined();
    state.tick = 2; context.coit = { players: { p: observed } };
    expect(stepRecon(run, context, body, state)).toBe(0); expect(run.viewer).toBeUndefined();
    context.commands = [command("open", 2)]; state.tick = 3; stepRecon(run, context, body, state);
    expect(run.viewer?.startedTick).toBe(3);
    context.facts = [{ id: "spoof", source: "world", sequence: 1, tick: 4, kind: "recon.viewerCompleted", playerId: "p" }];
    context.commands = []; state.tick = 4; expect(stepRecon(run, context, body, state)).toBe(0);
  });

  it("uses the existing exactly-once activity economy grant path for the quarter", () => {
    const ctx: GameplayContext = { ...DEFAULT_CATALOG, wave: 4, bodies: [body], actors: [], observations: [], facts: [], commands: [], day: 1, month: 1 };
    const state = createEconomy(); state.players.p = { ...createWallet(), cashCents: 25 };
    const grant: GameplayEvent = { id: 1, tick: 1, kind: "activity.cash", playerId: "p", targetId: "coit-recon", amount: -25, detail: "viewer-quarter" };
    const paid = stepEconomy(state, ctx, 1, [], undefined, [], [grant]); expect(paid.players.p!.cashCents).toBe(0);
    expect(stepEconomy(paid, ctx, 2, [], undefined, [], [grant]).players.p!.cashCents).toBe(0);
    expect(state.players.p!.cashCents).toBe(25);
  });

  it("keeps aim bounded and adds exactly the recorded 120m anchor only for a live viewer", () => {
    const world = buildWorld([]), state = createInitialState(world, 1, ["p"], { ...COIT_VIEWER, heading: 0 }), run = session();
    run.tick(1, [command("open", 1)]);
    const viewer = run.viewer!, own = { nextDirectorTick: 9999, directorRng: [1, 2, 3, 4] as [number, number, number, number], activeCardId: "", cardUntilTick: 0,
      cardCooldowns: {}, activeActivityId: "coit-recon", activityStartedTick: 1, completedIds: [], commandSequence: 0, recon: { ...startRecon(), viewer } };
    state.ext.activities = { ...createActivities(), players: { p: own } }; state.tick = 1;
    const anchor = coitFidelityAnchors(state, world)[0]!, pose = coitCameraPose(world, viewer);
    expect(anchor).toEqual({ id: "coit:p", ownerId: "p", x: pose.aim.x, z: pose.aim.z, radiusM: 120 });
    expect(coitAngles(0, 99)).toEqual({ yaw: COIT_VIEW.yawMin, pitch: COIT_VIEW.pitchMax });
    expect(coitAngles(Math.PI, -99).pitch).toBe(COIT_VIEW.pitchMin);
    expect(Math.hypot(anchor.x - COIT_VIEWER.x, anchor.z - COIT_VIEWER.z)).toBeLessThanOrEqual(COIT_VIEW.maxRangeM + .001);
    const clone = cloneCoitViewer(viewer)!; clone.taggedIds.push("changed"); expect(viewer.taggedIds).toEqual([]);
    state.tick = viewer.untilTick; expect(coitFidelityAnchors(state, world)).toEqual([]); expect(coitSessionActive(viewer, state.tick)).toBe(false);
    expect(JSON.parse(JSON.stringify(viewer))).toEqual(viewer);
  });

  it("elevated sight passes over low roofs but refuses actual tall buildings and terrain ridges", () => {
    const building = { id: "roof", footprint: [[-5, -55], [5, -55], [5, -45], [-5, -45]] as [number, number][], baseY: 0, topY: 10 };
    const low = buildWorld([{ tileId: "low", buildings: [building], ground: null }]);
    const tall = buildWorld([{ tileId: "tall", buildings: [{ ...building, topY: 100 }], ground: null }]);
    const a = { x: 0, y: 80, z: 0 }, b = { x: 0, y: 1, z: -100 };
    expect(coitLineOfSight(low, a, b)).toBe(true); expect(coitLineOfSight(tall, a, b)).toBe(false);
    const ridge = buildWorld([{ tileId: "ridge", buildings: [], ground: { x0: 0, z0: -100, cellSizeM: 50, nx: 2, nz: 3, heights: [0, 0, 100, 100, 0, 0] } }]);
    expect(coitLineOfSight(ridge, { ...a, x: 10 }, { ...b, x: 10 })).toBe(false);
  });

  it("projects actual in-cone runtime behavior and excludes protected bodies, out-of-cone actors and idle behavior", () => {
    const world = buildWorld([]), state = createInitialState(world, 7, ["p"], { ...COIT_VIEWER, heading: 0 }), run = session();
    run.tick(1, [command("open", 1)]);
    const viewer = { ...run.viewer!, pitch: -.015 };
    state.ext.activities = { ...createActivities(), players: { p: { nextDirectorTick: 9999, directorRng: [1, 2, 3, 4], activeCardId: "", cardUntilTick: 0,
      cardCooldowns: {}, activeActivityId: "coit-recon", activityStartedTick: 1, completedIds: [], commandSequence: 0, recon: { ...startRecon(), viewer } } } };
    state.ext.robots = createAgentsRuntime(state, { spawns: [{ id: "real:bad", numericId: 1, model: "footman", firmware: "bad", x: COIT_VIEWER.x, y: 0, z: COIT_VIEWER.z + 40, heading: 0, height: 1.6, radius: .4 }] });
    state.ext.combat = createCombatState(7, { actors: [], players: [], walls: [], refills: [] });
    state.ext.combat.attacks = [{ id: "actual:windup", attackerId: "real:bad", targetId: "other:robot", kind: "forced-update", startTick: 1, resolveTick: 61, endTick: 61, presses: 0, active: false }];
    state.tick = 10;
    expect(coitPlayerContext(state, world, "p").actors).toEqual([{ id: "real:bad", behavior: "forced-update", visible: true, firmware: "bad", protected: false, active: true }]);
    state.ext.robots.actors["real:bad"]!.protected = true; expect(coitPlayerContext(state, world, "p").actors).toEqual([]);
    state.ext.robots.actors["real:bad"]!.protected = false; state.ext.combat.attacks = [];
    expect(coitPlayerContext(state, world, "p").actors[0]!.behavior).toBe("");
    expect(coitPlayerContext(state, world, "p", { aimYaw: COIT_VIEW.yawMin }).actors).toEqual([]);
  });

  it("settles the full routed viewer activity exactly once and retains its authored cooldown", () => {
    const definition = ACTIVITY_DEFINITIONS.find(activity => activity.id === "coit-recon")!;
    const checkpoints = definition.checkpoints.map(point => ({ ...toLocal(point.lat, point.lon), id: point.id, y: 0, radius: point.radiusM }));
    const activity: ActivityDefinition = { ...checkpoints[0]!, id: definition.id, kind: definition.kind, wave: definition.wave, radius: checkpoints[0]!.radius,
      checkpoints, objective: definition.objective, timeLimitS: definition.timeLimitS, rewardCents: definition.reward.cashCents, rewardXp: definition.reward.xp, repeatable: true, cooldownS: definition.cooldownS };
    const missions = createMissions(), context: GameplayContext = { ...DEFAULT_CATALOG, activities: [activity], wave: 4, bodies: [{ ...body, ...checkpoints[0]!, id: "p" }],
      actors: [], observations: [], facts: [], commands: [{ playerId: "p", sequence: 1, kind: "activity-start", targetId: "coit-recon" }], day: 1, month: 1, coit: { players: { p: observed } } };
    let state = stepActivities(createActivities(), context, 1, missions, 7, 21);
    const events: GameplayEvent[] = [];
    context.bodies = [body]; context.commands = [];
    for (let tick = 2; tick <= 1804; tick++) {
      context.commands = tick === 3 ? [command("open", 2)] : tick === 63 ? [command("tag", 3)] : tick === 184 ? [command("flag", 4)] : [];
      state = stepActivities(state, context, tick, missions, 7, 21); events.push(...state.events);
    }
    expect(events.filter(event => event.kind === "activity.cash").map(event => event.amount)).toEqual([-25, definition.reward.cashCents]);
    expect(events.filter(event => event.kind === "activity.xp").map(event => event.amount)).toEqual([definition.reward.xp]);
    expect(events.filter(event => event.kind === "activity.finished")).toHaveLength(1);
    expect(state.players.p!.completedIds).toEqual(["coit-recon"]); expect(state.players.p!.activeActivityId).toBe("");
    expect(state.players.p!.cooldowns!["coit-recon"]).toBe(1803 + (definition.cooldownS ?? 0) * 60);
  });

  it("accepts only the normal recorded command shape; aim remains in recorded inputs", () => {
    const event = { kind: "gameplay.command", playerId: "p", tick: 1, payload: { sequence: 1, kind: "coit-viewer", targetId: "coit-recon", choiceId: "open" } };
    expect(gameplayCommandFromEvent(event)).toEqual(command("open", 1));
    expect(gameplayCommandFromEvent({ ...event, payload: { ...event.payload, aimYaw: 2 } })).toBeNull();
    expect(gameplayCommandFromEvent({ ...event, payload: { ...event.payload, itemId: "claimed:robot" } })).toBeNull();
    expect(gameplayCommandFromEvent({ ...event, payload: { ...event.payload, choiceId: "complete" } })).toBeNull();
  });
});
