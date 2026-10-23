import { describe, expect, it } from "vitest";
import { calendarAt, calendarEpoch, DAY_TICKS, WEEK_TICKS, gameTime, createClockSystem, createInitialState, step, fogDensity, buildWorld } from "../../src/sim/index.ts";

describe("seeded game calendar", () => {
  const epoch = { year: 2031, month: 1, day: 1, hour: 8 };
  it("maps known ticks through midnight, weeks, months and leap years", () => {
    expect(calendarAt(1, 0, epoch)).toMatchObject({ year: 2031, month: 1, day: 1, hour: 8, weekday: 3, gameWeek: 1 });
    expect(calendarAt(1, 16 * 3600, epoch)).toMatchObject({ day: 2, hour: 0, weekday: 4 });
    expect(calendarAt(1, WEEK_TICKS, epoch)).toMatchObject({ day: 8, hour: 8, gameWeek: 2 });
    expect(calendarAt(1, 31 * DAY_TICKS, epoch)).toMatchObject({ month: 2, day: 1 });
    expect(calendarAt(1, DAY_TICKS, { year: 2032, month: 2, day: 28, hour: 0 })).toMatchObject({ month: 2, day: 29 });
    expect(calendarAt(1, DAY_TICKS, { year: 2100, month: 2, day: 28, hour: 0 })).toMatchObject({ month: 3, day: 1 });
  });
  it("alternates four summer and four winter weeks without consuming simulation RNG", () => {
    expect(calendarAt(1, 4 * WEEK_TICKS).season).toBe("winter");
    expect(calendarAt(1, 8 * WEEK_TICKS).season).toBe("summer");
    expect(calendarEpoch(91)).toEqual(calendarEpoch(91));
    expect(calendarEpoch(91)).not.toEqual(calendarEpoch(92));
    expect(() => calendarAt(0, -1)).toThrow();
    expect(() => calendarAt(0, Infinity)).toThrow();
  });
  it("advances by fixed ticks and can hold game time while outer ticks continue", () => {
    const world = buildWorld([]);
    let state = createInitialState(world, 19, [], { x: 0, z: 0, heading: 0 });
    state = step(world, state, {}, [], [createClockSystem()]);
    const before = gameTime(state);
    const rng = state.rng;
    state = step(world, state, {}, [], []);
    expect(gameTime(state)).toEqual(before);
    expect(state.rng).toEqual(rng);
    expect(fogDensity(world, state, 100, -100)).toBe(0);
    expect(fogDensity(world, state, NaN, Infinity)).toBe(0);
  });
});
