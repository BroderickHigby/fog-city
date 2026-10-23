// Agent geometry in one packed vertex format, so a whole rigid part of a model (all of its
// materials) draws in ONE instanced draw call:
//
//   position, normal
//   color   vec3  base colour (linear), from the glTF material
//   fcPbr   vec2  roughness, metalness
//   fcEmit  vec4  emissive colour (linear, times the material's channelRatio so it keeps its
//                 own night level) and the light channel (lights.ts):
//                 0 none, 1 head lights, 2 tail/brake lights, 3 status lights (faces, status lines, signs)
//   fcSlot  vec4  people only: weights of the per-instance shirt, trousers, skin and hair colours
//
// and per instance (InstancedBufferAttribute on the part's geometry):
//
//   fcCue   vec4  brake lights 0/1, hazard/status flash 0/1 (agentCue in agent-lod.ts), rust 0..1
//                 and wetness 0..1 (the combat presentation, render-only: runtime-actors.ts)
//   fcColA..fcColD vec3  people only: shirt, trousers, skin, hair
//
// Every agent material in the game models is untextured metallic-roughness PBR, so packing
// reproduces them exactly. The shared uniform fcLightK scales the light channels for night.
// Rig parts: extractParts() splits a loaded model into rigid parts at the joints the renderer
// animates (wheels, limbs) or will (the robotaxi's sliding door), each baked relative to its pivot.

import * as THREE from "three";
import { injectUniforms } from "./materials.ts";
import { channelRatio, lightChannel } from "./lights.ts";
import { clusterSimplify } from "./simplify.ts";

/** Shared by every packed material: x head, y tail, z status light intensity; w flash strength. */
export const agentUniforms = {
  fcLightK: { value: new THREE.Vector4(0, 0, 0, 2.2) },
};

export interface PackedSurface {
  color: readonly [number, number, number];
  roughness: number;
  metalness: number;
  emissive: readonly [number, number, number];
  channel: number;
  /** People only: weights of the shirt, trousers, skin and hair instance colours. */
  slot?: readonly [number, number, number, number];
}

/** The packed surface of a (glTF) material. Non-standard materials read as matte grey. */
export function surfaceOf(m: THREE.Material): PackedSurface {
  const s = m as THREE.MeshStandardMaterial;
  const color: [number, number, number] = s.color ? [s.color.r, s.color.g, s.color.b] : [0.5, 0.5, 0.5];
  const channel = lightChannel(m.name ?? "");
  const e = s.emissive;
  // Pre-scaled so the material keeps its own night level on a shared channel (lights.ts).
  const k = channel > 0 ? channelRatio(m.name) : 0;
  const emissive: [number, number, number] = channel > 0 && e ? [e.r * k, e.g * k, e.b * k] : [0, 0, 0];
  return {
    color,
    roughness: typeof s.roughness === "number" ? s.roughness : 0.8,
    metalness: typeof s.metalness === "number" ? s.metalness : 0,
    emissive,
    channel,
  };
}

/**
 * One geometry in the packed format: positions and normals transformed by `matrix`, every
 * vertex carrying the surface. Always indexed. With `slots`, an fcSlot attribute is added.
 */
export function packGeometry(src: THREE.BufferGeometry, s: PackedSurface, matrix: THREE.Matrix4 | null, slots: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = src.getAttribute("position") as THREE.BufferAttribute;
  const n = pos.count;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    p[i * 3] = pos.getX(i);
    p[i * 3 + 1] = pos.getY(i);
    p[i * 3 + 2] = pos.getZ(i);
  }
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  const nrm = src.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (nrm) {
    const q = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      q[i * 3] = nrm.getX(i);
      q[i * 3 + 1] = nrm.getY(i);
      q[i * 3 + 2] = nrm.getZ(i);
    }
    g.setAttribute("normal", new THREE.BufferAttribute(q, 3));
  }
  if (src.index) {
    const idx = new Uint32Array(src.index.count);
    for (let i = 0; i < idx.length; i++) idx[i] = src.index.getX(i);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  } else {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (matrix) {
    g.applyMatrix4(matrix);
    // applyMatrix4 normalises normals; a mirrored matrix would also need the winding flipped.
    if (matrix.determinant() < 0) flipWinding(g);
  }
  if (!nrm) g.computeVertexNormals();
  fill(g, "color", 3, n, s.color);
  fill(g, "fcPbr", 2, n, [s.roughness, s.metalness]);
  fill(g, "fcEmit", 4, n, [s.emissive[0], s.emissive[1], s.emissive[2], s.channel]);
  if (slots) fill(g, "fcSlot", 4, n, s.slot ?? [0, 0, 0, 0]);
  return g;
}

function flipWinding(g: THREE.BufferGeometry): void {
  const idx = g.index!;
  for (let i = 0; i + 2 < idx.count; i += 3) {
    const b = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, b);
  }
}

function fill(g: THREE.BufferGeometry, name: string, size: number, n: number, v: readonly number[]): void {
  const a = new Float32Array(n * size);
  for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) a[i * size + k] = v[k]!;
  g.setAttribute(name, new THREE.BufferAttribute(a, size));
}

/** Concatenate packed geometries (same attribute set) into one indexed geometry. */
export function mergePacked(list: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  if (list.length === 0) return out;
  const names = Object.keys(list[0]!.attributes);
  let verts = 0;
  let idxCount = 0;
  for (const g of list) {
    verts += g.getAttribute("position").count;
    idxCount += g.index ? g.index.count : g.getAttribute("position").count;
  }
  for (const name of names) {
    const size = list[0]!.getAttribute(name).itemSize;
    const arr = new Float32Array(verts * size);
    let off = 0;
    for (const g of list) {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (!a || a.itemSize !== size) throw new Error(`mergePacked: attribute ${name} missing or of another size`);
      arr.set(a.array as Float32Array, off);
      off += a.count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  const idx = verts > 65535 ? new Uint32Array(idxCount) : new Uint16Array(idxCount);
  let base = 0;
  let o = 0;
  for (const g of list) {
    const n = g.getAttribute("position").count;
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[o++] = g.index.getX(i) + base;
    else for (let i = 0; i < n; i++) idx[o++] = i + base;
    base += n;
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

// ---------------------------------------------------------------- the shader

const VERTEX_PARS = /* glsl */ `
attribute vec2 fcPbr;
attribute vec4 fcEmit;
attribute vec4 fcCue;
uniform vec4 fcLightK;
varying vec2 vFcPbr;
varying vec3 vFcEmit;
varying vec2 vFcCombat;
varying vec3 vFcObj;
#ifdef FC_SLOTS
attribute vec4 fcSlot;
attribute vec3 fcColA;
attribute vec3 fcColB;
attribute vec3 fcColC;
attribute vec3 fcColD;
#endif
`;

const VERTEX_MAIN = /* glsl */ `
  vFcPbr = fcPbr;
  vFcCombat = fcCue.zw;
  vFcObj = position;
  {
    float ch = fcEmit.w;
    float k = 0.0;
    if ( ch > 0.5 && ch < 1.5 ) k = fcLightK.x;
    else if ( ch > 1.5 && ch < 2.5 ) k = max( fcLightK.y, fcCue.x * 0.8 );
    else if ( ch > 2.5 ) k = fcLightK.z;
    if ( ch > 0.5 ) k += fcCue.y * fcLightK.w;
    vFcEmit = fcEmit.rgb * k;
  }
#ifdef FC_SLOTS
  {
    float rest = clamp( 1.0 - fcSlot.x - fcSlot.y - fcSlot.z - fcSlot.w, 0.0, 1.0 );
    vColor.rgb = vColor.rgb * rest + fcColA * fcSlot.x + fcColB * fcSlot.y + fcColC * fcSlot.z + fcColD * fcSlot.w;
  }
#endif
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec2 vFcPbr;
varying vec3 vFcEmit;
varying vec2 vFcCombat;
varying vec3 vFcObj;
float fcAgHash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float fcAgNoise( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( fcAgHash( i ), fcAgHash( i + vec3( 1, 0, 0 ) ), f.x ),
                   mix( fcAgHash( i + vec3( 0, 1, 0 ) ), fcAgHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( fcAgHash( i + vec3( 0, 0, 1 ) ), fcAgHash( i + vec3( 1, 0, 1 ) ), f.x ),
                   mix( fcAgHash( i + vec3( 0, 1, 1 ) ), fcAgHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
`;

/**
 * Rust (vFcCombat.x, 0..1): patches of orange-brown oxide that grow from seams and edges as the
 * robot rusts and cover it whole when it seizes; matte and dull where they lie. Wet (y, 0..1):
 * darker and glossier, as water darkens paint and fabric. Patches live in the model's own space
 * (they stay put as it moves); the finer octave fades out before it can shimmer.
 */
const COMBAT_COLOR = /* glsl */ `
  float fcRust = vFcCombat.x;
  float fcRustCover = 0.0;
  if ( fcRust > 0.001 ) {
    vec3 q = vFcObj * 5.0;
    float fine = 1.0 - smoothstep( 0.4, 1.2, length( fwidth( q ) ) );
    float n = 0.65 * fcAgNoise( q ) + 0.35 * mix( 0.5, fcAgNoise( q * 3.7 + 11.0 ), fine );
    float edge = 1.15 - 1.3 * fcRust;
    fcRustCover = smoothstep( edge, edge + 0.12, n );
    vec3 rustCol = mix( vec3( 0.20, 0.065, 0.02 ), vec3( 0.52, 0.20, 0.055 ), fcAgNoise( q * 2.3 + 5.0 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, rustCol, fcRustCover );
  }
  diffuseColor.rgb *= 1.0 - 0.3 * vFcCombat.y;
`;

function patchAgentShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  injectUniforms(shader);
  Object.assign(shader.uniforms, agentUniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
    .replace("#include <color_vertex>", `#include <color_vertex>\n${VERTEX_MAIN}`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
    .replace("#include <color_fragment>", `#include <color_fragment>\n${COMBAT_COLOR}`)
    .replace(
      "#include <roughnessmap_fragment>",
      "#include <roughnessmap_fragment>\n  roughnessFactor = mix( mix( vFcPbr.x, 0.92, fcRustCover ), 0.18, 0.75 * vFcCombat.y );",
    )
    .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n  metalnessFactor = mix( vFcPbr.y, 0.1, fcRustCover );")
    .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance += vFcEmit;");
}

/** The packed agent material; `slots` = people (per-instance clothing and skin colours). */
export function packedMaterial(slots: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, name: slots ? "fc:agent-people" : "fc:agent" });
  if (slots) m.defines = { FC_SLOTS: "" };
  m.onBeforeCompile = patchAgentShader;
  m.customProgramCacheKey = () => (slots ? "fc:agent-slots:v2" : "fc:agent:v2");
  return m;
}

// ---------------------------------------------------------------- rig parts

export type Channel =
  | { type: "none" }
  /** Wheels: roll about local +X. */
  | { type: "spin" }
  /** Front wheels: steer about local +Y, then roll. */
  | { type: "steer-spin" }
  /** Limbs: swing about +X by gain * gait swing (+ = forward). */
  | { type: "swing"; gain: number }
  /**
   * The robotaxi's kerb-side sliding door (door_slide_R, assets/blender/README.md): it opens by
   * moving popM out along +X, then slideM back along +Z. Drawn shut: the sim has no door state
   * yet. The hook is here so opening it is a pose change, not a new part.
   */
  | { type: "slide" };

export interface PartSpec {
  name: string;
  /** glTF nodes (and their descendants not claimed by another part) that move as this part. */
  nodes: readonly string[];
  /** "root" = the model origin; "node" = the first node's origin; "centre" = mean of the nodes' origins; or another part's pivot. */
  pivot: "root" | "node" | "centre" | { part: string };
  channel: Channel;
  /** Drawn only while the agent's bag is full (errand robot). */
  bagContents?: boolean;
}

export interface PackedPart {
  name: string;
  /** Model-space geometry relative to the pivot, or null when the model had none for it. */
  geometry: THREE.BufferGeometry | null;
  pivot: THREE.Vector3;
  channel: Channel;
  bagContents: boolean;
}

export interface PackedModel {
  parts: PackedPart[];
  /** Model-space bounds of everything (rest pose). */
  bounds: THREE.Box3;
  /** Model-space bounds of the root part (the body, without wheels, limbs or doors). */
  bodyBounds: THREE.Box3;
  /** From the wheel nodes' extras, metres (0.35 if none). */
  wheelRadius: number;
  /** Front to rear axle, metres (2.7 if not derivable). */
  wheelbase: number;
}

/**
 * Split a loaded model into packed rigid parts. A mesh belongs to the part that lists it or its
 * nearest listed ancestor; anything unclaimed goes to the part whose pivot is "root". The model's
 * own geometry is only read, never modified (it is shared with the registry's prototype).
 */
export function extractParts(root: THREE.Object3D, specs: readonly PartSpec[]): PackedModel {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const byName = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if (o.name && !byName.has(o.name)) byName.set(o.name, o);
  });
  const owner = new Map<THREE.Object3D, number>();
  specs.forEach((s, i) => {
    for (const n of s.nodes) {
      const o = byName.get(n);
      if (o) owner.set(o, i);
    }
  });
  const rest = Math.max(0, specs.findIndex((s) => s.pivot === "root"));
  const modelMatrix = (o: THREE.Object3D): THREE.Matrix4 => new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
  const origin = (o: THREE.Object3D): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(modelMatrix(o));
  const pivots: THREE.Vector3[] = specs.map((s) => {
    if (typeof s.pivot === "object" || s.pivot === "root") return new THREE.Vector3();
    const nodes = s.nodes.map((n) => byName.get(n)).filter((o): o is THREE.Object3D => !!o);
    if (nodes.length === 0) return new THREE.Vector3();
    if (s.pivot === "node") return origin(nodes[0]!);
    const c = new THREE.Vector3();
    for (const o of nodes) c.add(origin(o));
    return c.multiplyScalar(1 / nodes.length);
  });
  specs.forEach((s, i) => {
    if (typeof s.pivot === "object") {
      const j = specs.findIndex((t) => t.name === (s.pivot as { part: string }).part);
      if (j >= 0) pivots[i] = pivots[j]!.clone();
    }
  });

  const lists: THREE.BufferGeometry[][] = specs.map(() => []);
  const bounds = new THREE.Box3();
  const bodyBounds = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    let part = rest;
    for (let p: THREE.Object3D | null = mesh; p && p !== root; p = p.parent) {
      const k = owner.get(p);
      if (k !== undefined) {
        part = k;
        break;
      }
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const m = modelMatrix(mesh);
    const model = packGeometry(mesh.geometry, surfaceOf(mats[0]!), m, false);
    model.computeBoundingBox();
    bounds.union(model.boundingBox!);
    if (part === rest) bodyBounds.union(tmp.copy(model.boundingBox!));
    model.translate(-pivots[part]!.x, -pivots[part]!.y, -pivots[part]!.z);
    lists[part]!.push(model);
  });

  let wheelRadius = 0.35;
  const axles: number[] = [];
  root.traverse((o) => {
    const u = o.userData as { radius?: unknown; wheel?: unknown };
    if (typeof u.wheel === "string") {
      if (typeof u.radius === "number" && u.radius > 0) wheelRadius = u.radius;
      axles.push(origin(o).z);
    }
  });
  const wheelbase = axles.length >= 2 ? Math.max(...axles) - Math.min(...axles) : 2.7;

  const parts: PackedPart[] = specs.map((s, i) => ({
    name: s.name,
    geometry: lists[i]!.length > 0 ? mergePacked(lists[i]!) : null,
    pivot: pivots[i]!,
    channel: s.channel,
    bagContents: s.bagContents === true,
  }));
  for (const l of lists) for (const g of l) g.dispose();
  return { parts, bounds, bodyBounds, wheelRadius, wheelbase };
}

/**
 * A far proxy of a packed model: every part back in its rest pose, merged, simplified by vertex
 * clustering with `cell`-metre cells (lights kept whole), flat-shaded.
 */
export function proxyOf(model: PackedModel, cell: number): THREE.BufferGeometry {
  const rest: THREE.BufferGeometry[] = [];
  for (const p of model.parts) {
    if (!p.geometry) continue;
    const g = p.geometry.clone();
    g.translate(p.pivot.x, p.pivot.y, p.pivot.z);
    rest.push(g);
  }
  const merged = mergePacked(rest);
  for (const g of rest) g.dispose();
  const out = simplifyPacked(merged, cell);
  merged.dispose();
  return out;
}

/** Vertex-cluster a packed geometry (see simplify.ts); light triangles are kept. */
export function simplifyPacked(g: THREE.BufferGeometry, cell: number): THREE.BufferGeometry {
  const pos = g.getAttribute("position").array as Float32Array;
  const index = g.index ? (g.index.array as ArrayLike<number>) : null;
  const emit = g.getAttribute("fcEmit") as THREE.BufferAttribute;
  const vi = (t: number, k: number): number => (index ? index[t * 3 + k]! : t * 3 + k);
  const r = clusterSimplify(pos, index, cell, (t) => emit.getW(vi(t, 0)) > 0.5);
  const out = new THREE.BufferGeometry();
  const nTri = r.source.length;
  out.setAttribute("position", new THREE.BufferAttribute(r.positions, 3));
  for (const name of Object.keys(g.attributes)) {
    if (name === "position" || name === "normal") continue;
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    const size = a.itemSize;
    const arr = new Float32Array(nTri * 3 * size);
    for (let t = 0; t < nTri; t++) {
      const v = vi(r.source[t]!, 0);
      for (let k = 0; k < 3; k++) for (let c = 0; c < size; c++) arr[(t * 3 + k) * size + c] = a.array[v * size + c]!;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  out.computeVertexNormals(); // non-indexed: flat face normals
  const idx = nTri * 3 > 65535 ? new Uint32Array(nTri * 3) : new Uint16Array(nTri * 3);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Triangles in a geometry. */
export function triangleCount(g: THREE.BufferGeometry | null): number {
  if (!g) return 0;
  return Math.floor((g.index ? g.index.count : g.getAttribute("position").count) / 3);
}
