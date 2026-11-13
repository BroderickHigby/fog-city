// Scanned surface detail as the GPU sees it: the building and packed robot/vehicle materials are
// built to WGSL and GLSL on a stub renderer (no GPU) with and without detail scans. With scans the
// shaders sample them; without, they are exactly the shaders the city had before.
import * as THREE from "three/webgpu";
import { afterEach, describe, expect, it } from "vitest";
import { DETAIL_NAMES, setDetailTextures, type DetailTextures } from "../../src/render/detail-textures.ts";
import { createGpuPackedMaterial, prepareGpuScene, setGpuMaterialsEnabled } from "../../src/render/node-materials.ts";
import { fragmentShader } from "./node-shader.ts";

afterEach(() => setDetailTextures(null));

function scans(): DetailTextures {
  const map = (): THREE.Texture => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };
  return { level: 1, maps: Object.fromEntries(DETAIL_NAMES.map((n) => [n, { albedo: map(), rh: map() }])) as DetailTextures["maps"] };
}

function building(): [THREE.Material, THREE.BufferGeometry] {
  setGpuMaterialsEnabled(true);
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute("_building", new THREE.BufferAttribute(new Float32Array(24 * 4), 4));
  geometry.setAttribute("_facade", new THREE.BufferAttribute(new Float32Array(24 * 4), 4));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
  const source = new THREE.MeshStandardMaterial({ name: "fc:building" });
  source.userData.fcKind = "building";
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, source));
  prepareGpuScene(group);
  return [(group.children[0] as THREE.Mesh).material as THREE.Material, geometry];
}

function vehicle(): [THREE.Material, THREE.BufferGeometry] {
  const geometry = new THREE.BoxGeometry(), n = geometry.getAttribute("position").count;
  const attr = (name: string, size: number): void => { geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(n * size), size)); };
  attr("color", 3); attr("fcPbr", 3); attr("fcCue", 4); attr("fcEmit", 4);
  attr("fcCarPaint", 4); attr("fcCarAccent", 3); attr("fcPaint", 1); attr("fcWheel", 4); attr("fcCarMotion", 2);
  return [createGpuPackedMaterial(false, true, new THREE.Vector4(1, 1, 1, 1)), geometry];
}

/** Texture bindings the shader declares (WGSL texture_2d, GLSL sampler2D): each scan map adds one. */
const samples = (src: string): number => (src.match(/\btexture_2d\b|\bsampler2D\b/g) ?? []).length;

describe.each(["wgsl", "glsl"] as const)("surface detail in %s", (lang) => {
  it.each([["building walls", building], ["robots and vehicles", vehicle]] as const)("%s sample the scans only when they are loaded", (_name, make) => {
    const [plainMaterial, plainGeometry] = make();
    const plain = fragmentShader(plainMaterial, plainGeometry, lang);
    setDetailTextures(scans());
    const [detailMaterial, detailGeometry] = make();
    const detailed = fragmentShader(detailMaterial, detailGeometry, lang);
    expect(samples(detailed)).toBeGreaterThan(samples(plain));
    setDetailTextures(null);
    const [againMaterial, againGeometry] = make();
    expect(fragmentShader(againMaterial, againGeometry, lang)).toBe(plain);
  });
});
