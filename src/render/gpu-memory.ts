// GPU memory accounting for budget reports (?gpumem=1; the visual slice turns it on). Wraps the
// WebGL2 context's allocation calls and keeps the bytes each texture and renderbuffer holds:
// textures from texStorage2D/3D and texImage2D/3D (level 0, every cube face; generateMipmap adds a
// third), compressed textures from their data, renderbuffers (shadow-free depth, MSAA colour) from
// renderbufferStorage(Multisample). Deleting an object returns its bytes. Every figure is
// width x height (x depth, x samples) x the internal format's bytes per texel, so it is what the
// driver must at least hold, before its own padding.
//
// Off by default: bindTexture is called on every draw, so the wrapper costs a little per call.

export interface GpuMemory {
  /** Bytes in live textures (including render-target colour and depth textures). */
  textureBytes: number;
  /** Bytes in live renderbuffers (MSAA colour, depth). */
  renderbufferBytes: number;
  textures: number;
  renderbuffers: number;
}

/** Bytes per texel of a WebGL2 sized internal format (4 when the format is unsized or unknown). */
export function bytesPerTexel(gl: WebGL2RenderingContext, internalformat: number): number {
  const g = gl;
  switch (internalformat) {
    case g.R8:
    case g.R8UI:
    case g.R8I:
    case g.ALPHA:
    case g.LUMINANCE:
      return 1;
    case g.RG8:
    case g.R16F:
    case g.R16UI:
    case g.R16I:
    case g.LUMINANCE_ALPHA:
    case g.DEPTH_COMPONENT16:
    case g.RGB565:
    case g.RGBA4:
    case g.RGB5_A1:
      return 2;
    case g.RGB8:
    case g.SRGB8:
    case g.RGB:
      return 3;
    case g.RG16F:
    case g.R32F:
    case g.RGBA8:
    case g.SRGB8_ALPHA8:
    case g.RGBA:
    case g.DEPTH_COMPONENT24:
    case g.DEPTH_COMPONENT32F:
    case g.DEPTH24_STENCIL8:
    case g.DEPTH_COMPONENT:
    case g.DEPTH_STENCIL:
    case g.R11F_G11F_B10F:
    case g.RGB10_A2:
      return 4;
    case g.RGB16F:
      return 6;
    case g.RGBA16F:
    case g.RG32F:
    case g.DEPTH32F_STENCIL8:
      return 8;
    case g.RGB32F:
      return 12;
    case g.RGBA32F:
      return 16;
    default:
      return 4;
  }
}

/** Wrap `gl` once; returns a reader of the live totals. */
export function trackGpuMemory(gl: WebGL2RenderingContext): () => GpuMemory {
  const sizes = new Map<WebGLTexture, number>();
  const mipped = new Set<WebGLTexture>();
  const rbSizes = new Map<WebGLRenderbuffer, number>();
  const bound = new Map<number, WebGLTexture | null>();
  let unit: number = gl.TEXTURE0;
  let rb: WebGLRenderbuffer | null = null;
  const cube = (t: number): boolean => t >= gl.TEXTURE_CUBE_MAP_POSITIVE_X && t <= gl.TEXTURE_CUBE_MAP_NEGATIVE_Z;
  const current = (target: number): WebGLTexture | null => bound.get(unit * 65536 + (cube(target) ? gl.TEXTURE_CUBE_MAP : target)) ?? null;
  const add = (target: number, bytes: number, replace: boolean): void => {
    const t = current(target);
    if (!t) return;
    // A cube face adds to the cube; a 2D level-0 upload replaces what the texture held.
    sizes.set(t, (replace && !cube(target) ? 0 : sizes.get(t) ?? 0) + bytes);
    mipped.delete(t);
  };
  const g = gl as unknown as Record<string, (...args: unknown[]) => unknown>;
  const wrap = (name: string, after: (args: unknown[]) => void): void => {
    const orig = g[name]!.bind(gl);
    g[name] = (...args: unknown[]) => {
      const r = orig(...args);
      after(args);
      return r;
    };
  };
  wrap("activeTexture", (a) => {
    unit = a[0] as number;
  });
  wrap("bindTexture", (a) => {
    bound.set(unit * 65536 + (a[0] as number), a[1] as WebGLTexture | null);
  });
  wrap("texStorage2D", (a) => {
    const [target, levels, fmt, w, h] = a as number[];
    let bytes = 0;
    for (let l = 0; l < levels!; l++) bytes += Math.max(1, w! >> l) * Math.max(1, h! >> l);
    add(target!, bytes * bytesPerTexel(gl, fmt!) * (target === gl.TEXTURE_CUBE_MAP ? 6 : 1), true);
  });
  wrap("texStorage3D", (a) => {
    const [target, levels, fmt, w, h, d] = a as number[];
    let bytes = 0;
    for (let l = 0; l < levels!; l++) bytes += Math.max(1, w! >> l) * Math.max(1, h! >> l) * d!;
    add(target!, bytes * bytesPerTexel(gl, fmt!), true);
  });
  wrap("texImage2D", (a) => {
    const [target, level, fmt] = a as number[];
    if (level !== 0) return;
    let w = 0;
    let h = 0;
    if (a.length >= 8) {
      w = a[3] as number;
      h = a[4] as number;
    } else {
      const src = a[5] as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | null;
      w = src?.videoWidth ?? src?.width ?? 0;
      h = src?.videoHeight ?? src?.height ?? 0;
    }
    add(target!, w * h * bytesPerTexel(gl, fmt!), true);
  });
  wrap("texImage3D", (a) => {
    const [target, level, fmt, w, h, d] = a as number[];
    if (level !== 0) return;
    add(target!, w! * h! * d! * bytesPerTexel(gl, fmt!), true);
  });
  wrap("compressedTexImage2D", (a) => {
    const level = a[1] as number;
    const data = a[a.length - 1] as { byteLength?: number } | null;
    if (level === 0) add(a[0] as number, data?.byteLength ?? 0, true);
    else {
      const t = current(a[0] as number);
      if (t) sizes.set(t, (sizes.get(t) ?? 0) + (data?.byteLength ?? 0));
    }
  });
  wrap("generateMipmap", (a) => {
    const t = current(a[0] as number);
    if (!t || mipped.has(t)) return;
    mipped.add(t);
    sizes.set(t, ((sizes.get(t) ?? 0) * 4) / 3);
  });
  wrap("deleteTexture", (a) => {
    sizes.delete(a[0] as WebGLTexture);
    mipped.delete(a[0] as WebGLTexture);
  });
  wrap("bindRenderbuffer", (a) => {
    rb = a[1] as WebGLRenderbuffer | null;
  });
  wrap("renderbufferStorage", (a) => {
    const [, fmt, w, h] = a as number[];
    if (rb) rbSizes.set(rb, w! * h! * bytesPerTexel(gl, fmt!));
  });
  wrap("renderbufferStorageMultisample", (a) => {
    const [, samples, fmt, w, h] = a as number[];
    if (rb) rbSizes.set(rb, Math.max(1, samples!) * w! * h! * bytesPerTexel(gl, fmt!));
  });
  wrap("deleteRenderbuffer", (a) => {
    rbSizes.delete(a[0] as WebGLRenderbuffer);
  });
  return () => {
    let textureBytes = 0;
    for (const b of sizes.values()) textureBytes += b;
    let renderbufferBytes = 0;
    for (const b of rbSizes.values()) renderbufferBytes += b;
    return { textureBytes: Math.round(textureBytes), renderbufferBytes, textures: sizes.size, renderbuffers: rbSizes.size };
  };
}
