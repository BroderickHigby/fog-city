import { describe, expect, it } from "vitest";
import { FixedClock } from "../../../server/net/clock.ts";

describe("relay's fixed clock", () => {
  it("runs exactly 60 ticks per second despite an eight-millisecond timer", () => {
    const clock = new FixedClock(0);
    let ticks = 0;
    for (let ms = 8; ms <= 120_000; ms += 8) ticks += clock.take(ms);
    expect(ticks).toBe(7200);
  });
  it("bounds catch-up after a stall and ignores a reversed or invalid clock", () => {
    const clock = new FixedClock(1000);
    expect(clock.take(6000)).toBe(4);
    expect(clock.take(6000)).toBe(0);
    expect(clock.take(5000)).toBe(0);
    expect(clock.take(NaN)).toBe(0);
    expect(clock.take(6020)).toBe(1);
  });
});
