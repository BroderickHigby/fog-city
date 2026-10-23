import { describe, expect, it } from "vitest";
import { dcos, dsin, PI } from "../../../src/sim/dmath.ts";
import {
  createRobotBrain, stepRobotBrain, ROBOT_MAX_KNOWN_PLAYERS, ROBOT_MAX_PENDING_UPDATES, ROBOT_MEMORY_TICKS, ROBOT_UPDATE_TICKS,
  type PlayerSight, type RobotBrainInput, type RobotBrainState, type RobotBroadcast,
  type RobotObservations, type RobotSight,
} from "../../../src/sim/robots/brain.ts";

function player(id = "p1", x = 0, z = -2, extra: Partial<PlayerSight> = {}): PlayerSight {
  return { kind: "player", id, x, z, heading: PI, inVehicle: false, threatening: false, lineOfSight: true, ...extra };
}
function robot(id = 2, x = 0, z = -2, extra: Partial<RobotSight> = {}): RobotSight {
  return { kind: "robot", id, x, z, alignment: "good", operational: true, lineOfSight: true, ...extra };
}
function input(tick: number, observations: Partial<RobotObservations> = {}, extra: Partial<RobotBrainInput> = {}): RobotBrainInput {
  return {
    tick, self: { x: 0, z: 0, heading: 0, rust: 0, fogDensity: 0, shoved: false },
    observations: { sight: [], sounds: [], broadcasts: [], scans: [], watches: [], ...observations },
    conversion: { withinFidelity: true, protectedArea: false, baseBadCount: 2, badCount: 2 },
    ...extra,
  };
}
function broadcast(extra: Partial<RobotBroadcast> = {}): RobotBroadcast {
  return { sourceId: 3, sourcePosition: { x: 60, z: 0 }, sourceSeized: true, emittedTick: 0, observedTick: 0,
    playerId: "p1", position: { x: 0, z: -8 }, ...extra };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
function next(state: RobotBrainState, observations: Partial<RobotObservations> = {}, extra: Partial<RobotBrainInput> = {}) {
  return stepRobotBrain(state, input(state.lastTick + 1, observations, extra));
}
function completeUpdate(state: RobotBrainState, id = 2) {
  let result = next(state, { sight: [robot(id)] });
  expect(result.intent.action).toMatchObject({ kind: "update", phase: "start" });
  for (let tick = 1; tick <= ROBOT_UPDATE_TICKS; tick++) result = next(result.state, { sight: [robot(id)] });
  expect(result.intent.action).toMatchObject({ kind: "update", phase: "complete" });
  return result;
}

describe("robot sensory knowledge", () => {
  it("is pure on deeply frozen state and observations, and snapshots never alias observation positions", () => {
    const state = freeze(createRobotBrain({ id: 41 }));
    const observation = input(0, { sight: [player("p1", 0, -9)] });
    const source = JSON.stringify({ state, observation });
    freeze(observation);
    const first = stepRobotBrain(state, observation);
    expect(stepRobotBrain(state, observation)).toEqual(first);
    expect(JSON.stringify({ state, observation })).toBe(source);
    expect(first.state.knowledge[0]).toMatchObject({ x: 0, z: -9, channel: "sight" });
    expect(first.state.knowledge[0]).not.toBe(observation.observations.sight[0]);
    expect(first.state.mode).toBe("disguised");
    expect(first.intent.action.kind).toBe("none");
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("senses only the 100-degree cone, 30m range and actual line of sight", () => {
    const atAngle = (degrees: number, distance: number, id: string) =>
      player(id, dsin(degrees * PI / 180) * distance, -dcos(degrees * PI / 180) * distance);
    const result = next(createRobotBrain({ id: 1 }), {
      sight: [atAngle(-49.99, 25, "left"), atAngle(49.99, 25, "right"), atAngle(50.01, 25, "outside"),
        player("edge", 0, -30), player("far", 0, -30.001), player("blocked", 0, -3, { lineOfSight: false }), player("behind", 0, 1)],
    });
    expect(result.state.knowledge.map((k) => k.playerId)).toEqual(["edge", "left", "right"]);
  });

  it("rotates sight with compass heading and reduces range to 12m in dense fog", () => {
    const base = input(0);
    const result = next(createRobotBrain({ id: 1 }), { sight: [player("east", 12, 0), player("far", 12.001, 0), player("north", 0, -4)] }, {
      self: { ...base.self, heading: PI / 2, fogDensity: 1 },
    });
    expect(result.state.knowledge.map((k) => k.playerId)).toEqual(["east"]);
  });

  it("hears spray to 20m and horn to 40m, including behind the observer", () => {
    const result = next(createRobotBrain({ id: 1 }), { sounds: [
      { kind: "spray", playerId: "spray", x: 0, z: 20 }, { kind: "spray", playerId: "farSpray", x: 0, z: 20.01 },
      { kind: "horn", playerId: "horn", x: 0, z: 40 }, { kind: "horn", playerId: "farHorn", x: 0, z: 40.01 },
    ] });
    expect(result.state.knowledge.map((k) => k.playerId)).toEqual(["horn", "spray"]);
    expect(result.state.mode).toBe("alerted");
    const hornOnly = next(createRobotBrain({ id: 1 }), { sounds: [{ kind: "horn", playerId: "p", x: 0, z: 5 }] });
    expect(hornOnly.state.mode).toBe("disguised");
  });

  it("accepts only fresh seizure broadcasts within 60m and preserves their original observation time", () => {
    const result = stepRobotBrain(createRobotBrain({ id: 1, tick: 100 }), input(100, {
      broadcasts: [broadcast({ emittedTick: 100, observedTick: 5 })],
    }));
    expect(result.state.knowledge[0]).toMatchObject({ observedTick: 5, expiresTick: 5 + ROBOT_MEMORY_TICKS, channel: "broadcast" });
    for (const invalid of [
      broadcast({ sourcePosition: { x: 60.01, z: 0 } }), broadcast({ sourceSeized: false }),
      broadcast({ sourceId: 1 }), broadcast({ emittedTick: 1 }), broadcast({ observedTick: 1 }),
    ]) {
      expect(next(createRobotBrain({ id: 1 }), { broadcasts: [invalid] }).state.knowledge).toEqual([]);
    }
    expect(stepRobotBrain(result.state, input(605, { broadcasts: [broadcast({ emittedTick: 605, observedTick: 5 })] })).state.knowledge).toEqual([]);
  });

  it("expires knowledge and pursues the last known point without learning unseen movement", () => {
    let result = next(createRobotBrain({ id: 1 }), { sight: [player("p", 0, -10, { threatening: true })] });
    expect(result.state.mode).toBe("alerted");
    result = next(result.state, { sight: [player("p", 100, 100, { lineOfSight: false })] });
    expect(result.state.mode).toBe("attack");
    expect(result.intent.movement).toMatchObject({ kind: "pursue", destination: { x: 0, z: -10 } });
    expect(result.intent.action.kind).toBe("none");
    result = stepRobotBrain(result.state, input(ROBOT_MEMORY_TICKS));
    expect(result.state.knowledge).toEqual([]);
    expect(result.state.mode).toBe("disguised");
    expect(result.intent.movement.kind).toBe("errand");
  });

  it("produces the same result after observation permutations, including competing reports", () => {
    const observations: RobotObservations = {
      sight: [player("p2", 0, -22), player("p1", 0, -21), robot(10, -0.5, -2), robot(2, 0.5, -2)],
      sounds: [{ kind: "horn", playerId: "p3", x: 3, z: -6 }, { kind: "horn", playerId: "p3", x: 1, z: -6 }],
      broadcasts: [broadcast({ playerId: "p4", position: { x: 2, z: -6 } }), broadcast({ playerId: "p4", position: { x: 1, z: -6 } })],
      scans: [], watches: [],
    };
    const state = createRobotBrain({ id: 1 });
    const first = next(state, observations);
    const second = next(state, { sight: [...observations.sight].reverse(), sounds: [...observations.sounds].reverse(),
      broadcasts: [...observations.broadcasts].reverse(), scans: [], watches: [] });
    expect(second).toEqual(first);
    // Broadcast alarm pauses at alerted; next tick chooses the nearer player memory.
    const robotOnly = next(state, { sight: [robot(10, -0.5, -2), robot(2, 0.5, -2)] });
    expect(robotOnly.intent.action).toMatchObject({ kind: "update", targetId: 2 });
  });

  it("bounds knowledge under identity churn and retains the freshest evidence", () => {
    let state = createRobotBrain({ id: 1 });
    for (let index = 0; index < 80; index++) {
      state = next(state, { sight: [player(`p${index.toString().padStart(2, "0")}`, 0, -25)] }).state;
      expect(state.knowledge.length).toBeLessThanOrEqual(ROBOT_MAX_KNOWN_PLAYERS);
    }
    expect(state.knowledge.map((known) => known.playerId)).toEqual(
      Array.from({ length: ROBOT_MAX_KNOWN_PLAYERS }, (_, index) => `p${index + 56}`),
    );
  });

  it("bounds simultaneous knowledge and close watches with order-invariant eviction", () => {
    const sightings = Array.from({ length: 40 }, (_, index) => player(`p${index.toString().padStart(2, "0")}`, 0, -5));
    const watches = sightings.map((seen) => ({ playerId: seen.id, x: seen.x, z: seen.z, lineOfSight: true }));
    const state = createRobotBrain({ id: 1 });
    const forward = next(state, { sight: sightings, watches });
    const reversed = next(state, { sight: [...sightings].reverse(), watches: [...watches].reverse() });
    expect(reversed).toEqual(forward);
    expect(forward.state.knowledge).toHaveLength(ROBOT_MAX_KNOWN_PLAYERS);
    expect(forward.state.closeWatches).toHaveLength(ROBOT_MAX_KNOWN_PLAYERS);
    const expected = sightings.slice(0, ROBOT_MAX_KNOWN_PLAYERS).map((seen) => seen.id);
    expect(forward.state.knowledge.map((known) => known.playerId)).toEqual(expected);
    expect(forward.state.closeWatches.map((watch) => watch.playerId)).toEqual(expected);
  });

  it("rejects non-finite observations, duplicate sight identities and non-increasing ticks", () => {
    const state = createRobotBrain({ id: 1 });
    expect(() => next(state, { sight: [player("p", Number.NaN)] })).toThrow(RangeError);
    expect(() => next(state, { sight: [player(), player()] })).toThrow(RangeError);
    expect(() => next(state, {}, { self: { ...input(0).self, rust: 2 } })).toThrow(RangeError);
    const first = next(state);
    expect(() => stepRobotBrain(first.state, input(0))).toThrow(RangeError);
    expect(() => createRobotBrain({ id: -1 })).toThrow(RangeError);
  });
});

describe("robot state transitions", () => {
  it("scan pings make nearby units wary for ten seconds without leaking the scanner's position", () => {
    const result = next(createRobotBrain({ id: 1 }), { sight: [robot()], scans: [{ playerId: "hidden", x: 0, z: 30, targetRobotId: null }] });
    expect(result.state.mode).toBe("wary");
    expect(result.state.knowledge).toEqual([]);
    expect(result.intent.hideOneTell).toBe(true);
    expect(result.intent.sabotageActive).toBe(false);
    expect(result.intent.action.kind).toBe("none");
    expect(stepRobotBrain(result.state, input(599)).state.mode).toBe("wary");
    expect(stepRobotBrain(result.state, input(600)).state.mode).toBe("disguised");
    expect(next(createRobotBrain({ id: 1 }), { scans: [{ playerId: "p", x: 0, z: 30.01, targetRobotId: null }] }).state.mode).toBe("disguised");
  });

  it("only a scan targeting this robot within ten metres alerts it", () => {
    for (const [targetRobotId, z, expected] of [[1, -10, "alerted"], [1, -10.01, "wary"], [2, -2, "wary"]] as const) {
      const result = next(createRobotBrain({ id: 1 }), { scans: [{ playerId: "p", x: 0, z, targetRobotId }] });
      expect(result.state.mode).toBe(expected);
      expect(result.state.knowledge).toEqual([]);
    }
  });

  it("requires more than three continuous seconds of close Watch; gaps and range break the timer", () => {
    const watches = [{ playerId: "p", x: 0, z: 10, lineOfSight: true }];
    let state = createRobotBrain({ id: 1 });
    for (let tick = 0; tick <= 180; tick++) state = next(state, { watches }).state;
    expect(state.mode).toBe("disguised");
    state = next(state, { watches }).state;
    expect(state.mode).toBe("wary");
    expect(state.knowledge).toEqual([]);
    let interrupted = next(createRobotBrain({ id: 1 }), { watches }).state;
    interrupted = stepRobotBrain(interrupted, input(100, { watches } )).state;
    expect(interrupted.closeWatches[0]?.startedTick).toBe(100);
    interrupted = next(interrupted, { watches: [{ ...watches[0]!, z: 10.01 }] }).state;
    expect(interrupted.closeWatches).toEqual([]);
    interrupted = next(interrupted, { watches }).state;
    expect(interrupted.closeWatches[0]?.startedTick).toBe(102);
  });

  it("keeps disguise while running errands and sabotages only when not visibly watched nearby", () => {
    const watched = next(createRobotBrain({ id: 1 }), { sight: [robot(), player("p", 0, -10)] });
    expect(watched.intent.action.kind).toBe("none");
    for (const observer of [player("p", 0, -25), player("p", 0, -10, { heading: 0 }), player("p", 0, -10, { inVehicle: true })]) {
      const result = next(createRobotBrain({ id: 1 }), { sight: [robot(), observer] });
      expect(result.state.mode).toBe("disguised");
      expect(result.intent.action).toMatchObject({ kind: "update", phase: "start" });
    }
  });

  it("runs from rust 0.6 and prefers only a currently visible bad ally", () => {
    const result = next(createRobotBrain({ id: 1 }), {
      sight: [player("p", 0, -2, { threatening: true }), robot(2, -1, -3, { alignment: "bad" }), robot(3, 1, -1)],
    }, { self: { ...input(0).self, rust: 0.6 } });
    expect(result.state.mode).toBe("flee");
    expect(result.intent.movement).toMatchObject({ kind: "flee", from: { x: 0, z: -2 }, toward: { x: -1, z: -3 } });
    expect(result.intent.action.kind).toBe("none");
  });

  it("follows a visible target into fog for at most eight seconds, then breaks off", () => {
    let state = createRobotBrain({ id: 1 });
    const observations = { sight: [player("p", 0, -8, { threatening: true })] };
    const extra = { self: { ...input(0).self, fogDensity: 0.5 } };
    for (let tick = 0; tick < 480; tick++) {
      const result = next(state, observations, extra);
      state = result.state;
      if (tick > 0) {
        expect(result.intent.fogRustMultiplier).toBe(3);
        expect(result.intent.movement.avoidFog).toBe(false);
      }
      expect(state.mode).not.toBe("flee");
    }
    const ended = next(state, observations, extra);
    expect(ended.state.mode).toBe("flee");
    expect(ended.intent.fogRustMultiplier).toBe(1);
    expect(ended.intent.movement.avoidFog).toBe(true);
    const fleet = next(ended.state, observations, { ...extra, fleetUpdate: true });
    expect(fleet.state.mode).not.toBe("flee");
    expect(fleet.intent.movement.avoidFog).toBe(false);
    expect(fleet.intent.fogRustMultiplier).toBe(1);
    const rustedFleet = next(fleet.state, observations, { ...extra, fleetUpdate: true, self: { ...extra.self, rust: 0.6 } });
    expect(rustedFleet.state.mode).toBe("flee");
  });
});

describe("robot attack intents", () => {
  it("never attacks or converts a bystander person", () => {
    let state = createRobotBrain({ id: 1 });
    for (let tick = 0; tick < 400; tick++) {
      const result = next(state, { sight: [{ kind: "person", id: 2, x: 0, z: -1, lineOfSight: true }] });
      state = result.state;
      expect(result.intent.action.kind).toBe("none");
    }
    expect(state.knowledge).toEqual([]);
  });

  it("alerts before attacking and holds the entire readable wind-up despite repeated threats", () => {
    const sight = [player("p", 0, -8, { threatening: true })];
    let result = next(createRobotBrain({ id: 1 }), { sight });
    expect(result.state.mode).toBe("alerted");
    expect(result.intent.action.kind).toBe("none");
    for (let tick = 1; tick < 49; tick++) {
      result = next(result.state, { sight });
      expect(result.state.mode).toBe("attack");
      expect(result.intent.action).toMatchObject({ kind: "windup", attack: "adBlast" });
    }
    result = next(result.state, { sight });
    expect(result.intent.action).toEqual({ kind: "attack", attack: "adBlast", target: { kind: "player", id: "p" } });
    result = next(result.state, { sight });
    expect(result.intent.action.kind).toBe("none");
  });

  it("breaks an attack wind-up when line of sight is lost and restarts the full wind-up", () => {
    let result = next(createRobotBrain({ id: 1 }), { sight: [player("p", 0, -1, { threatening: true })] });
    result = next(result.state, { sight: [player("p", 0, -1)] });
    expect(result.intent.action).toMatchObject({ kind: "windup", attack: "shove", remainingTicks: 36 });
    result = next(result.state, { sight: [player("p", 0, -1, { lineOfSight: false })] });
    expect(result.intent.action).toMatchObject({ kind: "cancel", activity: "attack" });
    result = next(result.state, { sight: [player("p", 0, -1)] });
    expect(result.intent.action).toMatchObject({ kind: "windup", remainingTicks: 36 });
  });

  it("uses ranged attacks when the caller reports that both melee slots are occupied", () => {
    let result = next(createRobotBrain({ id: 1 }), { sight: [player("p", 0, -1, { threatening: true })] });
    result = next(result.state, { sight: [player("p", 0, -1)] }, { meleeSlotsAvailable: 0 });
    expect(result.intent.action).toMatchObject({ kind: "windup", attack: "adBlast" });
  });

  it("uses archetype and caller goal priorities without granting unsupported attacks", () => {
    const trundle = next(createRobotBrain({ id: 1, archetype: "trundle" }), { sight: [robot(2, 0, -0.5)] }, {
      goalWeights: { forcedUpdate: 1, grocerySnatch: 10, shove: 100 },
    });
    expect(trundle.intent.action).toMatchObject({ kind: "windup", attack: "grocerySnatch" });
  });
});

describe("forced update channels", () => {
  it("completes once after six full seconds of uninterrupted contact, never at the start", () => {
    const sight = [robot()];
    let result = next(createRobotBrain({ id: 1 }), { sight });
    expect(result.intent.action).toEqual({ kind: "update", targetId: 2, phase: "start", progress: 0 });
    for (let tick = 1; tick < ROBOT_UPDATE_TICKS; tick++) {
      result = next(freeze(result.state), { sight });
      expect(result.intent.action).toMatchObject({ kind: "update", phase: "channel" });
      if (result.intent.action.kind === "update") expect(result.intent.action.progress).toBeLessThan(1);
    }
    result = next(result.state, { sight });
    expect(result.intent.action).toEqual({ kind: "update", targetId: 2, phase: "complete", progress: 1 });
    expect(result.state.update).toBeNull();
    for (let tick = 0; tick < 400; tick++) {
      result = next(result.state, { sight });
      expect(result.intent.action).not.toMatchObject({ kind: "update" });
    }
    expect(result.state.pendingUpdates).toEqual([{ targetId: 2, completedTick: 360 }]);
  });

  it("interrupts on rust 0.2, shove, range, occlusion and missing simulation ticks", () => {
    const started = next(createRobotBrain({ id: 1 }), { sight: [robot()] }).state;
    const interrupted = [
      stepRobotBrain(started, input(1, { sight: [robot()] }, { self: { ...input(0).self, rust: 0.2 } })),
      stepRobotBrain(started, input(1, { sight: [robot()] }, { self: { ...input(0).self, shoved: true } })),
      stepRobotBrain(started, input(1, { sight: [robot(2, 0, -3.01)] })),
      stepRobotBrain(started, input(1, { sight: [robot(2, 0, -2, { lineOfSight: false })] })),
      stepRobotBrain(started, input(2, { sight: [robot()] })),
    ];
    expect(interrupted.map((r) => r.intent.action)).toEqual([
      { kind: "cancel", activity: "update", reason: "rust" }, { kind: "cancel", activity: "update", reason: "shove" },
      { kind: "cancel", activity: "update", reason: "contact" }, { kind: "cancel", activity: "update", reason: "contact" },
      { kind: "cancel", activity: "update", reason: "contact" },
    ]);
    for (const result of interrupted) {
      expect(result.state.update).toBeNull();
      const restarted = next(result.state, { sight: [robot()] });
      expect(restarted.intent.action).toMatchObject({ kind: "update", phase: "start", progress: 0 });
      expect(restarted.state.update?.startedTick).toBe(result.state.lastTick + 1);
    }
  });

  it("clears a pending completion once a changed robot status is seen, allowing a repaired robot to be updated again", () => {
    for (const changed of [robot(2, 0, -2, { alignment: "bad" }), robot(2, 0, -2, { operational: false })]) {
      const completed = completeUpdate(createRobotBrain({ id: 1 }));
      expect(completed.state.pendingUpdates).toEqual([{ targetId: 2, completedTick: 360 }]);
      const applied = next(completed.state, { sight: [changed] });
      expect(applied.state.pendingUpdates).toEqual([]);
      const repaired = next(applied.state, { sight: [robot()] });
      expect(repaired.intent.action).toMatchObject({ kind: "update", phase: "start", targetId: 2 });
    }
  });

  it("accepts an explicit applied-completion acknowledgement without preserving permanent target immunity", () => {
    const completed = completeUpdate(createRobotBrain({ id: 1 }));
    const applied = next(completed.state, {}, { acknowledgedUpdates: [{ targetId: 2, completedTick: 360 }, { targetId: 2, completedTick: 360 }] });
    expect(applied.state.pendingUpdates).toEqual([]);
    expect(next(applied.state, { sight: [robot()] }).intent.action).toMatchObject({ kind: "update", phase: "start" });
  });

  it("does not let a delayed acknowledgement clear a later completion after the same robot is repaired", () => {
    const first = completeUpdate(createRobotBrain({ id: 1 }));
    const applied = next(first.state, { sight: [robot(2, 0, -2, { alignment: "bad" })] });
    const second = completeUpdate(applied.state);
    const delayed = next(second.state, {}, { acknowledgedUpdates: first.state.pendingUpdates });
    expect(delayed.state.pendingUpdates).toEqual(second.state.pendingUpdates);
    const acknowledged = next(delayed.state, {}, { acknowledgedUpdates: second.state.pendingUpdates });
    expect(acknowledged.state.pendingUpdates).toEqual([]);
  });

  it("bounds unacknowledged completions and pauses new conversions until the caller acknowledges one", () => {
    let state = createRobotBrain({ id: 1 });
    for (let index = 0; index < ROBOT_MAX_PENDING_UPDATES; index++) {
      state = completeUpdate(freeze(state), index + 2).state;
      expect(state.pendingUpdates).toHaveLength(index + 1);
      expect(new Set(state.pendingUpdates.map((pending) => pending.targetId)).size).toBe(index + 1);
    }
    const blocked = next(state, { sight: [robot(100)] });
    expect(blocked.state.update).toBeNull();
    expect(blocked.state.pendingUpdates).toHaveLength(ROBOT_MAX_PENDING_UPDATES);
    const released = next(blocked.state, { sight: [robot(100)] }, { acknowledgedUpdates: [state.pendingUpdates[0]!] });
    expect(released.state.pendingUpdates).toHaveLength(ROBOT_MAX_PENDING_UPDATES - 1);
    expect(released.intent.action).toMatchObject({ kind: "update", phase: "start", targetId: 100 });
  });

  it("checks fidelity, normal/protected caps and concurrent reservations before starting", () => {
    const base = input(0).conversion;
    for (const conversion of [
      { ...base, withinFidelity: false }, { ...base, badCount: 4 }, { ...base, protectedArea: true },
      { ...base, badCount: 3, reservedCount: 1 }, { ...base, baseBadCount: 0, badCount: 0 },
    ]) {
      expect(next(createRobotBrain({ id: 1 }), { sight: [robot()] }, { conversion }).state.update).toBeNull();
    }
    expect(next(createRobotBrain({ id: 1 }), { sight: [robot()] }, { conversion: { ...base, badCount: 3 } }).state.update).not.toBeNull();
    expect(next(createRobotBrain({ id: 1 }), { sight: [robot()] }, { conversion: { ...base, badCount: 1, protectedArea: true } }).state.update).not.toBeNull();
  });

  it("rechecks the cap on the completion tick and cancels rather than overshooting", () => {
    let result = next(createRobotBrain({ id: 1 }), { sight: [robot()] });
    for (let tick = 1; tick < ROBOT_UPDATE_TICKS; tick++) result = next(result.state, { sight: [robot()] });
    result = next(result.state, { sight: [robot()] }, { conversion: { ...input(0).conversion, badCount: 4 } });
    expect(result.intent.action).toEqual({ kind: "cancel", activity: "update", reason: "cap" });
    expect(result.state.pendingUpdates).toEqual([]);
  });

  it("stops sabotage on an alert even when the heard player is outside the attack radius", () => {
    let result = next(createRobotBrain({ id: 1 }), { sight: [robot()] });
    for (let tick = 1; tick < ROBOT_UPDATE_TICKS; tick++) result = next(result.state, { sight: [robot()] });
    result = next(result.state, { sight: [robot()], sounds: [{ kind: "spray", playerId: "p", x: 0, z: -18 }] });
    expect(result.state.mode).toBe("alerted");
    expect(result.intent.action).toEqual({ kind: "cancel", activity: "update", reason: "state" });
    expect(result.state.update).toBeNull();
    expect(result.intent.sabotageActive).toBe(false);
  });

  it("cancels if the target stops being a good operational robot or a scan makes the pusher wary", () => {
    const started = next(createRobotBrain({ id: 1 }), { sight: [robot()] }).state;
    for (const target of [robot(2, 0, -2, { alignment: "bad" }), robot(2, 0, -2, { operational: false })]) {
      expect(next(started, { sight: [target] }).intent.action).toMatchObject({ kind: "cancel", reason: "contact" });
    }
    const wary = next(started, { sight: [robot()], scans: [{ playerId: "hidden", x: 0, z: 20, targetRobotId: null }] });
    expect(wary.intent.action).toMatchObject({ kind: "cancel", reason: "state" });
    expect(wary.intent.sabotageActive).toBe(false);
  });
});
