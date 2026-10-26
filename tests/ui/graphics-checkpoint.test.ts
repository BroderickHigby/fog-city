import { describe, expect, it } from "vitest";
import { GRAPHICS_CHECKPOINT_KEY, GRAPHICS_CHECKPOINT_MAX_BYTES, takeGraphicsCheckpoint, writeGraphicsCheckpoint, type GraphicsCheckpoint } from "../../src/save/graphics-checkpoint.ts";
import { Action, SIM_VERSION, buildWorld, createInitialState, hashState, step, type SimEvent } from "../../src/sim/index.ts";
import { createGameSystems } from "../../src/sim/game-systems.ts";

const world = buildWorld([]);
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}
function checkpoint(): GraphicsCheckpoint {
  let state = createInitialState(world, 27, ["p1"], { x: 0, z: 0, heading: 0 });
  for (let tick = 0; tick < 40; tick++) state = step(world, state, { p1: { throttle: .8, steer: .1, brake: 0, actions: 0 } });
  const pending: SimEvent = { tick: state.tick + 1, kind: "gameplay.command", playerId: "p1", payload: { kind: "mission-start", targetId: "hot-desk", sequence: 1 } };
  return { world: "sf", wave: 3, state, queuedEvents: [pending], recordedCommands: [pending], requestedMission: "hot-desk", waypoint: { x: -213.5, z: 1200.25 } };
}
function replaceData(store: ReturnType<typeof memoryStorage>, change: (data: GraphicsCheckpoint) => void) {
  const envelope = JSON.parse(store.getItem(GRAPHICS_CHECKPOINT_KEY)!);
  change(envelope.data);
  envelope.checksum = hashState(envelope.data);
  store.setItem(GRAPHICS_CHECKPOINT_KEY, JSON.stringify(envelope));
}

describe("one-shot full-state graphics restart checkpoint", () => {
  it("continues real simulation steps with pending mission commands identically to uninterrupted play", () => {
    const data = checkpoint(), store = memoryStorage();
    writeGraphicsCheckpoint(store, data);
    const restored = takeGraphicsCheckpoint(store, "sf", 3)!;
    expect(restored).not.toBeNull();
    expect(hashState(restored.state)).toBe(hashState(data.state));
    expect(restored.queuedEvents).toEqual(data.queuedEvents);
    expect(restored.recordedCommands).toEqual(data.recordedCommands);
    expect(restored.requestedMission).toBe("hot-desk");
    expect(restored.waypoint).toEqual(data.waypoint);
    let uninterrupted = data.state, resumed = restored.state;
    const originalSystems = createGameSystems({ wave: 3 }), resumedSystems = createGameSystems({ wave: 3 });
    for (let index = 0; index < 20; index++) {
      const input = { p1: { throttle: .6, steer: -.1, brake: 0, actions: index === 12 ? Action.enterExit : 0 } };
      uninterrupted = step(world, uninterrupted, input, index === 0 ? data.queuedEvents : [], originalSystems);
      resumed = step(world, resumed, input, index === 0 ? restored.queuedEvents : [], resumedSystems);
    }
    expect(hashState(resumed)).toBe(hashState(uninterrupted));
    expect(resumed).toEqual(uninterrupted);
    expect(resumed.ext.missions?.players.p1?.missionId).toBe("hot-desk");
    expect(takeGraphicsCheckpoint(store, "sf", 3)).toBeNull();
  });
  it("retains nested transient gameplay and taxi data instead of projecting a campaign save", () => {
    const data = checkpoint(), store = memoryStorage(), car = data.state.players.p1!.car;
    data.state.players.p1!.ride = { agentId: 412, manual: true, x: car.x, y: car.y, z: car.z, heading: car.heading, speed: car.speed,
      goal: { x: 700, z: 800 }, exitPending: false };
    data.state.ext.restartFixture = { mission: { phase: "washing", spinnerIds: ["spinner:1"], boards: [{ id: "board:2", wash: 74 }] },
      taxi: { phase: "driving", remainingTicks: 1340, rewarded: false }, traffic: [{ id: 412, speed: 5.7 }] };
    const before = JSON.stringify(data);
    writeGraphicsCheckpoint(store, data);
    const restored = takeGraphicsCheckpoint(store, "sf", 3)!;
    expect(JSON.stringify(restored)).toBe(before);
    expect(restored.state.players.p1!.ride?.manual).toBe(true);
    expect(restored.state.ext.restartFixture).toEqual(data.state.ext.restartFixture);
  });
  it("consumes mismatched world/wave checkpoints without altering unrelated save keys", () => {
    for (const [name, wave] of [["dev", 3], ["sf", 4]] as const) {
      const store = memoryStorage(); store.setItem("campaign-save", "keep this");
      writeGraphicsCheckpoint(store, checkpoint());
      expect(takeGraphicsCheckpoint(store, name, wave)).toBeNull();
      expect(store.getItem(GRAPHICS_CHECKPOINT_KEY)).toBeNull();
      expect(store.getItem("campaign-save")).toBe("keep this");
    }
  });
  it.each([
    (data: GraphicsCheckpoint) => { data.state.version = SIM_VERSION - 1; },
    (data: GraphicsCheckpoint) => { data.state.tick = -1; },
    (data: GraphicsCheckpoint) => { data.state.seed = .5; },
    (data: GraphicsCheckpoint) => { data.state.rng[0] = -1; },
    (data: GraphicsCheckpoint) => { data.state.players.p1!.id = "p2"; },
    (data: GraphicsCheckpoint) => { data.state.players = {}; },
    (data: GraphicsCheckpoint) => { data.queuedEvents[0]!.tick = data.state.tick; },
    (data: GraphicsCheckpoint) => { data.wave = 99; },
  ])("rejects incompatible or invalid state even if its checksum was recomputed (%#)", change => {
    const store = memoryStorage(); writeGraphicsCheckpoint(store, checkpoint());
    replaceData(store, change);
    expect(takeGraphicsCheckpoint(store, "sf", 3)).toBeNull();
    expect(store.getItem(GRAPHICS_CHECKPOINT_KEY)).toBeNull();
  });
  it("detects corruption in pending commands as well as simulation data", () => {
    const store = memoryStorage(); writeGraphicsCheckpoint(store, checkpoint());
    const envelope = JSON.parse(store.getItem(GRAPHICS_CHECKPOINT_KEY)!);
    envelope.data.queuedEvents[0].payload.targetId = "demo-day";
    store.setItem(GRAPHICS_CHECKPOINT_KEY, JSON.stringify(envelope));
    expect(takeGraphicsCheckpoint(store, "sf", 3)).toBeNull();
  });
  it.each(["broken JSON", "null", "[]", '{"schema":2,"checksum":"00000000","data":{}}'])("safely consumes malformed envelopes: %s", text => {
    const store = memoryStorage(); store.setItem(GRAPHICS_CHECKPOINT_KEY, text);
    expect(takeGraphicsCheckpoint(store, "sf", 3)).toBeNull();
    expect(store.getItem(GRAPHICS_CHECKPOINT_KEY)).toBeNull();
  });
  it("throws before restart on blocked/full storage and returns null for inaccessible reads/removal", () => {
    expect(() => writeGraphicsCheckpoint({ setItem() { throw new Error("quota full"); } }, checkpoint())).toThrow("quota full");
    expect(takeGraphicsCheckpoint({ getItem() { throw new Error("blocked"); }, removeItem() {} }, "sf", 3)).toBeNull();
    const store = memoryStorage(); writeGraphicsCheckpoint(store, checkpoint());
    expect(takeGraphicsCheckpoint({ getItem: store.getItem, removeItem() { throw new Error("blocked"); } }, "sf", 3)).toBeNull();
  });
  it("bounds encoded checkpoint size on write and before parsing a stored value", () => {
    const store = memoryStorage(), data = checkpoint();
    data.state.ext.restartFixture = { long: "x".repeat(GRAPHICS_CHECKPOINT_MAX_BYTES) };
    expect(() => writeGraphicsCheckpoint(store, data)).toThrow("too large");
    expect(store.getItem(GRAPHICS_CHECKPOINT_KEY)).toBeNull();
    store.setItem(GRAPHICS_CHECKPOINT_KEY, "x".repeat(GRAPHICS_CHECKPOINT_MAX_BYTES + 1));
    expect(takeGraphicsCheckpoint(store, "sf", 3)).toBeNull();
    expect(store.getItem(GRAPHICS_CHECKPOINT_KEY)).toBeNull();
  });
  it("refuses non-JSON fields rather than silently losing them during a restart", () => {
    const store = memoryStorage(), data = checkpoint();
    data.state.ext.restartFixture = { invalid: undefined };
    expect(() => writeGraphicsCheckpoint(store, data)).toThrow("plain JSON");
    data.state.ext.restartFixture = { invalid: Number.NaN };
    expect(() => writeGraphicsCheckpoint(store, data)).toThrow("plain JSON");
    data.state.ext.restartFixture = new Map([["value", 1]]);
    expect(() => writeGraphicsCheckpoint(store, data)).toThrow("plain objects");
    expect(store.getItem(GRAPHICS_CHECKPOINT_KEY)).toBeNull();
  });
});
