// One tile -> one binary glTF (GLB) via @gltf-transform/core.
//
// Scene layout (node names are part of the contract with the renderer):
//   ground     terrain heightfield, smooth normals, COLOR_0 (water is blue-grey)
//   roads      surface road ribbons, TEXCOORD_0 = (0 left kerb .. 1 right kerb, metres along the edge)
//   freeways   freeway and ramp ribbons: on their decks (decks.ts) where the deck layer lifts
//              them, in their bores in a tunnel, else draped on the terrain
//   structures deck sides, undersides and columns (decks.ts), COLOR_0 concrete; only in tiles
//              with an elevated deck. Any road ribbon on a deck is drawn level at the deck.
//   buildings  every building in the tile, merged. No normals: glTF loaders shade flat.
//              COLOR_0 facade colour, TEXCOORD_0 = (metres along the wall, metres above the base),
//              _FACADE = (storey height / 8 m, glazing 0..1, (year - 1840) / 190 or 0, roof 0|1),
//              node extras.buildings = [[colliderId, firstIndex, indexCount], ...]
//
// Compression (docs/data-sources.md, "Compression"): POSITION is int16 on a 1/64 m grid
// (KHR_mesh_quantization), NORMAL is int8, and every buffer view is then packed with
// EXT_meshopt_compression (lossless on the quantised data). Each mesh node carries the
// dequantisation as its transform: translation (tile centre x, 0, tile centre z) and a uniform
// scale of the grid step, so node.matrix * POSITION is world-frame local metres (the colliders'
// frame). The grid is aligned to whole metres (tile centres are multiples of 250 m and the
// step is a power of two), so neighbouring tiles' border vertices dequantise to the same floats.
// Loaders need the meshopt decoder: three.js GLTFLoader.setMeshoptDecoder(MeshoptDecoder).

import { Document, NodeIO, type Material, type Node } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptEncoder } from "meshoptimizer";
import type { TileRef } from "./config.ts";
import { MeshData } from "./mesh.ts";

/** Position grid, metres. A power of two: dequantised positions are exact binary fractions. */
export const POSITION_STEP_M = 1 / 64;
const INT16_MAX = 32767;

export interface GlbOptions {
  /** int16 positions and int8 normals (KHR_mesh_quantization). Default true. */
  quantize?: boolean;
  /** EXT_meshopt_compression on every buffer view. Default true (needs quantize for the full gain). */
  meshopt?: boolean;
}

/**
 * Quantise every mesh node in place: POSITION to int16 about `centre` on the POSITION_STEP_M
 * grid (doubling the step for a mesh too big for int16, which never happens to ground or roads),
 * NORMAL to normalised int8. The node gets the dequantising transform.
 */
export function quantizeDocument(doc: Document, centre: readonly [number, number]): void {
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  const [cx, cz] = centre;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const t = node.getTranslation();
    const sc = node.getScale();
    if (t.some((v) => v !== 0) || sc.some((v) => v !== 1) || node.getRotation()[3] !== 1) throw new Error(`quantize: node ${node.getName()} already has a transform`);
    let reach = 0;
    for (const prim of mesh.listPrimitives()) {
      const a = prim.getAttribute("POSITION")!.getArray()!;
      for (let i = 0; i < a.length; i += 3) reach = Math.max(reach, Math.abs(a[i]! - cx), Math.abs(a[i + 1]!), Math.abs(a[i + 2]! - cz));
    }
    let step = POSITION_STEP_M;
    while (reach / step > INT16_MAX) step *= 2;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION")!;
      const a = pos.getArray()!;
      const q = new Int16Array(a.length);
      for (let i = 0; i < a.length; i += 3) {
        q[i] = Math.round((a[i]! - cx) / step);
        q[i + 1] = Math.round(a[i + 1]! / step);
        q[i + 2] = Math.round((a[i + 2]! - cz) / step);
      }
      pos.setArray(q).setNormalized(false);
      const nrm = prim.getAttribute("NORMAL");
      if (nrm) {
        const n = nrm.getArray()!;
        const qn = new Int8Array(n.length);
        for (let i = 0; i < n.length; i++) qn[i] = Math.max(-127, Math.min(127, Math.round(n[i]! * 127)));
        nrm.setArray(qn).setNormalized(true);
      }
    }
    setDequantize(node, cx, cz, step);
  }
}

function setDequantize(node: Node, cx: number, cz: number, step: number): void {
  node.setTranslation([cx, 0, cz]).setScale([step, step, step]);
}

/** Serialise, with meshopt compression when asked. Deterministic: same document, same bytes. */
export async function writeGlb(doc: Document, opts: GlbOptions = {}): Promise<Uint8Array> {
  const io = new NodeIO().registerExtensions([KHRMeshQuantization, EXTMeshoptCompression]);
  if (opts.meshopt ?? true) {
    await MeshoptEncoder.ready;
    io.registerDependencies({ "meshopt.encoder": MeshoptEncoder });
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  }
  return io.writeBinary(doc);
}

export interface TileMeshes {
  ground: MeshData;
  roads: MeshData;
  freeways: MeshData;
  buildings: MeshData;
  buildingRanges: Array<[string, number, number]>;
  /** Deck sides, undersides and columns (decks.ts); absent or empty when the tile has none. */
  structures?: MeshData;
}

export interface GlbPart {
  /** Node and mesh name (a contract with the renderer). */
  name: string;
  mesh: MeshData;
  /**
   * Reorder triangles for the vertex cache and vertices by first use (meshoptimizer), which
   * compresses far better: the whole mesh, or within each of these index ranges (a building's
   * triangles stay in its own range).
   */
  reorder?: boolean | ReadonlyArray<readonly [string, number, number]>;
  /** Material name; one plain PBR material per name, created only when used. */
  material: string;
  roughness: number;
  extras?: Record<string, unknown>;
}

/**
 * A glb of named mesh nodes in world-frame metres, quantised about `centre` (x, z) and meshopt-
 * compressed unless the options say otherwise. Parts with no triangles are left out.
 */
export async function meshGlb(sceneExtras: Record<string, unknown>, centre: readonly [number, number], parts: readonly GlbPart[], opts: GlbOptions = {}): Promise<Uint8Array> {
  const doc = new Document();
  doc.getRoot().getAsset().generator = "fog-city pipeline (glTF-Transform)";
  const buffer = doc.createBuffer("tile");
  const name = String(sceneExtras.tile ?? sceneExtras.far ?? "scene");
  const scene = doc.createScene(name).setExtras(sceneExtras);
  doc.getRoot().setDefaultScene(scene);
  const materials = new Map<string, Material>();
  if (parts.some((p) => p.reorder)) await MeshoptEncoder.ready;
  for (const part of parts) {
    const m = part.reorder === true ? reorderMesh(part.mesh) : part.reorder ? reorderRanges(part.mesh, part.reorder) : part.mesh;
    if (m.indices.length === 0) continue;
    let mat = materials.get(part.material);
    if (!mat) {
      mat = doc.createMaterial(part.material).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(part.roughness);
      materials.set(part.material, mat);
    }
    const acc = (type: "SCALAR" | "VEC2" | "VEC3" | "VEC4", array: Float32Array | Uint8Array | Uint16Array | Uint32Array, normalized = false) =>
      doc.createAccessor().setType(type).setArray(array).setNormalized(normalized).setBuffer(buffer);
    const prim = doc
      .createPrimitive()
      .setMaterial(mat)
      .setAttribute("POSITION", acc("VEC3", new Float32Array(m.positions)))
      .setAttribute("COLOR_0", acc("VEC4", new Uint8Array(m.colors), true));
    if (m.normals) prim.setAttribute("NORMAL", acc("VEC3", new Float32Array(m.normals)));
    if (m.uvs) prim.setAttribute("TEXCOORD_0", acc("VEC2", new Float32Array(m.uvs)));
    if (m.facade) prim.setAttribute("_FACADE", acc("VEC4", new Uint8Array(m.facade), true));
    prim.setIndices(acc("SCALAR", m.vertexCount <= 65535 ? new Uint16Array(m.indices) : new Uint32Array(m.indices)));
    const mesh = doc.createMesh(part.name).addPrimitive(prim);
    const node = doc.createNode(part.name).setMesh(mesh);
    if (part.extras) node.setExtras(part.extras);
    scene.addChild(node);
  }
  if (opts.quantize ?? true) quantizeDocument(doc, centre);
  return writeGlb(doc, opts);
}

/** A copy of a mesh with its triangles in vertex-cache order and its vertices in first-use order. */
function reorderMesh(m: MeshData): MeshData {
  if (m.indices.length === 0) return m;
  const idx = Uint32Array.from(m.indices);
  const [remap, unique] = MeshoptEncoder.reorderMesh(idx, true, true);
  const out = new MeshData({ normals: m.normals !== null, uvs: m.uvs !== null, facade: m.facade !== null });
  const n = m.vertexCount;
  const pos = new Array<number>(unique * 3), col = new Array<number>(unique * 4);
  const nrm = m.normals ? new Array<number>(unique * 3) : null;
  const uv = m.uvs ? new Array<number>(unique * 2) : null;
  const fac = m.facade ? new Array<number>(unique * 4) : null;
  for (let i = 0; i < n; i++) {
    const j = remap[i]!;
    if (j === 0xffffffff) continue;
    for (let k = 0; k < 3; k++) pos[j * 3 + k] = m.positions[i * 3 + k]!;
    for (let k = 0; k < 4; k++) col[j * 4 + k] = m.colors[i * 4 + k]!;
    if (nrm) for (let k = 0; k < 3; k++) nrm[j * 3 + k] = m.normals![i * 3 + k]!;
    if (uv) for (let k = 0; k < 2; k++) uv[j * 2 + k] = m.uvs![i * 2 + k]!;
    if (fac) for (let k = 0; k < 4; k++) fac[j * 4 + k] = m.facade![i * 4 + k]!;
  }
  out.positions = pos;
  out.colors = col;
  out.normals = nrm;
  out.uvs = uv;
  out.facade = fac;
  out.indices = Array.from(idx);
  return out;
}

/**
 * reorderMesh within each index range (a building's triangles stay in its range, so the
 * renderer's per-building ranges keep their meaning) and vertices in first-use order.
 */
function reorderRanges(m: MeshData, ranges: ReadonlyArray<readonly [string, number, number]>): MeshData {
  const covered = ranges.reduce((n, r) => n + r[2], 0);
  if (m.indices.length === 0 || covered !== m.indices.length) return m;
  const out = new MeshData({ normals: m.normals !== null, uvs: m.uvs !== null, facade: m.facade !== null });
  const indices = new Array<number>(m.indices.length);
  for (const [, first, count] of ranges) {
    if (count === 0) continue;
    let lo = Infinity, hi = -Infinity;
    for (let k = first; k < first + count; k++) {
      lo = Math.min(lo, m.indices[k]!);
      hi = Math.max(hi, m.indices[k]!);
    }
    const local = new Uint32Array(count);
    for (let k = 0; k < count; k++) local[k] = m.indices[first + k]! - lo;
    const [remap, unique] = MeshoptEncoder.reorderMesh(local, true, true);
    const base = out.positions.length / 3;
    const add = (dst: number[] | null, src: number[] | null, w: number): void => {
      if (!dst || !src) return;
      const at = dst.length;
      dst.length = at + unique * w;
      for (let v = 0; v <= hi - lo; v++) {
        const j = remap[v]!;
        if (j === 0xffffffff) continue;
        for (let c = 0; c < w; c++) dst[at + j * w + c] = src[(lo + v) * w + c]!;
      }
    };
    add(out.positions, m.positions, 3);
    add(out.colors, m.colors, 4);
    add(out.normals, m.normals, 3);
    add(out.uvs, m.uvs, 2);
    add(out.facade, m.facade, 4);
    for (let k = 0; k < count; k++) indices[first + k] = base + local[k]!;
  }
  out.indices = indices;
  return out;
}

export async function tileGlb(world: string, tile: TileRef, parts: TileMeshes, opts: GlbOptions = {}): Promise<Uint8Array> {
  return meshGlb(
    { world, tile: tile.id, ix: tile.ix, iz: tile.iz, bbox: tile.bbox },
    [(tile.bbox[0] + tile.bbox[2]) / 2, (tile.bbox[1] + tile.bbox[3]) / 2],
    [
      { name: "ground", mesh: parts.ground, material: "ground", roughness: 0.95 },
      { name: "roads", mesh: parts.roads, material: "road", roughness: 0.9, reorder: true },
      { name: "freeways", mesh: parts.freeways, material: "freeway", roughness: 0.9, reorder: true },
      { name: "buildings", mesh: parts.buildings, material: "building", roughness: 0.85, extras: { buildings: parts.buildingRanges }, reorder: parts.buildingRanges },
      ...(parts.structures ? [{ name: "structures", mesh: parts.structures, material: "structure", roughness: 0.9, reorder: true }] : []),
    ],
    opts,
  );
}
