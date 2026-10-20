// One tile -> one binary glTF (GLB) via @gltf-transform/core.
//
// Scene layout (node names are part of the contract with the renderer):
//   ground     terrain heightfield, smooth normals, COLOR_0 (water is blue-grey)
//   roads      surface road ribbons, TEXCOORD_0 = (0 left kerb .. 1 right kerb, metres along the edge)
//   freeways   freeway and ramp ribbons, draped on the terrain (the source has no deck heights)
//   buildings  every building in the tile, merged. No normals: glTF loaders shade flat.
//              COLOR_0 facade colour, TEXCOORD_0 = (metres along the wall, metres above the base),
//              _FACADE = (storey height / 8 m, glazing 0..1, (year - 1840) / 190 or 0, roof 0|1),
//              node extras.buildings = [[colliderId, firstIndex, indexCount], ...]
// Positions are world-frame local metres (the colliders' frame); every node has an identity transform.

import { Document, NodeIO, type Material } from "@gltf-transform/core";
import type { TileRef } from "./config.ts";
import type { MeshData } from "./mesh.ts";

export interface TileMeshes {
  ground: MeshData;
  roads: MeshData;
  freeways: MeshData;
  buildings: MeshData;
  buildingRanges: Array<[string, number, number]>;
}

export async function tileGlb(world: string, tile: TileRef, parts: TileMeshes): Promise<Uint8Array> {
  const doc = new Document();
  doc.getRoot().getAsset().generator = "fog-city pipeline (glTF-Transform)";
  const buffer = doc.createBuffer("tile");
  const scene = doc.createScene(tile.id).setExtras({ world, tile: tile.id, ix: tile.ix, iz: tile.iz, bbox: tile.bbox });
  doc.getRoot().setDefaultScene(scene);

  // Created only when used, so a tile never carries an unused material.
  const material = (name: string, roughness: number) => (): Material =>
    doc.createMaterial(name).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(roughness);
  const mats = {
    ground: material("ground", 0.95),
    road: material("road", 0.9),
    freeway: material("freeway", 0.9),
    building: material("building", 0.85),
  };

  const add = (name: string, m: MeshData, makeMat: () => Material, extras?: Record<string, unknown>): void => {
    if (m.indices.length === 0) return;
    const mat = makeMat();
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
    const mesh = doc.createMesh(name).addPrimitive(prim);
    const node = doc.createNode(name).setMesh(mesh);
    if (extras) node.setExtras(extras);
    scene.addChild(node);
  };

  add("ground", parts.ground, mats.ground);
  add("roads", parts.roads, mats.road);
  add("freeways", parts.freeways, mats.freeway);
  add("buildings", parts.buildings, mats.building, { buildings: parts.buildingRanges });

  return new NodeIO().writeBinary(doc);
}
