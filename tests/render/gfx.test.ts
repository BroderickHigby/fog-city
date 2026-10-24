// Graphics tiers, the pixel budget and the governor (src/render/gfx.ts).
import { describe, expect, it } from "vitest";
import { GOVERNOR_GRACE_S, GOVERNOR_HOLD_S, GfxGovernor, MIN_PIXEL_RATIO, TIER_SETTINGS, chooseTier, parseGfxRequest, renderPixelRatio, type GfxCaps } from "../../src/render/gfx.ts";

const caps = (renderer: string, over: Partial<GfxCaps> = {}): GfxCaps => ({ webgl2: true, renderer, maxTextureSize: 16384, mobile: false, ...over });

describe("chooseTier", () => {
  it("keeps the high tier for desktop discrete GPUs only", () => {
    expect(chooseTier("auto", caps("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)")).tier).toBe("high");
    expect(chooseTier("auto", caps("AMD Radeon RX 6600")).tier).toBe("high");
    expect(chooseTier("auto", caps("NVIDIA GeForce RTX 3050 Laptop GPU")).tier).toBe("standard");
    expect(chooseTier("auto", caps("NVIDIA GeForce RTX 3060", { maxTextureSize: 8192 })).tier).toBe("standard");
  });

  it("gives Apple, Intel, Mac Radeon Pro and unknown GPUs the standard tier", () => {
    for (const r of ["ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)", "Apple GPU", "AMD Radeon Pro 5500 XT OpenGL Engine", "Intel(R) Iris(R) Xe Graphics", ""]) {
      expect(chooseTier("auto", caps(r)).tier, r).toBe("standard");
    }
  });

  it("goes low on software renderers, phones, no WebGL2 and in safe mode; honours ?gfx=", () => {
    expect(chooseTier("auto", caps("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)")).tier).toBe("low");
    expect(chooseTier("auto", caps("Apple GPU", { mobile: true })).tier).toBe("low");
    expect(chooseTier("auto", caps("Apple GPU", { webgl2: false })).tier).toBe("low");
    expect(chooseTier("auto", caps("NVIDIA GeForce RTX 4090"), true).tier).toBe("low");
    expect(chooseTier("high", caps("SwiftShader")).tier).toBe("high");
    expect(parseGfxRequest("standard")).toBe("standard");
    expect(parseGfxRequest("ultra")).toBe("auto");
  });
});

describe("renderPixelRatio", () => {
  it("caps a 5K screen at the tier's pixel budget", () => {
    // A 5K iMac window: 2560 x 1440 CSS pixels at DPR 2 would be 14.7 MP.
    const r = renderPixelRatio(2, 2560, 1440, TIER_SETTINGS.standard.pixelBudget, TIER_SETTINGS.standard.maxPixelRatio);
    expect(2560 * r * 1440 * r).toBeLessThanOrEqual(TIER_SETTINGS.standard.pixelBudget);
    expect(r).toBeGreaterThan(0.7);
  });

  it("keeps the device ratio when it fits, never exceeds the cap and never drops under the floor", () => {
    expect(renderPixelRatio(1, 1280, 720, TIER_SETTINGS.high.pixelBudget, 2)).toBe(1);
    expect(renderPixelRatio(3, 400, 300, TIER_SETTINGS.high.pixelBudget, 2)).toBe(2);
    expect(renderPixelRatio(2, 8000, 8000, 1000, 2)).toBe(MIN_PIXEL_RATIO);
  });
});

describe("GfxGovernor", () => {
  const run = (g: GfxGovernor, seconds: number, frameS: number, busy = false): string[] => {
    const steps: string[] = [];
    for (let t = 0; t < seconds; t += frameS) { const s = g.frame(frameS, busy); if (s) steps.push(s); }
    return steps;
  };

  it("does nothing while frames are fast, or for a disabled (explicitly chosen) tier", () => {
    expect(run(new GfxGovernor(true, TIER_SETTINGS.standard), 120, 1 / 60)).toEqual([]);
    expect(run(new GfxGovernor(false, TIER_SETTINGS.standard), 120, 1 / 10)).toEqual([]);
  });

  it("steps down pixels twice, then shadows, then post, one step per hold after a grace period", () => {
    const g = new GfxGovernor(true, TIER_SETTINGS.standard);
    expect(run(g, GOVERNOR_GRACE_S - 1, 1 / 10)).toEqual([]);
    const all = run(g, 200, 1 / 10);
    expect(all).toEqual(["pixels", "pixels", "shadows", "post"]);
    expect(g.taken).toEqual(all);
    // Each step waits out the grace and a full hold of slow frames.
    expect(GOVERNOR_HOLD_S).toBeGreaterThan(1);
  });

  it("ignores frames while tiles load and single long stalls", () => {
    const g = new GfxGovernor(true, TIER_SETTINGS.standard);
    expect(run(g, 60, 1 / 10, true)).toEqual([]);
    expect(run(g, 60, 2)).toEqual([]);
  });

  it("skips steps the tier cannot take", () => {
    expect(run(new GfxGovernor(true, TIER_SETTINGS.low), 200, 1 / 10)).toEqual(["pixels", "pixels"]);
  });
});
