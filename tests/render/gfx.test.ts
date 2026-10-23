// The graphics tiers (src/render/gfx.ts): what auto picks, and how the governor steps down.

import { describe, expect, it } from "vitest";
import { GOVERNOR_GRACE_S, GOVERNOR_HOLD_S, GfxGovernor, chooseTier, featuresFor, parseGfxRequest, type GfxCaps } from "../../src/render/gfx.ts";

const gpu: GfxCaps = { webgl2: true, renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)", maxTextureSize: 16384, mobile: false };

describe("chooseTier", () => {
  it("auto picks high on a hardware GPU and default on software rasterisers, phones and small GPUs", () => {
    expect(chooseTier("auto", gpu).tier).toBe("high");
    for (const renderer of ["Google SwiftShader", "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", "llvmpipe (LLVM 15.0.7, 256 bits)", "Microsoft Basic Render Driver"]) {
      expect(chooseTier("auto", { ...gpu, renderer }).tier, renderer).toBe("default");
    }
    expect(chooseTier("auto", { ...gpu, mobile: true }).tier).toBe("default");
    expect(chooseTier("auto", { ...gpu, webgl2: false }).tier).toBe("default");
    expect(chooseTier("auto", { ...gpu, maxTextureSize: 4096 }).tier).toBe("default");
  });

  it("takes ?gfx= at its word, and anything else is auto", () => {
    expect(chooseTier("high", { ...gpu, renderer: "SwiftShader" }).tier).toBe("high");
    expect(chooseTier("default", gpu).tier).toBe("default");
    expect(parseGfxRequest("high")).toBe("high");
    expect(parseGfxRequest("default")).toBe("default");
    expect(parseGfxRequest(null)).toBe("auto");
    expect(parseGfxRequest("ultra")).toBe("auto");
  });

  it("the default tier adds nothing (shadows only when ?shadows=1 asks)", () => {
    expect(featuresFor("default", false)).toEqual({ reflections: false, post: false, shadows: false, detail: false, showcase: false, characters: false });
    expect(featuresFor("default", true).shadows).toBe(true);
    expect(Object.values(featuresFor("high", false)).every(Boolean)).toBe(true);
  });
});

describe("GfxGovernor", () => {
  const run = (g: GfxGovernor, fps: number, seconds: number, busy = false): string[] => {
    const out: string[] = [];
    for (let t = 0; t < seconds; t += 1 / fps) {
      const d = g.frame(1 / fps, busy);
      if (d) out.push(d);
    }
    return out;
  };

  it("steps down reflections, then post-processing, then shadows, after a hold of slow frames each", () => {
    const g = new GfxGovernor(true);
    expect(run(g, 20, GOVERNOR_GRACE_S + GOVERNOR_HOLD_S - 0.5)).toEqual([]);
    expect(run(g, 20, 1)).toEqual(["reflections"]);
    expect(run(g, 20, GOVERNOR_GRACE_S + GOVERNOR_HOLD_S + 0.5)).toEqual(["post"]);
    expect(run(g, 20, GOVERNOR_GRACE_S + GOVERNOR_HOLD_S + 0.5)).toEqual(["shadows"]);
    expect(run(g, 20, 60)).toEqual([]);
    expect(g.dropped).toEqual(["reflections", "post", "shadows"]);
  });

  it("never steps down at a good frame rate, while tiles load, or when disabled (?gfx=high)", () => {
    expect(run(new GfxGovernor(true), 60, 120)).toEqual([]);
    expect(run(new GfxGovernor(true), 10, 120, true)).toEqual([]);
    expect(run(new GfxGovernor(false), 5, 120)).toEqual([]);
  });

  it("a slow spell shorter than the hold is forgiven", () => {
    const g = new GfxGovernor(true);
    run(g, 60, GOVERNOR_GRACE_S + 0.1);
    for (let k = 0; k < 10; k++) {
      expect(run(g, 20, GOVERNOR_HOLD_S - 1)).toEqual([]);
      expect(run(g, 60, 1)).toEqual([]);
    }
  });
});
