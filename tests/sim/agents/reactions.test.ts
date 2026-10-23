import { describe, expect, it } from "vitest";
import { canReceiveWater, constrainLeashedIntent, IDLE_REACTION, reactToPerception } from "../../../src/sim/agents/reactions.ts";
import type { PerceivedStimulus, ReactionActor, ReactionInput } from "../../../src/sim/agents/reactions.ts";

const person: ReactionActor = { id: "person", kind: "person", x: 0, z: 0, wet: false };
const spray: PerceivedStimulus = { sourceId: "player", kind: "spray", x: 1, z: 0, seen: true, heard: true, waterContact: true };
const horn: PerceivedStimulus = { sourceId: "car", kind: "horn", x: 8, z: 0, seen: false, heard: true };
const input = (actor = person, stimuli: ReadonlyArray<PerceivedStimulus> = []): ReactionInput =>
  ({ actor, stimuli, state: IDLE_REACTION, tick: 0, dodgeOverrideActive: false });

describe("people, helpful robot and animal reactions", () => {
  it("ignores unperceived and out-of-range facts", () => {
    expect(reactToPerception(input(person, [{ ...spray, seen: false, heard: false }])).state).toEqual(IDLE_REACTION);
    expect(reactToPerception(input(person, [{ ...horn, x: 41 }])).state).toEqual(IDLE_REACTION);
    expect(reactToPerception(input(person, [{ ...spray, x: 21 }])).wet).toBe(false);
  });

  it("startles on a heard horn, briefly avoids, then returns to its routine", () => {
    const startled = reactToPerception(input(person, [horn]));
    expect(startled.state.mode).toBe("startle");
    expect(startled.movement.kind).toBe("hold");
    const avoiding = reactToPerception({ ...input(), state: startled.state, tick: 18 });
    expect(avoiding.state.mode).toBe("avoid");
    expect(avoiding.movement.vx).toBeLessThan(0);
    const idle = reactToPerception({ ...input(), state: avoiding.state, tick: 78, routineVelocity: { vx: 0, vz: 1 } });
    expect(idle.state).toEqual(IDLE_REACTION);
    expect(idle.movement).toMatchObject({ kind: "velocity", reason: "routine", vz: 1 });
  });

  it("good robots glance at scan pings and choose deterministic threats by priority and source ID", () => {
    const robot = { ...person, id: "helper", kind: "good-robot" as const };
    const ping: PerceivedStimulus = { ...horn, kind: "ping" };
    expect(reactToPerception(input(robot, [ping])).state.mode).toBe("glance");
    const stimuli = [horn, ping, spray, { ...spray, sourceId: "a", x: -1 }];
    const a = reactToPerception(input(robot, stimuli));
    expect(a).toEqual(reactToPerception(input(robot, [...stimuli].reverse())));
    expect(a.state.source!.id).toBe("a");
    expect(a.movement.vx).toBeGreaterThan(0);
  });

  it("a nearby glance does not cancel an unexpired avoidance response", () => {
    const avoiding = reactToPerception(input(person, [spray]));
    const next = reactToPerception({ ...input(person, [{ ...spray, kind: "nearby", sourceId: "bystander" }]),
      state: avoiding.state, tick: 1 });
    expect(next.state).toEqual(avoiding.state);
    expect(next.movement.vx).toBeLessThan(0);
  });

  it("never makes protected bodies wet, including inconsistent incoming wet state", () => {
    const protectedBodies: ReactionActor[] = [
      { ...person, kind: "pigeon" }, { ...person, kind: "dog", leash: { ownerId: "owner", ownerX: 0, ownerZ: 0, lengthM: 2 } },
      { ...person, child: true }, { ...person, posture: "seated" }, { ...person, posture: "lying" }, { ...person, mobilityAid: true },
    ];
    for (const actor of protectedBodies) {
      expect(canReceiveWater(actor)).toBe(false);
      expect(reactToPerception(input({ ...actor, wet: true }, [spray])).wet).toBe(false);
    }
    expect(reactToPerception(input(person, [spray])).wet).toBe(true);
    expect(reactToPerception(input({ ...person, kind: "good-robot" }, [spray])).wet).toBe(true);
  });

  it("pigeons avoid sensed water and stationary protected people retain their posture", () => {
    const pigeon = reactToPerception(input({ ...person, kind: "pigeon" }, [spray]));
    expect(pigeon.movement.vx).toBe(-3.5);
    expect(pigeon.wet).toBe(false);
    expect(reactToPerception(input({ ...person, posture: "seated" }, [spray])).movement)
      .toMatchObject({ kind: "hold", reason: "posture" });
  });

  it("dodge suppresses all policy movement even with a reaction, routine, or invalid leash", () => {
    for (const actor of [person, { ...person, kind: "good-robot" as const }, { ...person, kind: "pigeon" as const },
      { ...person, kind: "dog" as const }]) {
      const result = reactToPerception({ ...input(actor, [spray]), dodgeOverrideActive: true, routineVelocity: { vx: 100, vz: 100 } });
      expect(result.movement).toEqual({ kind: "hold", vx: 0, vz: 0, reason: "dodge" });
    }
  });

  it("constrains a startled or walking dog inside its owner's leash without moving the owner", () => {
    const dog: ReactionActor = { ...person, id: "dog", kind: "dog", x: 1.99,
      leash: { ownerId: "owner", ownerX: 0, ownerZ: 0, lengthM: 2 } };
    const before = JSON.stringify(dog);
    const result = reactToPerception({ ...input(dog, [{ ...spray, x: 1 }]), stepSeconds: 0.1 });
    const nextX = dog.x + result.movement.vx * 0.1;
    const nextZ = dog.z + result.movement.vz * 0.1;
    expect(nextX * nextX + nextZ * nextZ).toBeLessThanOrEqual(4 + 1e-10);
    expect(result.movement.reason).toBe("leash");
    expect(result.wet).toBe(false);
    expect(JSON.stringify(dog)).toBe(before);
    const walking = reactToPerception({ ...input(dog), stepSeconds: 0.1, routineVelocity: { vx: 100, vz: 100 } });
    expect((dog.x + walking.movement.vx * 0.1) ** 2 + (walking.movement.vz * 0.1) ** 2).toBeLessThanOrEqual(4 + 1e-10);
    expect(() => constrainLeashedIntent({ ...dog, x: 3 }, { vx: 1, vz: 0 }, 0.1)).toThrow("outside its leash");
    expect(() => reactToPerception(input({ ...dog, leash: undefined }))).toThrow("valid leash");
  });

  it("produces finite deterministic avoidance when actor and source coincide, without mutating inputs", () => {
    const request = input(person, [{ ...spray, x: 0, z: 0 }]);
    const before = JSON.stringify(request);
    const result = reactToPerception(request);
    expect(result).toEqual(reactToPerception(request));
    expect(Number.isFinite(result.movement.vx)).toBe(true);
    expect(Number.isFinite(result.movement.vz)).toBe(true);
    expect(Math.sqrt(result.movement.vx ** 2 + result.movement.vz ** 2)).toBeCloseTo(1.6);
    expect(JSON.stringify(request)).toBe(before);
  });

  it("rejects non-finite public leash inputs instead of emitting invalid velocities", () => {
    const dog: ReactionActor = { ...person, kind: "dog", leash: { ownerId: "owner", ownerX: 0, ownerZ: 0, lengthM: 2 } };
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() => constrainLeashedIntent({ ...dog, x: invalid }, { vx: 1, vz: 0 }, 1 / 60)).toThrow();
      expect(() => constrainLeashedIntent(dog, { vx: invalid, vz: 0 }, 1 / 60)).toThrow();
      expect(() => constrainLeashedIntent(dog, { vx: 1, vz: 0 }, invalid)).toThrow();
      expect(() => reactToPerception(input({ ...person, z: invalid }))).toThrow("reaction step");
    }
    expect(() => constrainLeashedIntent(dog, { vx: 1, vz: 0 }, 0)).toThrow();
    expect(() => constrainLeashedIntent(dog, { vx: Number.MAX_VALUE, vz: 0 }, 2)).toThrow();
    expect(() => reactToPerception({ ...input(), stimuli: [{ ...spray, x: NaN }] })).toThrow("reaction step");
  });
});
