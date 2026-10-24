import { describe, expect, it } from "vitest";
import { FramePacer, MAX_CATCHUP_TICKS } from "../../src/frame-pacer.ts";

const DT = 1 / 60;

/** Run `frames` frames of `frameS` each where every tick costs `tickMs`; returns ticks run per frame. */
function drive(pacer: FramePacer, frames: number, frameS: number, tickMs: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    pacer.begin(frameS);
    let n = 0;
    while (pacer.wantTick()) {
      pacer.ticked(tickMs);
      n++;
    }
    pacer.end();
    out.push(n);
  }
  return out;
}

describe("frame pacer", () => {
  it("runs one tick per 60 Hz frame and is not slow when the sim keeps up", () => {
    const pacer = new FramePacer(DT);
    const ran = drive(pacer, 600, DT, 2);
    expect(ran.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(599);
    expect(pacer.stats().slow).toBe(false);
    expect(pacer.stats().droppedTicks).toBe(0);
    expect(pacer.stats().speed).toBeGreaterThan(0.99);
  });

  it("catches up a short hitch in full", () => {
    const pacer = new FramePacer(DT);
    drive(pacer, 10, DT, 2);
    expect(drive(pacer, 1, 3 * DT, 2)).toEqual([3]);
    expect(pacer.stats().ticksThisFrame).toBe(3);
    expect(pacer.stats().droppedTicks).toBe(0);
  });

  it("never runs more than the cap in one frame, and drops the rest instead of spiralling", () => {
    const pacer = new FramePacer(DT);
    const ran = drive(pacer, 100, 0.25, 1);
    expect(Math.max(...ran)).toBe(MAX_CATCHUP_TICKS);
    // The backlog never grows: every frame is still capped and the fraction stays under a tick.
    expect(pacer.alpha()).toBeLessThan(1);
    expect(pacer.stats().slow).toBe(true);
    expect(pacer.stats().speed).toBeLessThan(0.5);
  });

  it("stops catching up once the frame's sim budget is spent, but always runs one tick", () => {
    const pacer = new FramePacer(DT);
    // 30 ms ticks: over the 24 ms budget after one.
    const ran = drive(pacer, 60, 4 * DT, 30);
    expect(ran.every((n) => n === 1)).toBe(true);
    expect(pacer.stats().slow).toBe(true);
    expect(pacer.stats().tickMs).toBeCloseTo(30, 5);
  });

  it("clears the slow flag once the sim keeps up again", () => {
    const pacer = new FramePacer(DT);
    drive(pacer, 30, 4 * DT, 30);
    expect(pacer.stats().slow).toBe(true);
    drive(pacer, 60, DT, 2);
    expect(pacer.stats().slow).toBe(false);
  });

  it("reset forgets the backlog", () => {
    const pacer = new FramePacer(DT);
    pacer.begin(0.2);
    pacer.reset();
    expect(pacer.wantTick()).toBe(false);
    expect(pacer.alpha()).toBe(0);
  });
});
