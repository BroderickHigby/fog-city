import { describe, expect, it } from "vitest";
import { MISSIONS } from "../../../src/content/catalog.ts";
import { canStartActivity, createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { calendarAt, DAY_TICKS } from "../../../src/sim/clock/calendar.ts";
import { createHeat } from "../../../src/sim/heat/system.ts";
import { createMissionProgress, createMissions, stepMissions } from "../../../src/sim/missions/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { createPlayer } from "../../../src/sim/player/system.ts";
import type { ActivitiesState, GameplayContext, MissionState, PlayerActivities } from "../../../src/sim/player/types.ts";

const door = DEFAULT_CATALOG.activities.find(activity => activity.id === "office-hours")!;
const completed = ["hot-desk", "spill", "launch-day", "demoed-correctly"];
const rewarded = ["hot-desk:complete", "spill:complete", "launch-day:complete", "demoed-correctly:term-sheet"];
const pending = MISSIONS.find(mission => mission.id === "demo-day")!;

function context(patch: Partial<GameplayContext> = {}): GameplayContext {
  return { ...DEFAULT_CATALOG, wave: 4, bodies: [{ id: "p", x: door.x, y: 0, z: door.z, mode: "foot", speed: 0 }],
    directorCards: [], observations: [], actors: [], facts: [], commands: [], day: 42, month: 2, ...patch };
}

function missions(waiting = false): MissionState {
  return { ...createMissions(), players: { p: { ...createMissionProgress(), status: waiting ? "active" : "complete",
    missionId: waiting ? pending.id : "demoed-correctly", stepId: waiting ? pending.start! : "term-sheet",
    completedIds: [...completed], rewardedIds: [...rewarded], startedTick: 1, stepStartedTick: 1 } } };
}

/** A settled-booking fixture; no mission completion or reward is claimed by these booking tests. */
function available(bookings?: PlayerActivities["officeHoursBookings"], cooldown = 0): ActivitiesState {
  const state = stepActivities(createActivities(), context(), 1, missions(), 7, 27);
  const own = state.players.p!;
  return { ...state, players: { p: { ...own, cooldowns: { "office-hours": cooldown },
    ...(bookings ? { officeHoursBookings: { ...bookings } } : {}) } } };
}

function book(state: ActivitiesState, tick: number, patch: Partial<GameplayContext> = {}, progress = missions()): ActivitiesState {
  const sequence = (state.players.p?.commandSequence ?? 0) + 1;
  return stepActivities(state, context({ ...patch, commands: [{ playerId: "p", sequence, kind: "activity-start", targetId: door.id }] }), tick, progress, 7, 27);
}

describe("Office Hours booking boundaries", () => {
  it("starts the real interview beside an armed campaign without changing completed missions or reward ledgers", () => {
    const waiting = missions(true), first = pending.steps.find(step => step.id === pending.start)!;
    expect(first).toMatchObject({ type: "trigger", event: { kind: "enterArea" } });
    const booked = book(available(), 100, {}, waiting);
    expect(booked.players.p!.activeActivityId).toBe("office-hours");
    expect(booked.players.p!.officeHoursBookings).toEqual({ day: 42, count: 1 });
    const started = stepMissions(waiting, context(), 101, createHeat(), createPlayer(), 7, booked);
    expect(started.players.p).toMatchObject({ missionId: "office-hours", stepId: "pitch-philosopher", status: "active" });
    expect(started.players.p!.completedIds).toEqual(completed);
    expect(started.players.p!.rewardedIds).toEqual(rewarded);
    expect(started.events.some(event => event.kind.startsWith("mission.") && ["mission.cash", "mission.xp", "mission.finished"].includes(event.kind))).toBe(false);
    expect(waiting.players.p).toMatchObject({ missionId: pending.id, stepId: pending.start, completedIds: completed, rewardedIds: rewarded });
  });

  it("restores the pending campaign guidance after the interview reward settles",()=>{
    const waiting=missions(true),booked=book(available(),100,{},waiting);
    const started=stepMissions(waiting,context(),101,createHeat(),createPlayer(),7,booked);
    expect(started.players.p!.pendingCampaignId).toBe(pending.id);
    const reward=MISSIONS.find(m=>m.id==="office-hours")!.steps.find(step=>step.type==="reward"&&step.outcome==="termSheet")!;
    const settling={...started,players:{p:{...started.players.p!,stepId:reward.id}}};
    const after=stepMissions(settling,context(),500,createHeat(),createPlayer(),7,booked);
    expect(after.players.p).toMatchObject({missionId:pending.id,status:"active",stepId:pending.start});
    expect(after.players.p!.pendingCampaignId).toBeUndefined();
    expect(after.events.some(event=>event.kind==="mission.finished"&&event.targetId==="office-hours")).toBe(true);
    expect(after.players.p!.rewardedIds).toContainEqual(expect.stringMatching(/^office-hours:/));
    expect(after.players.p!.completedIds).toEqual(expect.arrayContaining(completed));
  });

  it("accepts the second booking and refuses a third on the same absolute game day", () => {
    const before = available({ day: 42, count: 1 });
    expect(canStartActivity(door, before.players.p!, door, 100, 4, completed, 42)).toBe(true);
    const second = book(before, 100);
    expect(second.players.p!.officeHoursBookings).toEqual({ day: 42, count: 2 });
    expect(second.events.filter(event => event.kind === "activity.started")).toHaveLength(1);
    expect(before.players.p!.officeHoursBookings).toEqual({ day: 42, count: 1 });
    const settled = available(second.players.p!.officeHoursBookings);
    expect(canStartActivity(door, settled.players.p!, door, 200, 4, completed, 42)).toBe(false);
    const refused = book(settled, 200);
    expect(refused.players.p!.activeActivityId).toBe("");
    expect(refused.players.p!.officeHoursBookings).toEqual({ day: 42, count: 2 });
    expect(refused.events.some(event => event.kind === "activity.started")).toBe(false);
  });

  it("opens another day's allowance without mistaking the same calendar day in another month", () => {
    const epoch = { year: 2031, month: 1, day: 10, hour: 0 };
    const first = calendarAt(7, 0, epoch), later = calendarAt(7, 31 * DAY_TICKS, epoch);
    expect(later.day).toBe(first.day);
    expect(later.month).not.toBe(first.month);
    const before = available({ day: first.dayIndex, count: 2 });
    const next = book(before, 100, { day: later.dayIndex, month: later.month });
    expect(next.players.p!.activeActivityId).toBe("office-hours");
    expect(next.players.p!.officeHoursBookings).toEqual({ day: later.dayIndex, count: 1 });
    expect(before.players.p!.officeHoursBookings).toEqual({ day: first.dayIndex, count: 2 });
  });

  it("keeps the cooldown across midnight and consumes no allowance for an early request", () => {
    const before = available({ day: 41, count: 2 }, 500);
    expect(canStartActivity(door, before.players.p!, door, 499, 4, completed, 42)).toBe(false);
    const refused = book(before, 499, { day: 42 });
    expect(refused.players.p!.activeActivityId).toBe("");
    expect(refused.players.p!.officeHoursBookings).toEqual({ day: 41, count: 2 });
    const accepted = book(refused, 500, { day: 42 });
    expect(accepted.players.p!.activeActivityId).toBe("office-hours");
    expect(accepted.players.p!.officeHoursBookings).toEqual({ day: 42, count: 1 });
  });

  it("does not consume an allowance for an out-of-range, locked, or engaged-campaign request", () => {
    const before = available({ day: 42, count: 1 });
    const body = context().bodies[0]!;
    const far = book(before, 100, { bodies: [{ ...body, x: body.x + door.radius + 1 }] });
    const locked = missions(); locked.players.p!.completedIds = completed.slice(0, -1);
    const notUnlocked = book(before, 100, {}, locked);
    const engaged = missions(true); engaged.players.p!.stepId = "stage";
    const busy = book(before, 100, {}, engaged);
    for (const result of [far, notUnlocked, busy]) {
      expect(result.players.p!.activeActivityId).toBe("");
      expect(result.players.p!.officeHoursBookings).toEqual({ day: 42, count: 1 });
      expect(result.events.some(event => event.kind === "activity.started")).toBe(false);
    }
  });

  it("does not spend another booking when Start is pressed again during the same run", () => {
    const first = book(available(), 100);
    const duplicate = book(first, 101);
    expect(duplicate.players.p!.activeActivityId).toBe("office-hours");
    expect(duplicate.players.p!.officeHoursBookings).toEqual({ day: 42, count: 1 });
    expect(duplicate.events.some(event => event.kind === "activity.started")).toBe(false);
  });
});
