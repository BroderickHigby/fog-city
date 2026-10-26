// Drawing the clearance override (src/render/human-motion.ts leapDrawOffset; the dodge stream):
// the sim moves a body at once, the renderer draws a shove aside from where it was, eased, never
// faster than OVERRIDE_DRAW_MPS, never off the ground, ending exactly where the sim has it.
import { describe, expect, it } from "vitest";
import { DODGE_PROFILE, OVERRIDE_DRAW_MPS, leapShape, type DodgeState } from "../../src/sim/index.ts";
import { leapDrawOffset } from "../../src/render/human-motion.ts";

function leap(dist: number): DodgeState {
  const shape = leapShape(DODGE_PROFILE.person, dist);
  return { phase: "dive", sx: 0, sz: 0, tx: dist * 0.6, tz: -dist * 0.8, t: 0, dur: shape.dur, peak: shape.peak, hop: 0, leap: true, vx: 0, vz: 0, vmax: 4.8 };
}

describe("drawing the override's leap", () => {
  it("starts where the body was, ends where the sim put it, and moves no faster than OVERRIDE_DRAW_MPS on the way, for every leap the override makes", () => {
    const off = { x: 0, z: 0 };
    for (let dist = 0.05; dist <= 4 + 1e-9; dist += 0.05) {
      const d = leap(dist);
      // Drawn position: the sim's plus the offset, sampled 8 times a tick.
      const at = (t: number, a: number): [number, number] => {
        leapDrawOffset({ ...d, t }, a, off);
        return [d.tx + off.x, d.tz + off.z];
      };
      expect(at(0, 0)[0]).toBeCloseTo(d.sx, 12);
      expect(at(0, 0)[1]).toBeCloseTo(d.sz, 12);
      let prev = at(0, 0);
      let fastest = 0;
      for (let t = 0; t < d.dur; t++) {
        for (let k = 1; k <= 8; k++) {
          const p = at(t, k / 8);
          fastest = Math.max(fastest, Math.hypot(p[0] - prev[0], p[1] - prev[1]) * 60 * 8);
          prev = p;
        }
      }
      expect(fastest, `${dist.toFixed(2)} m`).toBeLessThanOrEqual(OVERRIDE_DRAW_MPS + 1e-6);
      expect(prev[0]).toBeCloseTo(d.tx, 12);
      expect(prev[1]).toBeCloseTo(d.tz, 12);
    }
  });

  it("is nothing for a run, a recovery or no dodge", () => {
    const off = { x: 9, z: 9 };
    expect(leapDrawOffset(null, 0.5, off)).toEqual({ x: 0, z: 0 });
    expect(leapDrawOffset({ ...leap(2), leap: false }, 0.5, off)).toEqual({ x: 0, z: 0 });
    expect(leapDrawOffset({ ...leap(2), phase: "recover" }, 0.5, off)).toEqual({ x: 0, z: 0 });
  });
});
