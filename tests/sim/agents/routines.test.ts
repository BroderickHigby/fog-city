import { describe, expect, it } from "vitest";
import {
  allocateSwarm, associateApproach, conferenceDensity, createBoxInState, createCalendarRoutines,
  createDroneState, createRecruitState, createRobotBodyState, createTheftState, createTidyState,
  parrotFlock, patrolTerms, signSpinnerPose, stepBoxIn, stepCalendarRoutines, stepDrone,
  stepRecruits, stepRobotBody, stepTheft, stepTidy,
  type CalendarRoutineInput, type RoutineActor, type TheftCar,
} from "../../../src/sim/agents/routines.ts";

function actor(id = "a", extra: Partial<RoutineActor> = {}): RoutineActor {
  return { id, kind: "robot", x: 0, y: 0, z: 0, heading: 0, speed: 0, operational: true, firmware: "bad", ...extra };
}
const player = actor("p", { kind: "player", firmware: "none" });
const origin = { x: 0, y: 0, z: 0 };
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) frozen(item);
  }
  return value;
}

describe("clock-driven routines", () => {
  const actors: CalendarRoutineInput["actors"] = [
    { ...actor("good", { firmware: "good" }), model: "footman", district: "north-beach" },
    { ...actor("bad"), model: "footman", district: "north-beach" },
    { ...actor("person", { kind: "person", firmware: "none" }), model: "person", district: "north-beach" },
    { ...actor("remote", { firmware: "good" }), model: "footman", district: "soma" },
  ];
  it("freezes only operational good robots in the selected district and does not retrigger", () => {
    const before = stepCalendarRoutines(createCalendarRoutines(), { tick: 0, gameSecond: 10799, actors });
    const start = stepCalendarRoutines(before.state, { tick: 1, gameSecond: 10800, actors });
    expect(start.events).toEqual([{ id: "firmware:0", kind: "firmware-freeze" }]);
    expect(start.holds.map(x => x.actorId)).toEqual(["good"]);
    const later = stepCalendarRoutines(start.state, { tick: 601, gameSecond: 10810, actors });
    expect(later.events).toEqual([]);
    expect(later.holds.map(x => x.actorId)).toEqual(["good"]);
    expect(stepCalendarRoutines(later.state, { tick: 1201, gameSecond: 10820, actors }).holds).toEqual([]);
  });
  it("pulls robotaxis over at Tuesday noon once per week without stopping every vehicle", () => {
    const cars = [
      { ...actor("taxi", { kind: "vehicle" }), model: "robotaxi", district: "soma" },
      { ...actor("bus", { kind: "vehicle" }), model: "bus", district: "soma" },
    ];
    const before = stepCalendarRoutines(createCalendarRoutines(), { tick: 1, gameSecond: 129599, actors: cars });
    const event = stepCalendarRoutines(before.state, { tick: 2, gameSecond: 129600, actors: cars });
    expect(event.holds).toEqual([{ actorId: "taxi", untilTick: 3602, reason: "siren" }]);
    expect(stepCalendarRoutines(event.state, { tick: 3, gameSecond: 129601, actors: cars }).events).toEqual([]);
  });
  it("does not replay ancient missed windows after a long game-clock jump", () => {
    expect(stepCalendarRoutines(createCalendarRoutines(), { tick: 1, gameSecond: 50000, actors }).events).toEqual([]);
    expect(() => stepCalendarRoutines(createCalendarRoutines(), { tick: 1, gameSecond: NaN, actors })).toThrow();
  });
  it("applies conference density only on its week, site and unprotected area", () => {
    expect(conferenceDensity(2, true, 600, false)).toEqual({ badRateMultiplier: 1.5, lanyardCrowd: true });
    for (const [week, soma, distance, protectedArea] of [[1, true, 30, false], [2, false, 30, false], [2, true, 601, false], [2, true, 30, true]] as const) {
      expect(conferenceDensity(week, soma, distance, protectedArea).badRateMultiplier).toBe(1);
    }
  });
});

describe("flying, swarm and approach policies", () => {
  it("holds the drone six metres above ground and only updates memory from visible valid targets", () => {
    const first = stepDrone(createDroneState(), { tick: 0, self: actor(), groundY: 20, observedTarget: { ...player, x: 4, lineOfSight: true } });
    expect(first.motion.target).toEqual({ x: 4, y: 26, z: 0 });
    expect(first.blast).toEqual({ targetId: "p", sequence: 0 });
    const hidden = stepDrone(first.state, { tick: 1, self: actor(), groundY: 20, observedTarget: { ...player, x: 900, lineOfSight: false } });
    expect(hidden.state.lastSeen?.x).toBe(4);
    expect(hidden.blast).toBeNull();
    const expired = stepDrone(hidden.state, { tick: 601, self: actor(), groundY: 20, observedTarget: null });
    expect(expired.state.targetId).toBeNull();
    expect(expired.motion.target.y).toBe(26);
    expect(stepDrone(createDroneState(), { tick: 0, self: actor(), groundY: 0, observedTarget: { ...actor("human", { kind: "person" }), lineOfSight: true } }).blast).toBeNull();
  });
  it("caps the converging swarm at eight and melee at two, excluding people and distant robots", () => {
    const units = Array.from({ length: 12 }, (_, i) => actor(String(i).padStart(2, "0"), { x: i }));
    const result = allocateSwarm([...units.reverse(), actor("human", { kind: "person" }), actor("far", { x: 121 })], player, 4);
    expect(result.map(x => x.id)).toEqual(["00", "01", "02", "03", "04", "05", "06", "07"]);
    expect(result.filter(x => x.role === "melee")).toHaveLength(2);
    expect(allocateSwarm(units, player, 3)).toEqual([]);
    expect(() => allocateSwarm([actor("same"), actor("same", { x: 50 })], player, 4)).toThrow(/duplicate/);
  });
  it("telegraphs box-in for two seconds, and cancels if the target is on foot", () => {
    const target = { ...actor("car", { kind: "vehicle", x: 10 }), occupiedByTarget: true, lineOfSight: true };
    const first = stepBoxIn(createBoxInState(), { tick: 0, self: actor(), target, reachedGoal: false });
    expect(first.motion.kind).toBe("hold");
    const ready = stepBoxIn(first.state, { tick: 120, self: actor(), target, reachedGoal: false });
    expect(ready.motion).toMatchObject({ kind: "route", reason: "box-in" });
    expect(stepBoxIn(ready.state, { tick: 121, self: actor(), target: { ...target, kind: "player" }, reachedGoal: false }).state.phase).toBe("idle");
  });
  it("Patrol never addresses a bystander and associates use only observed founder positions", () => {
    expect(patrolTerms(actor(), [{ ...actor("human", { kind: "person" }), lineOfSight: true }])).toBeNull();
    expect(patrolTerms(actor(), [{ ...player, x: 2, lineOfSight: true }])).toEqual({ targetId: "p", contentKey: "patrol.terms-of-service" });
    expect(associateApproach(actor("associate", { kind: "person" }), { ...player, x: 10, lineOfSight: false }, true).kind).toBe("hold");
    expect(associateApproach(actor("associate", { kind: "person" }), { ...player, x: 10, lineOfSight: true }, true).reason).toBe("pull-alongside");
    expect(signSpinnerPose(7, 100)).toEqual(signSpinnerPose(7, 100));
  });
});

describe("empty parked-car theft", () => {
  const car: TheftCar = { id: "car", ownerId: "p", ...origin, occupied: false, parked: true, speed: 0 };
  const base = { self: actor("thief"), car, owner: { x: 31, y: 0, z: 0 }, depot: { x: 100, y: 0, z: 0 }, claimAck: null, atDepot: false, stoppedByCone: false, thiefDisabled: false, recoveredByOwner: false };
  it("requires an empty distant parked car, continuous windup and an actual claim acknowledgement", () => {
    expect(stepTheft(createTheftState(), { ...base, tick: 0, car: { ...car, occupied: true } }).state.phase).toBe("idle");
    expect(stepTheft(createTheftState(), { ...base, tick: 0, owner: { x: 30, y: 0, z: 0 } }).state.phase).toBe("idle");
    const started = stepTheft(createTheftState(), { ...base, tick: 0 });
    expect(started.state.phase).toBe("windup");
    expect(stepTheft(started.state, { ...base, tick: 179 }).intents).toEqual([]);
    const claim = stepTheft(started.state, { ...base, tick: 180 });
    expect(claim.intents).toEqual([{ kind: "claim-empty-car", carId: "car", sequence: 1 }]);
    expect(stepTheft(claim.state, { ...base, tick: 181 }).state.phase).toBe("claim");
    const drive = stepTheft(claim.state, { ...base, tick: 181, claimAck: { carId: "car", sequence: 1, tick: 181 }, car: { ...car, occupied: true, driverId: "thief" } });
    expect(drive.intents.some(x => x.kind === "drive-stolen-car")).toBe(true);
    expect(stepTheft(drive.state, { ...base, tick: 182, car: { ...car, occupied: true, driverId: "p" } }).state.phase).toBe("aborted");
  });
  it("does not fake arrival and releases a coned car only once", () => {
    let state = stepTheft(createTheftState(), { ...base, tick: 0 }).state;
    state = stepTheft(state, { ...base, tick: 180 }).state;
    state = stepTheft(state, { ...base, tick: 181, claimAck: { carId: "car", sequence: 1, tick: 181 } }).state;
    expect(stepTheft(state, { ...base, tick: 5000, atDepot: true }).state.phase).toBe("driving");
    const stopped = stepTheft(state, { ...base, tick: 5001, stoppedByCone: true });
    expect(stopped.state.phase).toBe("recoverable");
    expect(stopped.intents.filter(x => x.kind === "release-car")).toHaveLength(1);
    expect(stepTheft(stopped.state, { ...base, tick: 5002, stoppedByCone: true }).intents.some(x => x.kind === "release-car")).toBe(false);
  });
  it("revalidates a delayed empty-car claim when its owner returns or the car starts moving", () => {
    let state = stepTheft(createTheftState(), { ...base, tick: 0 }).state;
    state = stepTheft(state, { ...base, tick: 180 }).state;
    const claimAck = { carId: "car", sequence: 1, tick: 181 };
    expect(stepTheft(state, { ...base, tick: 190, claimAck, owner: origin }).state.phase).toBe("aborted");
    expect(stepTheft(state, { ...base, tick: 190, claimAck, car: { ...car, parked: false, speed: 1 } }).state.phase).toBe("aborted");
    expect(stepTheft(state, { ...base, tick: 190, claimAck, self: { ...base.self, operational: false } }).state.phase).toBe("aborted");
  });
});

describe("Tidy carries and restores observed heaps", () => {
  const heap = { id: "heap", ...origin, present: true, converted: true };
  const kiosk = { id: "kiosk", x: 20, y: 0, z: 0 };
  const base = { self: actor("tidy", { firmware: "good" }), heaps: [heap], kiosks: [kiosk], carryingHeapId: null, restoredAck: null };
  it("requires attachment, actual kiosk arrival, 60 seconds and an acknowledgement", () => {
    const collected = stepTidy(createTidyState(), { ...base, tick: 0 });
    expect(collected.state.phase).toBe("attach");
    expect(collected.intents.some(x => x.kind === "attach-heap")).toBe(true);
    expect(stepTidy(collected.state, { ...base, tick: 1 }).intents.some(x => x.kind === "attach-heap")).toBe(false);
    const haul = stepTidy(collected.state, { ...base, tick: 2, carryingHeapId: "heap" });
    expect(haul.state.phase).toBe("haul");
    expect(haul.intents[0]).toMatchObject({ kind: "motion", motion: { reason: "haul-to-kiosk" } });
    const arrived = stepTidy(haul.state, { ...base, tick: 3, self: { ...base.self, x: 20 }, carryingHeapId: "heap" });
    expect(arrived.state.phase).toBe("reboot");
    const atKiosk = { ...base, self: { ...base.self, x: 20 }, carryingHeapId: "heap" };
    expect(stepTidy(arrived.state, { ...atKiosk, tick: 3602 }).state.phase).toBe("reboot");
    const restore = stepTidy(arrived.state, { ...atKiosk, tick: 3603 });
    expect(restore.intents.filter(x => x.kind === "restore-good")).toEqual([{ kind: "restore-good", heapId: "heap", sequence: 1 }]);
    expect(stepTidy(restore.state, { ...atKiosk, tick: 3604 }).intents.some(x => x.kind === "restore-good")).toBe(false);
    const acknowledged = stepTidy(restore.state, { ...atKiosk, tick: 3605, restoredAck: { heapId: "heap", sequence: 1 } });
    expect(acknowledged.state.phase).toBe("complete");
    expect(stepTidy(acknowledged.state, { ...atKiosk, tick: 3606 }).intents.some(x => x.kind === "attach-heap")).toBe(false);
    expect(stepTidy(restore.state, { ...atKiosk, tick: 3605, heaps: [], restoredAck: { heapId: "heap", sequence: 1 } }).state.completedHeapIds).toEqual(["heap"]);
  });
  it("chooses the nearest actual kiosk deterministically and never restores while away", () => {
    const result = stepTidy(createTidyState(), { ...base, tick: 0, kiosks: [kiosk, { ...kiosk, id: "closer", x: 3 }] });
    expect(result.state.kioskId).toBe("closer");
    const detached = stepTidy({ ...result.state, phase: "reboot", rebootStartTick: 0 }, { ...base, tick: 10000 });
    expect(detached.intents.some(x => x.kind === "restore-good")).toBe(false);
  });
});

describe("recruits and robot-body controls", () => {
  const candidate = (id: string, x = 0) => ({ ...actor(id, { firmware: "good", x }), interruptedUpdate: true, accepted: true });
  const observed = (id: string, x = 0) => ({ ...actor(id, { firmware: "good", x }), boarded: false, melted: false, restored: false });
  const base = { owner: player, reputation: 60, candidates: [candidate("a")], observations: [observed("a")], visibleBadRobots: [], seatCapacity: 3, ownerInVehicle: false };
  it("accepts at most three eligible robots and respects the reputation gate", () => {
    expect(stepRecruits(createRecruitState(), { ...base, tick: 0, reputation: 59 }).state.roster).toEqual([]);
    const accepted = stepRecruits(createRecruitState(), { ...base, tick: 0, candidates: [candidate("d"), candidate("c"), candidate("a"), candidate("b")] });
    expect(accepted.state.roster.map(r => r.id)).toEqual(["a", "b", "c"]);
    expect(accepted.intents.some(x => x.kind === "board")).toBe(false);
  });
  it("spots only visible bad robots within 20m, once per 30 seconds", () => {
    const input = { ...base, tick: 0, visibleBadRobots: [{ ...actor("bad", { x: 20 }), lineOfSight: true }] };
    const first = stepRecruits(createRecruitState(), input);
    expect(first.intents.filter(x => x.kind === "spot")).toHaveLength(1);
    expect(stepRecruits(first.state, { ...input, tick: 1799 }).intents.some(x => x.kind === "spot")).toBe(false);
    expect(stepRecruits(first.state, { ...input, tick: 1800 }).intents.some(x => x.kind === "spot")).toBe(true);
  });
  it("uses a fresh boarding generation after a recruit leaves and boards again", () => {
    const first = stepRecruits(createRecruitState(), { ...base, tick: 0, ownerInVehicle: true });
    expect(first.intents.filter(x => x.kind === "board")).toEqual([{ kind: "board", actorId: "a", sequence: 1 }]);
    const waiting = stepRecruits(first.state, { ...base, tick: 1, ownerInVehicle: true });
    expect(waiting.intents.some(x => x.kind === "board")).toBe(false);
    const riding = stepRecruits(waiting.state, { ...base, tick: 2, ownerInVehicle: true, observations: [{ ...observed("a"), boarded: true, boardedSequence: 1 }] });
    expect(riding.state.roster[0]?.phase).toBe("ride");
    const left = stepRecruits(riding.state, { ...base, tick: 3 });
    const again = stepRecruits(left.state, { ...base, tick: 4, ownerInVehicle: true });
    expect(again.intents.filter(x => x.kind === "board")).toEqual([{ kind: "board", actorId: "a", sequence: 2 }]);
    expect(() => stepRecruits(first.state, { ...base, tick: 2, observations: [observed("a"), observed("a", 500)] })).toThrow(/duplicate/);
  });
  it("requests a distant taxi only once and restores a converted recruit only after melt", () => {
    const accepted = stepRecruits(createRecruitState(), { ...base, tick: 0 });
    const distant = stepRecruits(accepted.state, { ...base, tick: 1, observations: [observed("a", 301)] });
    expect(distant.intents.some(x => x.kind === "hail-taxi")).toBe(true);
    expect(stepRecruits(distant.state, { ...base, tick: 2, observations: [observed("a", 301)] }).intents.some(x => x.kind === "hail-taxi")).toBe(false);
    const converted = stepRecruits(distant.state, { ...base, tick: 3, observations: [{ ...observed("a"), firmware: "bad" }] });
    expect(converted.state.roster[0]?.phase).toBe("converted");
    expect(converted.intents.some(x => x.kind === "restore-at-safehouse")).toBe(false);
    expect(stepRecruits(converted.state, { ...base, tick: 4, observations: [{ ...observed("a"), firmware: "bad", melted: true }] }).intents.some(x => x.kind === "restore-at-safehouse")).toBe(true);
  });
  it("normalizes robot movement, bounds bursts and emits visible tells", () => {
    const input = { tick: 0, self: origin, moveX: 1, moveZ: 1, burst: false, emote: "carry-bag" as const, melted: false, respawnCoverageComplete: false, respawnCandidates: [], spotters: [], rebindAck: null };
    const walking = stepRobotBody(createRobotBodyState(), input);
    expect(Math.sqrt(walking.vx ** 2 + walking.vz ** 2)).toBeCloseTo(1.6);
    const burst = stepRobotBody(walking.state, { ...input, tick: 1, burst: true });
    expect(Math.sqrt(burst.vx ** 2 + burst.vz ** 2)).toBeCloseTo(3);
    expect(burst.tells).toContain("battery-overdraw");
    const held = stepRobotBody(burst.state, { ...input, tick: 121, burst: true });
    expect(Math.sqrt(held.vx ** 2 + held.vz ** 2)).toBeCloseTo(1.6);
    expect(held.tells).not.toContain("battery-overdraw");
  });
  it("waits ten seconds and current complete clearance before rebind", () => {
    const input = { tick: 0, self: origin, moveX: 0, moveZ: 0, burst: false, emote: "none" as const, melted: true, respawnCoverageComplete: true, respawnCandidates: [{ id: "safe", x: 150, y: 0, z: 0, peopleFree: true }], spotters: [origin], rebindAck: null };
    const disconnected = stepRobotBody(createRobotBodyState(), input);
    expect(stepRobotBody(disconnected.state, { ...input, tick: 599 }).rebind).toBeNull();
    const ready = stepRobotBody(disconnected.state, { ...input, tick: 600 });
    expect(ready.rebind).toEqual({ generation: 1, at: { x: 150, y: 0, z: 0 } });
    const unsafe = stepRobotBody(ready.state, { ...input, tick: 601, spotters: [{ x: 1, y: 0, z: 0 }], rebindAck: { generation: 1, tick: 601, at: { x: 150, y: 0, z: 0 } } });
    expect(unsafe.state.disconnectedTick).toBe(0);
    expect(unsafe.rebind).toBeNull();
    const fakePose = stepRobotBody(ready.state, { ...input, tick: 601, melted: false, rebindAck: { generation: 1, tick: 601, at: { x: 150, y: 0, z: 0 } } });
    expect(fakePose.state.disconnectedTick).toBe(0);
    const rebound = stepRobotBody(ready.state, { ...input, tick: 601, self: { x: 150, y: 0, z: 0 }, melted: false, rebindAck: { generation: 1, tick: 601, at: { x: 150, y: 0, z: 0 } } });
    expect(rebound.state.generation).toBe(1);
    expect(rebound.state.disconnectedTick).toBe(-1);
  });
  it("has deterministic bounded flock geometry and rejects invalid numbers", () => {
    const birds = parrotFlock(13, 1200, origin, 32);
    expect(birds).toEqual(parrotFlock(13, 1200, origin, 32));
    expect(new Set(birds.map(b => b.id)).size).toBe(32);
    expect(birds.every(b => Number.isFinite(b.goal.x) && b.goal.y >= 5 && b.goal.y <= 7)).toBe(true);
    expect(() => parrotFlock(13, 1, origin, 33)).toThrow();
    expect(() => stepDrone(createDroneState(), { tick: 0, self: actor(), groundY: NaN, observedTarget: null })).toThrow();
  });
  it("keeps input snapshots immutable and output plain JSON", () => {
    const state = frozen(createRecruitState());
    const input = frozen({ ...base, tick: 0 });
    const expected = JSON.stringify({ state, input });
    const output = stepRecruits(state, input);
    expect(JSON.stringify({ state, input })).toBe(expected);
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
  });
});
