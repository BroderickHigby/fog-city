import { describe, expect, it } from "vitest";
import { Action, NEUTRAL_INPUT } from "../../../../src/sim/contract.ts";
import { boardPosition, createMissionMechanics, eligibleBoardingSlot, stepMissionMechanics, type CableCarBody, type MissionMechanicsInput } from "../../../../src/sim/missions/mechanics/index.ts";
const vehicle: CableCarBody = { id: "cable:1", kind: "cable-car", x: 10, y: 5, z: 20, heading: 0, speed: 0, atStop: true, boardingOpen: true, slots: [{ id: "left", lateral: -1.5, forward: 0, height: 0.5 }] };
function frame(tick: number, press = false): MissionMechanicsInput {
  return { tick, seed: 1, bodies: [{ id: "p", x: 8.5, y: 5.5, z: 20, speed: 0, mode: "foot" }], vehicles: [], inputs: { p: { ...NEUTRAL_INPUT, actions: press ? Action.interact : 0 } }, cableBoarding: { requests: [{ id: "hill-climb:board", playerId: "p", vehicleId: vehicle.id }], vehicles: [vehicle], accepted: [] } };
}
describe("cable-car boarding producer", () => {
  it("requires a stopped cable car with boarding open and a player at its board", () => {
    const body = frame(0).bodies[0]!;
    expect(eligibleBoardingSlot(body, vehicle)?.id).toBe("left");
    for (const override of [{ speed: 4 }, { atStop: false }, { boardingOpen: false }, { kind: "bus" as const }]) expect(eligibleBoardingSlot(body, { ...vehicle, ...override })).toBeNull();
    expect(eligibleBoardingSlot({ ...body, x: 20 }, vehicle)).toBeNull();
    expect(eligibleBoardingSlot({ ...body, y: 0 }, vehicle)).toBeNull();
  });
  it("produces an intent first and only confirms core's accepted matching attachment", () => {
    const first = stepMissionMechanics(createMissionMechanics(), frame(0, true));
    expect(first.events).toEqual([]); expect(first.boardingIntents).toHaveLength(1);
    const next = frame(1); const intent = first.boardingIntents[0]!;
    next.cableBoarding!.accepted = [{ intentId: intent.id, playerId: "p", vehicleId: vehicle.id, slotId: "left" }];
    const mounted = stepMissionMechanics(first.state, next);
    expect(mounted.events.map((e) => e.kind)).toEqual(["cableCar.runningBoardMounted"]);
    expect(stepMissionMechanics(mounted.state, { ...next, tick: 2 }).events).toEqual([]);
  });
  it("rejects fabricated completion, a stale intent and a rejected physical pose", () => {
    const first = stepMissionMechanics(createMissionMechanics(), frame(0, true));
    const next = frame(1); next.cableBoarding!.accepted = [{ intentId: "old", playerId: "p", vehicleId: vehicle.id, slotId: "left" }];
    expect(stepMissionMechanics(first.state, next).events).toEqual([]);
    next.cableBoarding!.accepted[0]!.intentId = first.boardingIntents[0]!.id;
    next.bodies = [{ ...next.bodies[0]!, x: 20 }];
    expect(stepMissionMechanics(first.state, next).events).toEqual([]);
    next.bodies = frame(1).bodies;
    expect(stepMissionMechanics(first.state, { ...next, tick: 121 }).events).toEqual([]);
  });
  it("checks the moving vehicle's current board pose after acceptance", () => {
    const first = stepMissionMechanics(createMissionMechanics(), frame(0, true));
    const next = frame(1), moved = { ...vehicle, x: 12, heading: Math.PI / 2, speed: 2, atStop: false };
    next.cableBoarding!.vehicles = [moved];
    next.cableBoarding!.accepted = [{ intentId: first.boardingIntents[0]!.id, playerId: "p", vehicleId: vehicle.id, slotId: "left" }];
    next.bodies = [{ ...next.bodies[0]!, ...boardPosition(moved, moved.slots[0]!) }];
    expect(stepMissionMechanics(first.state, next).events[0]?.kind).toBe("cableCar.runningBoardMounted");
  });
});
