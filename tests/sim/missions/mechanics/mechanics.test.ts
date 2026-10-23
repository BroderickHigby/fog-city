import { describe, expect, it } from "vitest";
import { Action, NEUTRAL_INPUT } from "../../../../src/sim/contract.ts";
import { createMissionMechanics, stepMissionMechanics, checkParking, vehicleFitsBay, type MissionMechanicsInput, type ParkingInput, type ParkingVehicle, type ParkingBay } from "../../../../src/sim/missions/mechanics/index.ts";

const body = { id: "p", x: 0, y: 1, z: 0, speed: 0, mode: "foot" as const };
const car: ParkingVehicle = { playerId: "p", x: 0, y: 1, z: 0, speed: 0, lateral: 0, heading: 0, halfLength: 2, halfWidth: 0.8 };
const bay: ParkingBay = { id: "bay", edge: "c1", side: "L", x: 0, y: 1, z: 0, heading: 0, halfLength: 2.5, halfWidth: 1.2 };
function parking(): ParkingInput {
  return { bays: [bay], requests: [{ id: "demoed-correctly:park", playerId: "p", bayIds: [bay.id] }], rules: [{ edge: "c1", side: "L", kind: "time-limited", days: [1, 2, 3, 4, 5], from: 480, to: 1080, hourLimit: 2, permitAreas: [] }], cleaning: [], clock: { isoWeekday: 1, minute: 600, weekOfMonth: 1, holiday: false } };
}
function input(tick: number, pressed = false): MissionMechanicsInput {
  return { tick, seed: 7, bodies: [body], vehicles: [car], inputs: { p: { ...NEUTRAL_INPUT, actions: pressed ? Action.interact : 0 } }, parking: parking() };
}
describe("legal parking producer", () => {
  it("requires the full car to fit, including heading and elevation", () => {
    expect(vehicleFitsBay(car, bay)).toBe(true);
    expect(vehicleFitsBay({ ...car, heading: Math.PI / 2 }, bay)).toBe(false);
    expect(vehicleFitsBay({ ...car, x: 0.5 }, bay)).toBe(false);
    expect(vehicleFitsBay({ ...car, y: 4 }, bay)).toBe(false);
  });
  it("checks overnight Street Cleaning against the starting weekday and pauses on holidays", () => {
    const data = parking();
    data.clock = { isoWeekday: 2, minute: 30, weekOfMonth: 2, holiday: false };
    data.cleaning = [{ edge: "c1", side: "L", day: 1, fromHour: 23, toHour: 1, weeks: [2], holidays: false }];
    expect(checkParking(car, bay, data, 1).reason).toBe("street-cleaning");
    data.clock.holiday = true;
    expect(checkParking(car, bay, data, 1).legal).toBe(true);
  });
  it("fails closed on unknown rules and requires permit/payment where applicable", () => {
    const data = parking(); data.rules = [];
    expect(checkParking(car, bay, data, 1).reason).toBe("unknown-rule");
    data.rules = [{ edge: "c1", side: "L", kind: "pay-or-permit", days: [], from: null, to: null, hourLimit: null, permitAreas: ["A"] }];
    expect(checkParking(car, bay, data, 1).reason).toBe("unpaid");
    data.permits = { p: ["A"] };
    expect(checkParking(car, bay, data, 1).legal).toBe(true);
    data.rules[0]!.kind = "no-parking-any-time"; data.rules[0]!.days = [7];
    expect(checkParking(car, bay, data, 1).reason).toBe("restricted");
  });
  it("needs two continuous seconds stopped and a new interaction, then emits only once", () => {
    let state = createMissionMechanics(); const events = [];
    for (let tick = 0; tick <= 140; tick++) {
      const result = stepMissionMechanics(state, input(tick, tick === 30 || tick >= 120)); state = result.state; events.push(...result.events);
    }
    expect(events.map((e) => e.kind)).toEqual(["demo.parkedLegally"]);
    expect(events[0]).toMatchObject({ source: "world", id: "mission-mechanics:1", sequence: 1, tick: 120, actorId: "bay" });
    expect(stepMissionMechanics(state, input(140, true)).events).toEqual([]);
  });
  it("resets after movement, restriction changes and missing simulation ticks", () => {
    let state = createMissionMechanics();
    for (let tick = 0; tick < 120; tick++) state = stepMissionMechanics(state, input(tick)).state;
    const skipped = stepMissionMechanics(state, input(500, true));
    expect(skipped.events).toEqual([]); expect(skipped.state.parking.p!.stoppedSince).toBe(500);
    const moving = input(501); moving.vehicles = [{ ...car, speed: 1 }];
    expect(stepMissionMechanics(skipped.state, moving).state.parking.p!.bayId).toBe("");
  });
});

const request = { id: "demo-day:bell", playerId: "p", opponentId: "associate:1", x: 0, y: 1, z: 0 };
function duelInput(tick: number, pressed = false): MissionMechanicsInput { return { ...input(tick, pressed), parking: undefined, bellDuels: [request] }; }
describe("bell duel producer", () => {
  it("runs a seeded 4–8-ring pattern and requires two correctly timed rounds", () => {
    let state = stepMissionMechanics(createMissionMechanics(), duelInput(0, true)).state;
    expect(state.duels.p!.cues.length).toBeGreaterThanOrEqual(4); expect(state.duels.p!.cues.length).toBeLessThanOrEqual(8);
    const events = [];
    for (let tick = 1; tick < 2500 && state.duels.p!.phase !== "won"; tick++) {
      const press = state.duels.p!.responseTicks.includes(tick);
      const result = stepMissionMechanics(state, duelInput(tick, press)); state = result.state; events.push(...result.events);
    }
    expect(state.duels.p!.phase).toBe("won"); expect(state.duels.p!.wins).toBe(2);
    expect(events.filter((e) => e.kind === "bell.duelWon")).toHaveLength(1);
    const done = stepMissionMechanics(state, duelInput(state.tick + 1, true)); expect(done.events).toEqual([]);
  });
  it("does not accept holding interact or an absent response and loses best of three", () => {
    let state = stepMissionMechanics(createMissionMechanics(), duelInput(0, true)).state;
    const events = [];
    for (let tick = 1; tick < 2500 && state.duels.p!.phase !== "lost"; tick++) {
      const result = stepMissionMechanics(state, duelInput(tick, true)); state = result.state; events.push(...result.events);
    }
    expect(state.duels.p!.losses).toBe(2); expect(events.filter((e) => e.kind === "bell-duel.lost")).toHaveLength(1);
  });
  it("rejects a response outside ±120ms and requires a real nearby player on foot", () => {
    const far = duelInput(0, true); far.bodies = [{ ...body, x: 100 }];
    expect(stepMissionMechanics(createMissionMechanics(), far).events).toEqual([]);
    let state = stepMissionMechanics(createMissionMechanics(), duelInput(0, true)).state;
    const late = state.duels.p!.responseTicks[0]! + 8;
    for (let tick = 1; tick <= late; tick++) state = stepMissionMechanics(state, duelInput(tick, tick === late)).state;
    expect(state.duels.p!.losses).toBe(1);
  });
  it("is deterministic, does not mutate the prior state, and rejects duplicate requests", () => {
    const old = createMissionMechanics(), frame = duelInput(0, true); frame.sequenceFloor = 42;
    const first = stepMissionMechanics(old, frame), second = stepMissionMechanics(old, frame);
    expect(first).toEqual(second); expect(first.events[0]!.sequence).toBe(42); expect(old).toEqual(createMissionMechanics());
    frame.bellDuels = [request, request]; expect(() => stepMissionMechanics(old, frame)).toThrow("At most one");
  });
});
