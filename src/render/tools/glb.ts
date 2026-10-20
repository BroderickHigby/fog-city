// MeshData -> .glb with @gltf-transform/core (offline tools only; never bundled).
//
// Layout of a tile glb, which the runtime relies on (src/render/tile-streamer.ts):
//  - one node + mesh per layer, named for its material: "buildings" (material "building"),
//    "ground" (material "ground"), "roads" (material "road"), "foliage" (material "foliage").
//  - COLOR_0 is linear RGB, unsigned byte, normalized.
//  - building primitives carry TEXCOORD_0 (facade metres) and _FACADE (style index), and
//    primitive extras { fcBuildings: [[id, firstIndex, indexCount], ...] }.
//  - KHR_mesh_quantization: POSITION is int16 normalized under a node translation and
//    uniform scale; NORMAL is int8 normalized. three's GLTFLoader reads both natively.
// The renderer swaps materials by name for its shared ones and leaves unknown ones alone.

import { Document, Extension, NodeIO } from "@gltf-transform/core";
import type { MeshData } from "../tile-geometry.ts";

/** Declares KHR_mesh_quantization (no data of its own). Register it with any NodeIO that reads these files. */
export class KHRMeshQuantization extends Extension {
  static override readonly EXTENSION_NAME = "KHR_mesh_quantization";
  override readonly extensionName = "KHR_mesh_quantization";
  override read(): this {
    return this;
  }
  override write(): this {
    return this;
  }
}

export interface GlbPart {
  name: string;
  material: string;
  data: MeshData;
}

const MATERIAL_PARAMS: Record<string, { rough: number; metal: number }> = {
  building: { rough: 0.85, metal: 0 },
  ground: { rough: 0.97, metal: 0 },
  road: { rough: 0.92, metal: 0 },
  foliage: { rough: 0.95, metal: 0 },
};

/** Quantize positions to int16 around their centre with one uniform scale. */
export function quantizePositions(pos: Float32Array): { q: Int16Array; center: [number, number, number]; scale: number } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  const center: [number, number, number] = [0, 0, 0];
  let scale = 1e-6;
  for (let k = 0; k < 3; k++) {
    // Centre on a 1/16 m grid so the node translation is exact in JSON.
    center[k] = Math.round(((min[k]! + max[k]!) / 2) * 16) / 16;
    scale = Math.max(scale, max[k]! - center[k]!, center[k]! - min[k]!);
  }
  scale = Math.ceil(scale * 1.001 * 16) / 16;
  const q = new Int16Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) q[i + k] = Math.max(-32767, Math.min(32767, Math.round(((pos[i + k]! - center[k]!) / scale) * 32767)));
  }
  return { q, center, scale };
}

function quantizeNormals(n: Float32Array): Int8Array {
  const q = new Int8Array(n.length);
  for (let i = 0; i < n.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(n[i]! * 127)));
  return q;
}

export async function encodeTileGlb(parts: readonly GlbPart[], extras: Record<string, unknown>): Promise<Uint8Array> {
  const doc = new Document();
  doc.getRoot().getAsset().generator = "fog-city build-dev-city";
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  const buffer = doc.createBuffer();
  const scene = doc.createScene(String(extras.tile ?? "tile"));
  scene.setExtras(extras);
  const materials = new Map<string, ReturnType<Document["createMaterial"]>>();
  for (const part of parts) {
    const d = part.data;
    if (d.indices.length === 0) continue;
    let mat = materials.get(part.material);
    if (!mat) {
      const p = MATERIAL_PARAMS[part.material] ?? { rough: 0.9, metal: 0 };
      mat = doc.createMaterial(part.material).setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(p.rough).setMetallicFactor(p.metal);
      materials.set(part.material, mat);
    }
    const vcount = d.positions.length / 3;
    const indices = vcount < 65536 ? new Uint16Array(d.indices) : d.indices;
    const { q, center, scale } = quantizePositions(d.positions);
    const prim = doc
      .createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(q).setNormalized(true).setBuffer(buffer))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(quantizeNormals(d.normals)).setNormalized(true).setBuffer(buffer))
      .setAttribute("COLOR_0", doc.createAccessor().setType("VEC3").setArray(d.colors).setNormalized(true).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer))
      .setMaterial(mat);
    if (d.uvs) prim.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(d.uvs).setBuffer(buffer));
    if (d.facade) prim.setAttribute("_FACADE", doc.createAccessor().setType("SCALAR").setArray(new Uint8Array(d.facade)).setBuffer(buffer));
    if (d.ranges.length > 0) prim.setExtras({ fcBuildings: d.ranges });
    const mesh = doc.createMesh(part.name).addPrimitive(prim);
    scene.addChild(doc.createNode(part.name).setMesh(mesh).setTranslation(center).setScale([scale, scale, scale]));
  }
  return new NodeIO().registerExtensions([KHRMeshQuantization]).writeBinary(doc);
}
