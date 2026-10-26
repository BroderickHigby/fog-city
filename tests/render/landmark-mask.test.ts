import * as THREE from "three";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterLandmarkHulls } from "../../src/render/landmark-mask.ts";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
import type { TileCollider } from "../../src/sim/world.ts";

const tile = JSON.parse(readFileSync(new URL("../../public/tiles/sf/t-10_-2.collider.json", import.meta.url), "utf8")) as TileCollider;
const ids = new Set(["201006.0000986", "201006.0000986-tower", "201006.0006360", "201006.0006456", "201006.0156555", "201006.0157252"]);
const sources = tile.buildings.filter(b => ids.has(b.id));

describe("landmark far hull replacement", () => {
  it("removes only elevated hull triangles and keeps terrain and neighbouring geometry immutable", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      -10, 0, -10, 10, 0, -10, 0, 20, 10,
      -10, 0, -10, 10, 0, -10, 0, 0, 10,
      40, 0, -10, 50, 0, -10, 45, 20, 10,
    ], 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Array(27).fill(.4), 3));
    geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const buildings = [{ id: "old", footprint: [[-10,-10],[10,-10],[10,10],[-10,10]] as Array<[number,number]>, baseY: 0, topY: 20 }];
    const result = filterLandmarkHulls(geometry, new THREE.Matrix4(), buildings)!;
    expect(result).not.toBeNull();
    expect([...result.index!.array]).toEqual([3, 4, 5, 6, 7, 8]);
    expect([...geometry.index!.array]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...result.getAttribute("color").array]).toEqual([...geometry.getAttribute("color").array]);
    result.dispose(); geometry.dispose();
  });

  it("keeps the committed far-cell ground and exhibition hall while removing all six Palace hulls", async () => {
    const bytes = readFileSync(new URL("../../public/tiles/sf/f2_1.glb", import.meta.url));
    const gltf = await createTileLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    gltf.scene.updateMatrixWorld(true);
    let removed = 0;
    gltf.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const before = mesh.geometry;
      const result = filterLandmarkHulls(before, mesh.matrixWorld, sources)!;
      expect(result).not.toBeNull();
      const oldIndices = before.index!.array, newIndices = result.index!.array;
      removed += (oldIndices.length - newIndices.length) / 3;
      for(const source of sources){
        const one=filterLandmarkHulls(before,mesh.matrixWorld,[source]);
        expect(one,source.id).not.toBeNull();
        one?.dispose();
      }
      const kept = new Set(Array.from(newIndices));
      const pos = before.getAttribute("position");
      const p = new THREE.Vector3();
      for (let i=0;i<oldIndices.length;i+=3) {
        const vs = [oldIndices[i]!, oldIndices[i+1]!, oldIndices[i+2]!];
        const xyz = vs.map(v => p.fromBufferAttribute(pos, v).applyMatrix4(mesh.matrixWorld).clone());
        // Terrain and the separate exhibition hall must be bit-identical survivors.
        if (xyz.every(v => v.y < 10) || xyz.every(v => v.x < -4859)) {
          expect(vs.every(v => kept.has(v)), JSON.stringify(xyz)).toBe(true);
        }
      }
      result.dispose(); before.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    });
    expect(removed).toBeGreaterThan(35);
    expect(removed).toBeLessThan(120);
  });
});
