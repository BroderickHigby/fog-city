import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTriplanar, DetailMaterial, disposeDetailSets, loadDetailSets, type DetailSet } from "../../src/render/detail.ts";
import { fcUniforms, installFog } from "../../src/render/materials.ts";

const info = { sizeM: 2, meanLinear: [0.2, 0.2, 0.2] as [number, number, number], albedo: "a.webp", normal: "n.webp", orm: "o.webp", source: "test", licence: "CC0" };
function set(): DetailSet { return { name: "test", info, albedo: new THREE.Texture(), normal: new THREE.Texture(), orm: new THREE.Texture() }; }
function compile(material: THREE.MeshStandardMaterial) {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("optional Ferry detail", () => {
  it("keeps the shared atmosphere on ordinary and triplanar detail materials", () => {
    installFog();
    const scan = set(), material = new THREE.MeshStandardMaterial(), stone = new THREE.MeshStandardMaterial();
    new DetailMaterial(material).apply(scan, { albedo: 1, normalScale: 1, roughness: 1, ao: 1, farM: 100 });
    applyTriplanar(stone, scan, { albedo: 1, normalScale: 1, roughness: 1, ao: 1, farM: 100 });
    for (const shader of [compile(material), compile(stone)]) {
      expect(shader.uniforms.fcFogParams).toBe(fcUniforms.fcFogParams);
      expect(shader.uniforms.fcLinearOutput).toBe(fcUniforms.fcLinearOutput);
      expect(shader.uniforms.fcTime).toBe(fcUniforms.fcTime);
    }
    disposeDetailSets(new Map([[scan.name, scan]]));
  });

  it("can restrict additional pavers to the authored plaza mask", () => {
    const scan = set(), pavers = set(), material = new THREE.MeshStandardMaterial();
    const detail = new DetailMaterial(material), mask = new THREE.Texture();
    detail.apply(scan, { albedo: 0.8, normalScale: 0.8, roughness: 1, ao: 0.5, farM: 100 });
    detail.setMasked(pavers, mask, 820, true);
    const shader = compile(material);
    expect((shader.uniforms.fcDetInfo3!.value as THREE.Vector4).w).toBe(1);
    expect(shader.uniforms.fcDetMask!.value).toBe(mask);
    expect(shader.fragmentShader).toContain("fcDfade *= fcDmask");
    disposeDetailSets(new Map([["scan", scan], ["pavers", pavers]])); mask.dispose();
  });

  it("releases successful partial images when an optional set cannot decode", async () => {
    const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes[0] === 2) throw new Error("damaged normal map");
      const bitmap = { width: 1024, height: 1024, close: vi.fn() }; bitmaps.push(bitmap); return bitmap;
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sets = await loadDetailSets(async path => path.endsWith("textures.json")
      ? new TextEncoder().encode(JSON.stringify({ version: 1, textures: { test: info } }))
      : new Uint8Array([path.endsWith("n.webp") ? 2 : 1]), ["test"], 4);
    expect(sets.size).toBe(0);
    expect(bitmaps).toHaveLength(2);
    expect(bitmaps.every(bitmap => bitmap.close.mock.calls.length === 1)).toBe(true);
  });
});
