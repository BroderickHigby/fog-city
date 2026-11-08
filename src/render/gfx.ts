// Graphics tiers, the render-size budget and the step-down governor.
//
// Tiers, chosen once at boot from the GPU (chooseTier) unless ?gfx= names one:
//   high      known desktop discrete GPUs: the presentation chain with ambient occlusion and
//             full-resolution reflections, 3072 px shadow cascades, up to 3.7 MP
//   standard  Apple, Intel, laptop and unknown GPUs: the presentation chain without AO, 1536 px
//             cascades, up to 2.1 MP (a 1080p frame)
//   low       software rasterisers (every CI and e2e run), phones, and safe mode after the GPU
//             was lost: no post-processing, no shadows, 1.2 MP
// TIER_DETAIL holds the per-tier shadow, reflection, AO and anti-aliasing figures.
// The pixel budget caps the drawing buffer whatever the screen: a 5K display at device pixel
// ratio 2 asks for 14.7 MP, and with a half-float post chain and MSAA that alone can exhaust a
// laptop GPU and kill the tab.
//
// The governor (GfxGovernor) watches the render side of frame times (the frame less the time
// the sim's ticks took: SceneRenderer.frame) and steps down when that rate stays under
// GOVERNOR_MIN_FPS: the pixel budget first (twice, by a quarter each time), then the shadows,
// then the post chain. It never steps back up in a session. Explicit ?gfx= requests are honoured
// and not governed.
//
// Pure apart from the probe of a GL context: tests/render/gfx.test.ts.

export type GfxTier = "high" | "standard" | "low";
export type GfxRequest = GfxTier | "auto";

export interface GfxCaps {
  webgl2: boolean;
  /** UNMASKED_RENDERER_WEBGL when the browser exposes it, else RENDERER. */
  renderer: string;
  maxTextureSize: number;
  /** A phone or tablet (coarse pointer and a small screen). */
  mobile: boolean;
}

export interface GfxSettings {
  /** The presentation chain (grade, bloom, FXAA: quality.ts). */
  post: boolean;
  shadows: boolean;
  /** Most drawing-buffer pixels the renderer may use (device pixels). */
  pixelBudget: number;
  /** Highest device pixel ratio used, whatever the screen. */
  maxPixelRatio: number;
}

export const TIER_SETTINGS: Readonly<Record<GfxTier, Readonly<GfxSettings>>> = Object.freeze({
  high: { post: true, shadows: true, pixelBudget: 3_700_000, maxPixelRatio: 2 },
  standard: { post: true, shadows: true, pixelBudget: 2_100_000, maxPixelRatio: 1.5 },
  low: { post: false, shadows: false, pixelBudget: 1_200_000, maxPixelRatio: 1 },
});

/**
 * What each tier draws inside its shadows and its presentation chain (scene.ts, gpu-engine.ts,
 * quality.ts). Low draws neither, so its row only matters when a link forces ?shadows=1 or
 * ?quality=1; it keeps the values every tier used before this table existed.
 */
export interface GfxDetail {
  /** Node renderer: pixels per side of each of the sun's two shadow cascades. */
  cascadeMapSize: number;
  /** Legacy renderer: pixels per side of the one sun shadow map, and the half-width of the box it covers (m). */
  shadowMapSize: number;
  shadowHalf: number;
  /** Screen-space reflections on the wet road: buffer scale and ray-march quality (0..1). */
  reflectionScale: number;
  reflectionQuality: number;
  /** Ambient occlusion (GTAO, node renderer): its buffer scale, or 0 for none. */
  ambientOcclusion: number;
  /** Edge smoothing wherever the scene is drawn without MSAA (legacy chain; WebGL node backend). */
  antialias: "fxaa" | "smaa";
  /** Pixels per side of the sky's environment cube (reflections and the fog's colour). */
  environmentSize: number;
}

export const TIER_DETAIL: Readonly<Record<GfxTier, Readonly<GfxDetail>>> = Object.freeze({
  // Discrete desktop GPUs: the reference's 3072 px cascades (two of them: a 6144 x 3072 atlas,
  // about 75 MB), full-resolution reflections and half-resolution ambient occlusion.
  high: { cascadeMapSize: 3072, shadowMapSize: 4096, shadowHalf: 128, reflectionScale: 1, reflectionQuality: .5, ambientOcclusion: .5, antialias: "smaa", environmentSize: 256 },
  // Laptops and Apple GPUs: sharper shadows (a 3072 x 1536 atlas, about 19 MB) and SMAA, no AO.
  standard: { cascadeMapSize: 1536, shadowMapSize: 2048, shadowHalf: 96, reflectionScale: .5, reflectionQuality: .25, ambientOcclusion: 0, antialias: "smaa", environmentSize: 256 },
  low: { cascadeMapSize: 1024, shadowMapSize: 2048, shadowHalf: 96, reflectionScale: .5, reflectionQuality: .25, ambientOcclusion: 0, antialias: "fxaa", environmentSize: 128 },
});

/** The detail row for a tier; an unnamed tier (tests, tools) gets the low row. */
export function tierDetail(tier: GfxTier | "unknown" | undefined): Readonly<GfxDetail> {
  return tier === "high" || tier === "standard" ? TIER_DETAIL[tier] : TIER_DETAIL.low;
}

export interface GfxChoice {
  tier: GfxTier;
  requested: GfxRequest;
  /** Why the tier was chosen, for the HUD and the tests. */
  reason: string;
}

/** Renderers that are software rasterisers. */
export const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;
/** Desktop discrete GPUs trusted with the high tier (not laptop "Pro"/"Max-Q" parts or Apple). */
const DISCRETE_DESKTOP = /(geforce|rtx|quadro|nvidia)(?!.*(max-q|laptop|mobile))|radeon\s*(rx|vii|r9)(?!.*(pro|mobile|laptop))/i;

export function parseGfxRequest(value: string | null): GfxRequest {
  return value === "high" || value === "standard" || value === "low" ? value : "auto";
}

/**
 * The tier for this device. `safe`: the GPU was lost earlier in this session, so start low.
 */
export function chooseTier(requested: GfxRequest, caps: GfxCaps, safe = false): GfxChoice {
  if (requested !== "auto") return { tier: requested, requested, reason: `asked for ?gfx=${requested}` };
  if (safe) return { tier: "low", requested, reason: "safe mode: the GPU was reset earlier this session" };
  if (!caps.webgl2) return { tier: "low", requested, reason: "no WebGL2" };
  if (SOFTWARE_GPU.test(caps.renderer)) return { tier: "low", requested, reason: `software renderer (${caps.renderer})` };
  if (caps.mobile) return { tier: "low", requested, reason: "phone or tablet" };
  if (DISCRETE_DESKTOP.test(caps.renderer) && caps.maxTextureSize >= 16384) {
    return { tier: "high", requested, reason: `desktop GPU (${caps.renderer})` };
  }
  return { tier: "standard", requested, reason: `GPU (${caps.renderer || "unknown"})` };
}

/** What a GL context says about itself. */
export function probeCaps(gl: WebGLRenderingContext | WebGL2RenderingContext | null): GfxCaps {
  if (!gl) return { webgl2: false, renderer: "", maxTextureSize: 0, mobile: false };
  const webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String((ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "");
  const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0);
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const small = typeof screen !== "undefined" && Math.min(screen.width, screen.height) < 600;
  return { webgl2, renderer, maxTextureSize, mobile: coarse && small };
}

/** Probe the GPU on a throwaway canvas, then release that context straight away. */
export function probeGpu(): GfxCaps {
  if (typeof document === "undefined") return probeCaps(null);
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const caps = probeCaps(gl);
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  return caps;
}

/** Lowest pixel ratio the budget may push the renderer to. */
export const MIN_PIXEL_RATIO = 0.5;

/**
 * The renderer's pixel ratio for a canvas of cssWidth x cssHeight: the device's, capped by
 * maxPixelRatio and by the pixel budget, never under MIN_PIXEL_RATIO; rounded to 0.05.
 */
export function renderPixelRatio(devicePixelRatio: number, cssWidth: number, cssHeight: number, budget: number, maxPixelRatio: number): number {
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight);
  const r = Math.min(devicePixelRatio > 0 ? devicePixelRatio : 1, maxPixelRatio, Math.sqrt(budget / area));
  return Math.max(MIN_PIXEL_RATIO, Math.floor(r * 20) / 20);
}

export type GfxStep = "pixels" | "shadows" | "post";
/** Frame rate under which the governor steps down, and how long it must last (seconds). */
export const GOVERNOR_MIN_FPS = 24;
export const GOVERNOR_HOLD_S = 4;
/** Seconds after a step (or the start) before the governor judges again: tiles and shaders settle. */
export const GOVERNOR_GRACE_S = 10;
/** Each "pixels" step scales the budget by this. */
export const PIXEL_STEP = 0.75;

/** Steps a tier down when frames stay slow. Feed it real frame times; it answers what to drop. */
export class GfxGovernor {
  private slow = 0;
  private longFrames = 0;
  private grace = GOVERNOR_GRACE_S;
  private readonly steps: GfxStep[];
  readonly taken: GfxStep[] = [];

  /** `settings`: the tier's; steps it cannot take (shadows already off) are skipped. */
  constructor(enabled: boolean, settings: Readonly<GfxSettings>) {
    this.steps = !enabled ? [] : (["pixels", "pixels", "shadows", "post"] as GfxStep[]).filter((s) =>
      s === "pixels" ? true : s === "shadows" ? settings.shadows : settings.post);
  }

  /** One frame: the step to take now, or null. `busy`: tiles are loading, or the tab was hidden. */
  frame(seconds: number, busy: boolean): GfxStep | null {
    if (this.steps.length === 0 || !(seconds > 0) || !Number.isFinite(seconds)) return null;
    if (busy) {
      this.slow = 0;
      this.longFrames = 0;
      this.grace = Math.max(0, this.grace - Math.min(seconds, 1));
      return null;
    }
    // Ignore an isolated GC/shader stall, but sustained sub-1 FPS rendering is overload.
    // Cap its contribution so returning from one long suspension cannot skip all grace.
    this.longFrames = seconds > 1 ? this.longFrames + 1 : 0;
    if (seconds > 1 && this.longFrames < 3) return null;
    const elapsed = Math.min(seconds, 1);
    if (this.grace > 0) {
      this.grace -= elapsed;
      return null;
    }
    this.slow = 1 / seconds < GOVERNOR_MIN_FPS ? this.slow + elapsed : 0;
    if (this.slow < GOVERNOR_HOLD_S) return null;
    this.slow = 0;
    this.grace = GOVERNOR_GRACE_S;
    const step = this.steps.shift()!;
    this.taken.push(step);
    return step;
  }
}
