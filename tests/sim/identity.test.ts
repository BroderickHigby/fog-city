import { describe, expect, it } from "vitest";
import { allocateActorIds, buildWorld, createInitialState } from "../../src/sim/index.ts";
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
  it("rejects unsafe keys and leaves empty reservations unchanged", () => {
    const state = createInitialState(buildWorld([]), 1, [], { x: 0, z: 0, heading: 0 });
    expect(allocateActorIds(state, []).state).toBe(state);
    expect(() => allocateActorIds(state, ["__proto__"])).toThrow();
    expect(() => allocateActorIds(state, ["constructor"])).toThrow();
  });
});
