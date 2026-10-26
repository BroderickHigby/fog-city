// GPU memory accounting (src/render/gpu-memory.ts) against a stand-in WebGL2 context that only
// records calls: the bytes per allocation, cube faces, mipmaps, renderbuffers and deletes.
import { describe, expect, it } from "vitest";
import { bytesPerTexel, trackGpuMemory } from "../../src/render/gpu-memory.ts";

const GL = {
  TEXTURE0: 0x84c0, TEXTURE_2D: 0x0de1, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851a,
  RGBA8: 0x8058, SRGB8_ALPHA8: 0x8c43, RGBA16F: 0x881a, RGBA32F: 0x8814, R8: 0x8229, DEPTH_COMPONENT24: 0x81a6, RGBA: 0x1908,
  RENDERBUFFER: 0x8d41,
};

function fakeGl(): WebGL2RenderingContext & Record<string, unknown> {
  const noop = (): void => {};
  const gl: Record<string, unknown> = { ...GL };
  for (const f of ["activeTexture", "bindTexture", "texStorage2D", "texStorage3D", "texImage2D", "texImage3D", "compressedTexImage2D", "generateMipmap", "deleteTexture", "bindRenderbuffer", "renderbufferStorage", "renderbufferStorageMultisample", "deleteRenderbuffer"]) gl[f] = noop;
  return gl as unknown as WebGL2RenderingContext & Record<string, unknown>;
}

describe("gpu memory accounting", () => {
  it("knows the common formats' bytes per texel", () => {
    const gl = fakeGl();
    expect(bytesPerTexel(gl, GL.RGBA8)).toBe(4);
    expect(bytesPerTexel(gl, GL.RGBA16F)).toBe(8);
    expect(bytesPerTexel(gl, GL.RGBA32F)).toBe(16);
    expect(bytesPerTexel(gl, GL.R8)).toBe(1);
  });

  it("counts texStorage levels, texImage uploads, cube faces, mipmaps, renderbuffers and deletes", () => {
    const gl = fakeGl();
    const read = trackGpuMemory(gl);
    const a = {} as WebGLTexture;
    const b = {} as WebGLTexture;
    const c = {} as WebGLTexture;
    gl.activeTexture(GL.TEXTURE0);
    gl.bindTexture(GL.TEXTURE_2D, a);
    gl.texStorage2D(GL.TEXTURE_2D, 2, GL.RGBA8, 4, 4); // (16 + 4) * 4
    expect(read().textureBytes).toBe(80);
    gl.bindTexture(GL.TEXTURE_2D, b);
    // texImage2D with an image source: width and height from the source.
    (gl.texImage2D as unknown as (...a: unknown[]) => void)(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, 0x1401, { width: 8, height: 8 });
    expect(read().textureBytes).toBe(80 + 256);
    gl.generateMipmap(GL.TEXTURE_2D);
    gl.generateMipmap(GL.TEXTURE_2D); // once only
    expect(read().textureBytes).toBe(80 + Math.round((256 * 4) / 3));
    gl.bindTexture(GL.TEXTURE_CUBE_MAP, c);
    for (let f = GL.TEXTURE_CUBE_MAP_POSITIVE_X; f <= GL.TEXTURE_CUBE_MAP_NEGATIVE_Z; f++) {
      (gl.texImage2D as unknown as (...a: unknown[]) => void)(f, 0, GL.RGBA16F, 2, 2, 0, GL.RGBA, 0x140b, null);
    }
    expect(read().textures).toBe(3);
    expect(read().textureBytes).toBe(80 + Math.round((256 * 4) / 3) + 6 * 4 * 8);
    gl.deleteTexture(b);
    expect(read().textureBytes).toBe(80 + 6 * 4 * 8);
    const rb = {} as WebGLRenderbuffer;
    gl.bindRenderbuffer(GL.RENDERBUFFER, rb);
    gl.renderbufferStorageMultisample(GL.RENDERBUFFER, 4, GL.DEPTH_COMPONENT24, 10, 10);
    expect(read().renderbufferBytes).toBe(4 * 100 * 4);
    gl.deleteRenderbuffer(rb);
    expect(read().renderbufferBytes).toBe(0);
  });
});
