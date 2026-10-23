import { describe, expect, it } from "vitest";
import { MAX_ACTOR_IDENTITIES, allocateActorIds, buildWorld, createInitialState, releaseActorIds, step, type AgentMotionProposal, type SimSystem } from "../../src/sim/index.ts";
import { deepFreeze } from "../helpers.ts";

describe("shared actor identities", () => {
  it("reserves deterministically, reuses stable names and keeps ambient allocation ahead", () => {
    const initial = deepFreeze(createInitialState(buildWorld([]), 1, [], { x: 0, z: 0, heading: 0 }));
    const a = allocateActorIds(initial, ["mission:one:b", "mission:one:a"]);
    const b = allocateActorIds(initial, ["mission:one:a", "mission:one:b"]);
    expect(a).toEqual(b);
    expect(a.ids).toEqual({ "mission:one:a": 1, "mission:one:b": 2 });
    expect(a.state.ext.agents!.nextId).toBe(3);
    const next = allocateActorIds({ ...a.state, ext: { ...a.state.ext, agents: { nextId: 20, list: [] } } }, ["mission:one:a", "service:van"]);
    expect(next.ids).toEqual({ "mission:one:a": 1, "service:van": 20 });
    expect(next.state.ext.agents!.nextId).toBe(21);
    expect(initial.ext).toEqual({});
  });
  it("releases retired names without ever reusing a numeric ID", () => {
    const initial = createInitialState(buildWorld([]), 1, [], { x: 0, z: 0, heading: 0 });
    const a = allocateActorIds(initial, ["transit:f:1", "transit:f:2"]);
    expect(releaseActorIds(a.state, ["unbound"])).toBe(a.state);
    const released = releaseActorIds(deepFreeze(a.state), ["transit:f:1"]);
    expect(released.ext.identities!.ids).toEqual({ "transit:f:2": 2 });
    expect(a.state.ext.identities!.ids).toEqual({ "transit:f:1": 1, "transit:f:2": 2 });
    const again = allocateActorIds(released, ["transit:f:1"]);
    expect(again.ids).toEqual({ "transit:f:1": 3 });
    expect(again.state.ext.identities!.nextId).toBe(4);
  });
  it("drops the oldest bodiless bindings at capacity instead of failing the tick", () => {
    const initial = createInitialState(buildWorld([]), 1, [], { x: 0, z: 0, heading: 0 });
    const ids: Record<string, number> = {};
    for (let i = 0; i < MAX_ACTOR_IDENTITIES; i++) ids[`leak:${String(i).padStart(5, "0")}`] = i + 1;
    const body = { id: 1, runtimeId: "leak:00000" } as NonNullable<typeof initial.ext.agents>["list"][number];
    const full = { ...initial, ext: { identities: { version: 1 as const, nextId: MAX_ACTOR_IDENTITIES + 1, ids }, agents: { nextId: MAX_ACTOR_IDENTITIES + 1, list: [body] } } };
    const next = allocateActorIds(full, ["leak:00002", "new:a", "new:b"]);
    expect(next.ids).toEqual({ "leak:00002": 3, "new:a": MAX_ACTOR_IDENTITIES + 1, "new:b": MAX_ACTOR_IDENTITIES + 2 });
    const kept = next.state.ext.identities!.ids;
    expect(Object.keys(kept)).toHaveLength(MAX_ACTOR_IDENTITIES);
    // leak:00000 has a body and leak:00002 was asked for; leak:00001 and leak:00003 go.
    expect([kept["leak:00000"], kept["leak:00001"], kept["leak:00002"], kept["leak:00003"], kept["leak:00004"]]).toEqual([1, undefined, 3, undefined, 5]);
  });
  it("releases an actor's binding when its system retires it during step()", () => {
    const world = buildWorld([]);
    const motion: AgentMotionProposal = { id: "service:van", numericId: 0, legacyId: null, kind: "walker", x: 10, y: 0, z: 10, heading: 0, speed: 0, radius: .4, height: 1.8, sourceX: 10, sourceY: 0, sourceZ: 10 };
    const spawn: SimSystem = { key: "robots", prepare: ctx => {
      const reserved = allocateActorIds(ctx.state, ["service:van"]);
      return { state: reserved.state, motions: [{ ...motion, numericId: reserved.ids["service:van"]! }] };
    }, step: ctx => ctx.state };
    const retire: SimSystem = { key: "robots", prepare: ctx => ({ state: ctx.state, motions: [], retirements: ["service:van"] }), step: ctx => ctx.state };
    const live = step(world, createInitialState(world, 1, ["p1"], { x: 0, z: 0, heading: 0 }), {}, [], [spawn]);
    expect(live.ext.identities!.ids).toEqual({ "service:van": 1 });
    expect(live.ext.agents!.list.map(body => body.runtimeId)).toEqual(["service:van"]);
    const gone = step(world, live, {}, [], [retire]);
    expect(gone.ext.identities!.ids).toEqual({});
    expect(gone.ext.agents!.list).toHaveLength(0);
    expect(gone.ext.identities!.nextId).toBe(2);
  });
  it("rejects unsafe keys and leaves empty reservations unchanged", () => {
    const state = createInitialState(buildWorld([]), 1, [], { x: 0, z: 0, heading: 0 });
    expect(allocateActorIds(state, []).state).toBe(state);
    expect(() => allocateActorIds(state, ["__proto__"])).toThrow();
    expect(() => allocateActorIds(state, ["constructor"])).toThrow();
  });
});
