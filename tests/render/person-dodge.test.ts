// The placeholder crowd getting out of a car's way (src/render/person.ts dodgePose, strideFor;
// the dodge stream): a startle, then a run whose steps lengthen with speed (the gait advances with
// distance, so the feet never slide), a stumble for the override, a breath to recover. Never a hop.
import { describe, expect, it } from "vitest";
import { RUN_LEAN, RUN_LEG, STRIDE_M, RUN_STRIDE_M, WALK_LEG, dodgePose, strideFor, type PersonPose } from "../../src/render/person.ts";

const pose = (): PersonPose => ({ lean: 0, legGain: 0, armGain: 0, armOut: 0 });
const dive = (t: number, leap = false, dur = 60) => ({ phase: "dive" as const, t, dur, leap });

describe("the placeholder person dodging", () => {
  it("walks as before when not dodging", () => {
    expect(dodgePose(null, 1.3, pose())).toEqual({ lean: 0, legGain: WALK_LEG, armGain: 0.34, armOut: 0 });
    expect(strideFor(1.3)).toBe(STRIDE_M);
  });

  it("runs: longer steps, a bigger swing and a forward lean as it speeds up", () => {
    const run = dodgePose(dive(40), 4.8, pose());
    expect(run.legGain).toBeCloseTo(RUN_LEG, 9);
    expect(run.lean).toBeCloseTo(RUN_LEAN, 9);
    expect(run.armOut).toBe(0);
    expect(strideFor(4.8)).toBe(RUN_STRIDE_M);
    expect(strideFor(3)).toBeGreaterThan(STRIDE_M);
    expect(strideFor(3)).toBeLessThan(RUN_STRIDE_M);
  });

  it("startles first (arms flare, a rock back), then runs", () => {
    const start = dodgePose(dive(1), 0.2, pose());
    expect(start.armOut).toBeGreaterThan(0.4);
    expect(start.lean).toBeLessThan(0);
    expect(dodgePose(dive(20), 3, pose()).armOut).toBe(0);
  });

  it("the override's jump reads as a stumble back with the arms thrown out, and the recovery as a breath", () => {
    const mid = dodgePose(dive(7, true, 14), 0, pose());
    expect(mid.lean).toBeLessThan(-0.2);
    expect(mid.armOut).toBeGreaterThan(1);
    const rec = dodgePose({ phase: "recover", t: 0, dur: 36, leap: false }, 0, pose());
    expect(rec.lean).toBeGreaterThan(0);
    expect(dodgePose({ phase: "recover", t: 36, dur: 36, leap: false }, 0, pose()).lean).toBe(0);
  });
});
