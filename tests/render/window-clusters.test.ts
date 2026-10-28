// Distant lit-window clusters (src/render/window-clusters.ts): the CPU reference of the shader
// math in node-materials.ts. The two properties that decide whether a night skyline looks right
// are tested here: the mean brightness is the lit probability at every distance, and the output
// is continuous in the camera's position, so it twinkles in place rather than shimmering.
// The shader graph itself is checked on a GPU (QA screenshots in the pull request), not here.
import { describe, expect, it } from "vitest";
import {
  CLUSTER_GAIN, CLUSTER_MIN_SCALE, CLUSTER_SWITCH_RATE, boxPulse, clusterLevel, clusterLight, clusterRoll, switchLevel, windowLod,
  type ClusterHash,
} from "../../src/render/window-clusters.ts";

// The shader's own roll (salted by cluster size), for a facade with seed 0.
const hash: ClusterHash = (ix, iy, size) => clusterRoll(ix, iy, size, 0);

describe("clusterRoll", () => {
  it("gives each cluster size its own pattern, so a cross-fade re-rolls rather than zooming", () => {
    // Same cell index at size 2 and 4: independent rolls agree on lit/dark about p^2 + (1-p)^2 of the time.
    const p = 0.32;
    let same = 0, n = 0;
    for (let ix = -40; ix < 40; ix++) for (let iy = -40; iy < 40; iy++) {
      same += (clusterRoll(ix, iy, 2, 0) >= 1 - p) === (clusterRoll(ix, iy, 4, 0) >= 1 - p) ? 1 : 0; n++;
    }
    expect(same / n).toBeGreaterThan(p * p + (1 - p) * (1 - p) - 0.05);
    expect(same / n).toBeLessThan(p * p + (1 - p) * (1 - p) + 0.05);
  });

  it("is uniform on [0, 1)", () => {
    const bins = new Array(10).fill(0);
    for (let ix = 0; ix < 100; ix++) for (let iy = 0; iy < 100; iy++) bins[Math.floor(clusterRoll(ix, iy, 8, 3.7) * 10)]++;
    for (const count of bins) { expect(count).toBeGreaterThan(850); expect(count).toBeLessThan(1150); }
  });
});

describe("boxPulse", () => {
  it("is exact on the interior and converges to the duty cycle over a wide footprint", () => {
    expect(boxPulse(0.5, 0.25, 0.75, 0.01)).toBeCloseTo(1, 6);
    expect(boxPulse(0.1, 0.25, 0.75, 0.01)).toBeCloseTo(0, 6);
    // A footprint of whole periods covers the pulse exactly its duty cycle (0.5) of the time.
    for (const x of [0, 0.3, 2.71]) expect(boxPulse(x, 0.25, 0.75, 4)).toBeCloseTo(0.5, 6);
  });
});

describe("window regime", () => {
  it("hands over from room shading to clusters between 0.28 and 0.8 cells per pixel", () => {
    expect(windowLod(0.1, 0.1)).toBe(0);
    expect(windowLod(0.28, 0.2)).toBe(0);
    expect(windowLod(0.8, 0)).toBe(1);
    expect(windowLod(0.3, 0.3)).toBeGreaterThan(0);
    let last = 0;
    for (let f = 0; f <= 1.2; f += 0.01) { const lod = windowLod(f, f / 2); expect(lod).toBeGreaterThanOrEqual(last); last = lod; }
  });

  it("never clusters smaller than two window cells, and doubles as the footprint doubles", () => {
    expect(clusterLevel(0.01, 0.01)).toBe(Math.log2(CLUSTER_MIN_SCALE));
    expect(clusterLevel(2, 1) - clusterLevel(1, 1)).toBeCloseTo(1, 12);
  });
});

describe("clusterLight", () => {
  const probability = 0.32;

  it.each([[0.3, 0.3], [0.6, 0.45], [1, 1], [2.3, 0.9], [5, 5]])("averages the lit probability at footprint %s x %s", (fx, fy) => {
    // Enough clusters that the Bernoulli mean settles: 600 x 600 cells.
    let sum = 0, n = 0;
    for (let gx = 0.13; gx < 600; gx += 0.71) for (let gy = 0.29; gy < 600; gy += 0.83) { sum += clusterLight(gx, gy, fx, fy, probability, hash); n++; }
    expect(sum / n).toBeGreaterThan(probability - 0.04);
    expect(sum / n).toBeLessThan(probability + 0.04);
  });

  it("is zero where the probability is zero and a full core where it is one", () => {
    expect(clusterLight(3.4, 8.8, 0.5, 0.5, 0, hash)).toBe(0);
    // Footprint well under a cluster: the lit core is whole and carries the compensating gain.
    expect(clusterLight(1.0, 1.0, 0.05, 0.05, 1, hash)).toBeCloseTo(CLUSTER_GAIN, 6);
  });

  it.each([0.3, 0.6, 1.1, 2.3, 7])("moves smoothly with the camera at footprint %s (no shimmer)", footprint => {
    // A sub-pixel step must change a pixel by at most about gain x step: no flicker, no pops
    // at cluster edges or where two cluster sizes cross-fade.
    const step = 0.01;
    const bound = (CLUSTER_GAIN * 2 * step) * 1.05 + 1e-9;
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const gx = 12.31 + i * step * footprint;
      const a = clusterLight(gx, 40.7, footprint, footprint * 0.8, probability, hash);
      const b = clusterLight(gx + step * footprint, 40.7, footprint, footprint * 0.8, probability, hash);
      worst = Math.max(worst, Math.abs(b - a));
      const c = clusterLight(77.2, gx, footprint, footprint * 0.8, probability, hash);
      const d = clusterLight(77.2, gx + step * footprint, footprint, footprint * 0.8, probability, hash);
      worst = Math.max(worst, Math.abs(d - c));
    }
    expect(worst).toBeLessThanOrEqual(bound);
  });

  it("changes smoothly as the camera moves toward a building (the footprint shrinks)", () => {
    // Cross-fade between cluster sizes: sweep the footprint through two octaves at a fixed point.
    let last = clusterLight(55.5, 21.3, 0.28, 0.28, probability, hash), worst = 0;
    for (let f = 0.28; f < 1.4; f += 0.001) {
      const v = clusterLight(55.5, 21.3, f, f, probability, hash);
      worst = Math.max(worst, Math.abs(v - last)); last = v;
    }
    // A cluster edge sweeping across the pixel can move the value by gain x filter slope; a pop would be >= 1.
    expect(worst).toBeLessThan(0.1);
  });
});

describe("switchLevel", () => {
  const probability = 0.32;
  it.each(CLUSTER_SWITCH_RATE)("keeps the lit probability over a full turn at rate %s", rate => {
    const period = (2 * Math.PI) / rate;
    let sum = 0; const n = 20000;
    for (let i = 0; i < n; i++) sum += switchLevel((i / n) * period, rate, 1.3, probability);
    expect(sum / n).toBeGreaterThan(probability - 0.03);
    expect(sum / n).toBeLessThan(probability + 0.03);
  });

  it("fades over seconds, never switching in a frame", () => {
    for (const rate of CLUSTER_SWITCH_RATE) {
      let worst = 0, last = switchLevel(0, rate, 0.4, probability);
      for (let t = 0.05; t < (4 * Math.PI) / rate; t += 0.05) {
        const v = switchLevel(t, rate, 0.4, probability);
        worst = Math.max(worst, Math.abs(v - last)); last = v;
      }
      expect(worst).toBeLessThan(0.06);
    }
  });
});
