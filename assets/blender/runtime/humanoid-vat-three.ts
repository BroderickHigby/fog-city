// three.js side of the humanoid vertex-animation textures: a reference the render track can
// adopt as is or copy. It turns public/models/humanoid-vat.json + a LOD's .bin into textures and
// patches a MeshStandardMaterial so an InstancedMesh of a crowd mesh (humanoid-crowd.glb,
// meshes adult_lod0/1, child_lod0/1) plays a clip per instance, in a variant body and a
// palette, wet or dry. One draw call per mesh, whatever the number of people.
//
//   const meta = await (await fetch("models/humanoid-vat.json")).json();
//   const lod = meta.models.adult.lods["0"];
//   const bin = await (await fetch(`models/${lod.file}`)).arrayBuffer();
//   const vat = createHumanoidVat(meta, "adult", "0", bin);
//   const mesh = new THREE.InstancedMesh(crowdGeometry /* adult_lod0 from the GLB */, vat.material, 200);
//   addVatAttributes(mesh);                      // per-instance clip + look
//   setVatInstance(mesh, i, { clip: vat.clipIndex("walk"), startTime: now, rate: 1,
//                             variant: vat.variantIndex("founder"), palette: vat.palette.rowOf("vest_navy", "brown", 2), wet: 0 });
//   each frame: vat.uniforms.vatTime.value = now;   (seconds, the same clock as startTime)
//
// Shadows: three.js draws shadow maps with its own depth materials, which would cast every
// person's shadow from the rest pose. Give the mesh the VAT versions:
//   mesh.castShadow = true;
//   mesh.customDepthMaterial = vat.depthMaterial;       // directional and spot lights
//   mesh.customDistanceMaterial = vat.distanceMaterial; // point lights
//
// Contract and layout: assets/blender/README.md, "Humanoid line".

import * as THREE from "three";
import { hexToRgb, paletteTable, variantWeights, type HumanoidVatMeta, type PaletteTable, type VatClip, type VatLod } from "./humanoid-vat.ts";

export interface HumanoidVat {
  lod: VatLod;
  clips: VatClip[];
  material: THREE.MeshStandardMaterial;
  /** Shadow-map depth for directional and spot lights: set as the mesh's customDepthMaterial. */
  depthMaterial: THREE.MeshDepthMaterial;
  /** Shadow-map distance for point lights: set as the mesh's customDistanceMaterial. */
  distanceMaterial: THREE.MeshDistanceMaterial;
  /** Shared by all three materials: setting vatTime moves the body and its shadow together. */
  uniforms: { vatTime: { value: number } };
  palette: PaletteTable;
  clipIndex(name: string): number;
  variantIndex(id: string): number;
  /** Bounding sphere that covers every clip (the dive leaves the origin by 1.25 m). */
  boundingSphere: THREE.Sphere;
  dispose(): void;
}

const MAX_CLIPS = 8;

export function createHumanoidVat(meta: HumanoidVatMeta, model: string, lodKey: string, bin: ArrayBuffer): HumanoidVat {
  const lod = meta.models[model]?.lods[lodKey];
  if (!lod) throw new Error(`no humanoid model ${model} LOD ${lodKey}`);
  const clips = meta.clips[model] ?? [];
  if (clips.length > MAX_CLIPS) throw new Error(`more than ${MAX_CLIPS} clips`);
  const bytes = new Uint8Array(bin);

  const half = (s: { byteOffset: number; byteLength: number; height: number }): THREE.DataTexture => {
    const data = new Uint16Array(bytes.buffer.slice(bytes.byteOffset + s.byteOffset, bytes.byteOffset + s.byteOffset + s.byteLength));
    const t = new THREE.DataTexture(data, lod.width, s.height, THREE.RGBAFormat, THREE.HalfFloatType);
    return nearest(t);
  };
  const pos = half(lod.position);
  const morph = half(lod.morph);
  const rotData = bytes.slice(lod.rotation.byteOffset, lod.rotation.byteOffset + lod.rotation.byteLength);
  const rot = nearest(new THREE.DataTexture(rotData, lod.width, lod.rotation.height, THREE.RGBAFormat, THREE.UnsignedByteType));

  // variants: one row per variant, ceil(K / 4) RGBA float texels of shape-key weights
  const K = meta.morphs.length;
  const perRow = Math.ceil(K / 4);
  const vdata = new Float32Array(perRow * 4 * meta.variants.length);
  meta.variants.forEach((v, r) => vdata.set(variantWeights(meta, v), r * perRow * 4));
  const variants = nearest(new THREE.DataTexture(vdata, perRow, meta.variants.length, THREE.RGBAFormat, THREE.FloatType));

  // palette: one row per (outfit, hair, skin), one sRGB texel per slot
  const palette = paletteTable(meta);
  const pdata = new Uint8Array(palette.rows.length * meta.slots.length * 4);
  palette.rows.forEach((row, r) =>
    row.forEach((hex, s) => {
      const [cr, cg, cb] = hexToRgb(hex);
      pdata.set([cr, cg, cb, 255], (r * meta.slots.length + s) * 4);
    }),
  );
  const pal = nearest(new THREE.DataTexture(pdata, meta.slots.length, palette.rows.length, THREE.RGBAFormat, THREE.UnsignedByteType));
  pal.colorSpace = THREE.SRGBColorSpace;

  const clipVec = Array.from({ length: MAX_CLIPS }, (_, i) => {
    const c = clips[i];
    return c ? new THREE.Vector4(c.startFrame, c.frameCount, c.fps, c.loop ? 1 : 0) : new THREE.Vector4(0, 1, 1, 0);
  });
  const uniforms = {
    vatTime: { value: 0 },
    vatPos: { value: pos },
    vatRot: { value: rot },
    vatMorph: { value: morph },
    vatVariants: { value: variants },
    vatPalette: { value: pal },
    vatClips: { value: clipVec },
    vatLayout: { value: new THREE.Vector4(lod.width, lod.rowsPerFrame, K, 0) },
  };

  const material = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
  material.name = `humanoid_vat_${model}_lod${lodKey}`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VAT_VERTEX_HEADER}`)
      .replace("#include <beginnormal_vertex>", VAT_VERTEX_BODY)
      .replace("#include <begin_vertex>", "vec3 transformed = vatPosition;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${VAT_FRAGMENT_HEADER}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${VAT_FRAGMENT_COLOR}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${VAT_FRAGMENT_ROUGHNESS}`);
  };
  material.customProgramCacheKey = () => "fogcity-humanoid-vat-1";

  // Shadow passes: the same vertex maths (position only), no palette.
  const patchDepth = (m: THREE.Material, key: string): void => {
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VAT_VERTEX_HEADER}`)
        .replace("#include <begin_vertex>", `${VAT_VERTEX_POSITION}\nvec3 transformed = vatPosition;`);
    };
    m.customProgramCacheKey = () => key;
  };
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.name = `${material.name}_depth`;
  patchDepth(depthMaterial, "fogcity-humanoid-vat-depth-1");
  const distanceMaterial = new THREE.MeshDistanceMaterial();
  distanceMaterial.name = `${material.name}_distance`;
  patchDepth(distanceMaterial, "fogcity-humanoid-vat-distance-1");

  const { min, max } = lod.bounds;
  const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;

  return {
    lod,
    clips,
    material,
    depthMaterial,
    distanceMaterial,
    uniforms,
    palette,
    clipIndex(name) {
      const i = clips.findIndex((c) => c.name === name);
      if (i < 0) throw new Error(`no clip ${name} for ${model}`);
      return i;
    },
    variantIndex(id) {
      const i = meta.variants.findIndex((v) => v.id === id);
      if (i < 0) throw new Error(`no variant ${id}`);
      return i;
    },
    boundingSphere: new THREE.Sphere(center, radius),
    dispose() {
      for (const t of [pos, rot, morph, variants, pal]) t.dispose();
      material.dispose();
      depthMaterial.dispose();
      distanceMaterial.dispose();
    },
  };
}

function nearest(t: THREE.DataTexture): THREE.DataTexture {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Adds the two per-instance attributes the shader reads (vatState, vatLook). */
export function addVatAttributes(mesh: THREE.InstancedMesh): void {
  const n = mesh.count;
  mesh.geometry.setAttribute("vatState", new THREE.InstancedBufferAttribute(new Float32Array(n * 4).fill(0).map((_, i) => (i % 4 === 2 ? 1 : 0)), 4));
  mesh.geometry.setAttribute("vatLook", new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
}

export interface VatInstance {
  clip: number;
  /** Seconds on the vatTime clock when the clip started. */
  startTime: number;
  /** Playback rate (1 = authored speed; scale walk by speed / clip.speedMps). */
  rate: number;
  variant: number;
  palette: number;
  /** 0 dry .. 1 soaked: darker, glossier clothes. */
  wet: number;
}

export function setVatInstance(mesh: THREE.InstancedMesh, i: number, s: VatInstance): void {
  const st = mesh.geometry.getAttribute("vatState") as THREE.InstancedBufferAttribute;
  const lk = mesh.geometry.getAttribute("vatLook") as THREE.InstancedBufferAttribute;
  st.setXYZW(i, s.clip, s.startTime, s.rate, 0);
  lk.setXYZW(i, s.variant, s.palette, s.wet, 0);
  st.needsUpdate = true;
  lk.needsUpdate = true;
}

// --------------------------------------------------------------------------------- GLSL

export const VAT_VERTEX_HEADER = /* glsl */ `
attribute float _vid;
attribute float _slot;
attribute vec4 vatState; // clip index, start time (s), playback rate, unused
attribute vec4 vatLook;  // variant row, palette row, wetness 0..1, unused
uniform float vatTime;
uniform sampler2D vatPos;      // RGBA16F: xyz position per vertex per frame
uniform sampler2D vatRot;      // RGBA8: blended bone rotation quaternion, q * 0.5 + 0.5
uniform sampler2D vatMorph;    // RGBA16F: per shape key, row 2k = position delta, 2k+1 = normal delta
uniform sampler2D vatVariants; // RGBA32F: shape-key weights, one row per variant
uniform vec4 vatClips[${MAX_CLIPS}];       // startFrame, frameCount, fps, loop
uniform vec4 vatLayout;        // width, rowsPerFrame, key count, 0
varying float vVatSlot;
varying float vVatPalette;
varying float vVatWet;
ivec2 vatTexel(float row) {
  int w = int(vatLayout.x);
  int v = int(_vid + 0.5);
  return ivec2(v % w, int(row + 0.5) * int(vatLayout.y) + v / w);
}
vec3 vatRotate(vec4 q, vec3 v) {
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
`;

/** The animated, variant-shaped position (vatPosition) and the blended rotation (vatQ). */
export const VAT_VERTEX_POSITION = /* glsl */ `
vec4 vatClip = vatClips[int(vatState.x + 0.5)];
float vatN = vatClip.y;
float vatEl = max(vatTime - vatState.y, 0.0) * vatState.z * vatClip.z;
float vatF = vatClip.w > 0.5 ? mod(vatEl, vatN) : min(vatEl, vatN - 1.0);
float vatF0 = floor(vatF);
float vatA = vatF - vatF0;
float vatF1 = vatClip.w > 0.5 ? mod(vatF0 + 1.0, vatN) : min(vatF0 + 1.0, vatN - 1.0);
vatF0 += vatClip.x;
vatF1 += vatClip.x;
vec3 vatP = mix(texelFetch(vatPos, vatTexel(vatF0), 0).xyz, texelFetch(vatPos, vatTexel(vatF1), 0).xyz, vatA);
vec4 vatQ0 = normalize(texelFetch(vatRot, vatTexel(vatF0), 0) * 2.0 - 1.0);
vec4 vatQ1 = normalize(texelFetch(vatRot, vatTexel(vatF1), 0) * 2.0 - 1.0);
if (dot(vatQ0, vatQ1) < 0.0) vatQ1 = -vatQ1;
vec4 vatQ = normalize(mix(vatQ0, vatQ1, vatA));
vec3 vatDp = vec3(0.0);
vec3 vatDn = vec3(0.0);
int vatRow = int(vatLook.x + 0.5);
int vatK = int(vatLayout.z);
for (int k = 0; k < 16; k++) {
  if (k >= vatK) break;
  vec4 vatW4 = texelFetch(vatVariants, ivec2(k / 4, vatRow), 0);
  float w = vatW4[k % 4];
  if (w != 0.0) {
    vatDp += w * texelFetch(vatMorph, vatTexel(float(2 * k)), 0).xyz;
    vatDn += w * texelFetch(vatMorph, vatTexel(float(2 * k + 1)), 0).xyz;
  }
}
vec3 vatPosition = vatP + vatRotate(vatQ, vatDp);
`;

/** Replaces <beginnormal_vertex> in the lit material: position, normal and the varyings. */
export const VAT_VERTEX_BODY = /* glsl */ `
${VAT_VERTEX_POSITION}
vec3 objectNormal = vatRotate(vatQ, normalize(normal + vatDn));
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif
vVatSlot = _slot;
vVatPalette = vatLook.y;
vVatWet = clamp(vatLook.z, 0.0, 1.0);
`;

export const VAT_FRAGMENT_HEADER = /* glsl */ `
uniform sampler2D vatPalette; // one sRGB texel per slot, one row per look
varying float vVatSlot;
varying float vVatPalette;
varying float vVatWet;
`;

export const VAT_FRAGMENT_COLOR = /* glsl */ `
int vatSlot = int(vVatSlot + 0.5);
diffuseColor.rgb = texelFetch(vatPalette, ivec2(vatSlot, int(vVatPalette + 0.5)), 0).rgb;
// wet fabric and hair go darker; skin, eyes and the badge stay as they are
float vatWetMask = (vatSlot == 0 || vatSlot >= 8) ? 0.25 : 1.0;
diffuseColor.rgb *= 1.0 - 0.45 * vVatWet * vatWetMask;
`;

export const VAT_FRAGMENT_ROUGHNESS = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 0.32, vVatWet);
`;
