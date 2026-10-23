// Graphics tiers. "default" is the renderer every budget test measures (no post-processing, no
// shadows unless ?shadows=1). "high" adds what a current-gen game would draw: soft sun shadows,
// ground-truth ambient occlusion, bloom, generated PBR detail maps on the ground, and the Ferry
// Building showcase's street furniture (showcase.ts). The tier comes from ?gfx=high|default|auto
// (auto when absent): auto picks high on a hardware WebGL2 GPU with large textures, and default on
// a software rasteriser (SwiftShader, llvmpipe: every CI and e2e run) or a phone. A high tier that
// auto chose and that cannot hold its frame rate steps down by itself (GfxGovernor): first the
// post-processing, then the shadows; it never steps back up in the same session. ?gfx=high is
// taken at its word and never steps down.
//
// Pure apart from the probe of the GL context: tests/render/gfx.test.ts.

export type GfxTier = "default" | "high";
export type GfxRequest = GfxTier | "auto";

export interface GfxCaps {
  webgl2: boolean;
  /** UNMASKED_RENDERER_WEBGL when the browser exposes it, else RENDERER. */
  renderer: string;
  maxTextureSize: number;
  /** A phone or tablet (coarse pointer and a small screen). */
  mobile: boolean;
}

export interface GfxChoice {
  tier: GfxTier;
  requested: GfxRequest;
  /** Why the tier was chosen, for the HUD and the tests. */
  reason: string;
}

/** Renderers that are software rasterisers: the high tier would run at a frame a second. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;

export function parseGfxRequest(value: string | null): GfxRequest {
  return value === "high" || value === "default" ? value : "auto";
}

export function chooseTier(requested: GfxRequest, caps: GfxCaps): GfxChoice {
  if (requested !== "auto") return { tier: requested, requested, reason: `asked for ?gfx=${requested}` };
  if (!caps.webgl2) return { tier: "default", requested, reason: "no WebGL2" };
  if (SOFTWARE.test(caps.renderer)) return { tier: "default", requested, reason: `software renderer (${caps.renderer})` };
  if (caps.mobile) return { tier: "default", requested, reason: "phone or tablet" };
  if (caps.maxTextureSize < 8192) return { tier: "default", requested, reason: `small textures (${caps.maxTextureSize})` };
  return { tier: "high", requested, reason: `hardware GPU (${caps.renderer})` };
}

/** What the GL context says about itself. */
export function probeCaps(gl: WebGLRenderingContext | WebGL2RenderingContext): GfxCaps {
  const webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String((ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "");
  const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0);
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const small = typeof screen !== "undefined" && Math.min(screen.width, screen.height) < 600;
  return { webgl2, renderer, maxTextureSize, mobile: coarse && small };
}

/** The high tier's features, each of which the governor may switch off. */
export interface GfxFeatures {
  post: boolean;
  shadows: boolean;
  detail: boolean;
  showcase: boolean;
}

export function featuresFor(tier: GfxTier, shadowsAsked: boolean): GfxFeatures {
  return tier === "high"
    ? { post: true, shadows: true, detail: true, showcase: true }
    : { post: false, shadows: shadowsAsked, detail: false, showcase: false };
}

/** Frame rate under which the high tier steps down, and how long it must last (seconds). */
export const GOVERNOR_MIN_FPS = 30;
export const GOVERNOR_HOLD_S = 5;
/** Seconds after a step (or the start) before the governor judges again: tiles and shaders settle. */
export const GOVERNOR_GRACE_S = 8;

/**
 * Steps the high tier down when the frame rate stays under GOVERNOR_MIN_FPS for GOVERNOR_HOLD_S:
 * post-processing off first, then shadows. Feed it real frame times; it answers what to drop.
 */
export class GfxGovernor {
  private slow = 0;
  private grace = GOVERNOR_GRACE_S;
  private readonly steps: Array<keyof GfxFeatures> = ["post", "shadows"];
  readonly dropped: Array<keyof GfxFeatures> = [];
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** One frame: returns the feature to switch off now, or null. `busy`: tiles are loading (ignore the frame). */
  frame(seconds: number, busy: boolean): keyof GfxFeatures | null {
    if (!this.enabled || this.steps.length === 0 || !(seconds > 0)) return null;
    if (this.grace > 0) {
      this.grace -= seconds;
      return null;
    }
    if (busy) {
      this.slow = 0;
      return null;
    }
    this.slow = 1 / seconds < GOVERNOR_MIN_FPS ? this.slow + seconds : 0;
    if (this.slow < GOVERNOR_HOLD_S) return null;
    this.slow = 0;
    this.grace = GOVERNOR_GRACE_S;
    const f = this.steps.shift()!;
    this.dropped.push(f);
    return f;
  }
}
