import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedMaterials } from "../../src/render/materials.ts";
import { loadSurfaceTextures, type SurfaceTextures } from "../../src/render/surface-textures.ts";

const active: SurfaceTextures[] = [];
afterEach(() => {
  active.splice(0).forEach(controller => controller.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function images(): Array<{ width: number; height: number; close: ReturnType<typeof vi.fn> }> {
  const result: Array<{ width: number; height: number; close: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal("createImageBitmap", vi.fn(async () => {
    const image = { width: 1024, height: 1024, close: vi.fn() };
    result.push(image);
    return image;
  }));
  return result;
}
function compile(material: THREE.MeshStandardMaterial): THREE.WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe("optional surface scans", () => {
  it("reads packed-compatible bytes, preserves shaders, and shares correct map formats", async () => {
    const bitmaps = images(), materials = createSharedMaterials();
    const bytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const previous = materials.roadUv.onBeforeCompile;
    const previousKey = materials.roadUv.customProgramCacheKey();
    const controller = loadSurfaceTextures(materials, bytes, { anisotropy: 32 });
    active.push(controller);
    expect(await controller.ready).toEqual({ loaded: ["asphalt", "concrete"], failed: [], disposed: false });
    expect(controller.state).toBe("ready");
    expect(bytes.mock.calls.length).toBe(6);
    expect((bytes.mock.calls as unknown as string[][]).map(call => call[0])).toContain("textures/surfaces/asphalt_albedo.webp");
    const road = compile(materials.roadUv), concrete = compile(materials.ground);
    expect(road.fragmentShader).toContain("float dash =");
    expect(road.fragmentShader).toContain("float crack =");
    expect(road.fragmentShader).toContain("vFcWorld.xz / fcSurfaceRepeatM");
    expect(road.fragmentShader.indexOf("float fcSurfaceWeight")).toBeGreaterThan(road.fragmentShader.indexOf("float dash ="));
    expect(road.uniforms.fcSurfaceRepeatM!.value).toBe(3);
    expect(concrete.uniforms.fcSurfaceRepeatM!.value).toBe(1.8);
    expect(road.uniforms.fcSurfaceAlbedo!.value).toBe(compile(materials.road).uniforms.fcSurfaceAlbedo!.value);
    const albedo = road.uniforms.fcSurfaceAlbedo!.value as THREE.Texture;
    const normal = road.uniforms.fcSurfaceNormal!.value as THREE.Texture;
    expect(albedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(normal.flipY).toBe(false);
    expect(normal.wrapS).toBe(THREE.RepeatWrapping);
    expect(normal.anisotropy).toBe(8);
    expect(materials.road.map).toBeNull();
    expect(materials.road.normalMap).toBeNull();
    controller.dispose();
    controller.dispose();
    expect(materials.roadUv.onBeforeCompile).toBe(previous);
    expect(materials.roadUv.customProgramCacheKey()).toBe(previousKey);
    expect(bitmaps.every(image => image.close.mock.calls.length === 1)).toBe(true);
  });

  it("leaves a failed set procedural while releasing its partial images", async () => {
    const bitmaps = images(), materials = createSharedMaterials();
    const previous = materials.ground.onBeforeCompile;
    const controller = loadSurfaceTextures(materials, async path => {
      if (path.endsWith("concrete_normal.webp")) throw new Error("missing optional map");
      return new Uint8Array([1]);
    });
    active.push(controller);
    expect(await controller.ready).toEqual({ loaded: ["asphalt"], failed: ["concrete"], disposed: false });
    expect(materials.ground.onBeforeCompile).toBe(previous);
    expect(bitmaps.filter(image => image.close.mock.calls.length === 1)).toHaveLength(2);
  });

  it("does not change materials or retain decoded images after disposal during loading", async () => {
    const bitmaps = images(), materials = createSharedMaterials();
    const before = materials.road.onBeforeCompile;
    let resolve!: (value: Uint8Array) => void;
    const bytes = new Promise<Uint8Array>(done => { resolve = done; });
    const controller = loadSurfaceTextures(materials, () => bytes);
    active.push(controller);
    controller.dispose();
    resolve(new Uint8Array([1]));
    expect(await controller.ready).toEqual({ loaded: [], failed: [], disposed: true });
    expect(controller.state).toBe("disposed");
    expect(materials.road.onBeforeCompile).toBe(before);
    expect(bitmaps).toHaveLength(6);
    expect(bitmaps.every(image => image.close.mock.calls.length === 1)).toBe(true);
  });

  it("shares scans with streamed tunnel-cut materials and releases their bindings on unload", async () => {
    images();
    const materials = createSharedMaterials();
    const controller = loadSurfaceTextures(materials, async () => new Uint8Array([1]));
    active.push(controller);
    const beforeLoad = new THREE.MeshStandardMaterial();
    controller.register(beforeLoad, "concrete");
    await controller.ready;
    expect(compile(beforeLoad).uniforms.fcSurfaceRepeatM!.value).toBe(1.8);
    const afterLoad = new THREE.MeshStandardMaterial();
    const before = afterLoad.onBeforeCompile;
    controller.register(afterLoad, "concrete");
    controller.register(afterLoad, "concrete");
    expect(compile(afterLoad).uniforms.fcSurfaceAlbedo!.value).toBe(compile(materials.ground).uniforms.fcSurfaceAlbedo!.value);
    afterLoad.dispose();
    expect(afterLoad.onBeforeCompile).toBe(before);
    controller.dispose();
    const ignored = new THREE.MeshStandardMaterial();
    controller.register(ignored, "concrete");
    expect(compile(ignored).uniforms.fcSurfaceAlbedo).toBeUndefined();
  });

  it("rejects oversized decoded scans and keeps the fallback", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4096, height: 4096, close })));
    const materials = createSharedMaterials();
    const previous = materials.road.onBeforeCompile;
    const controller = loadSurfaceTextures(materials, async () => new Uint8Array([1]));
    active.push(controller);
    expect(await controller.ready).toEqual({ loaded: [], failed: ["asphalt", "concrete"], disposed: false });
    expect(materials.road.onBeforeCompile).toBe(previous);
    expect(close).toHaveBeenCalledTimes(6);
  });
});
