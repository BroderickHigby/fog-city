import { describe, expect, it } from "vitest";
import { datan, datan2, dcos, dsin, wrapAngle } from "../../src/sim/dmath.ts";

describe("deterministic math", () => {
  it("dsin/dcos match Math within 1e-7 over a wide range", () => {
    for (let i = -20000; i <= 20000; i++) {
      const x = i * 0.00377;
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-7);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-7);
    }
  });

  it("datan/datan2 match Math within 1e-7", () => {
    for (let i = -5000; i <= 5000; i++) {
      const t = i * 0.0131;
      expect(Math.abs(datan(t) - Math.atan(t))).toBeLessThan(1e-7);
    }
    for (let a = 0; a < 360; a += 1.7) {
      const r = (a * Math.PI) / 180;
      const y = Math.sin(r) * 3.3;
      const x = Math.cos(r) * 3.3;
      expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-7);
    }
  });

  it("wrapAngle lands in [-PI, PI)", () => {
    for (let i = -100; i <= 100; i++) {
      const w = wrapAngle(i * 0.9);
      expect(w).toBeGreaterThanOrEqual(-Math.PI);
      expect(w).toBeLessThan(Math.PI);
    }
  });
});
