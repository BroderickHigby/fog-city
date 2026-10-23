// The committed sf GLB tiles and far-LOD cells: valid glTF, compressed as documented, loadable by
// three.js with the renderer's loader (meshopt decoder), consistent with the colliders.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Vector3, type BufferAttribute, type BufferGeometry, type Mesh } from "three";
import { describe, expect, it } from "vitest";
import { ROOT } from "../helpers.ts";
import { decodeGlb, loadGlbWithThree, loadSf, validateGlb } from "./util.ts";

const DIR = join(ROOT, "public/tiles/sf");
const { manifest, colliders } = loadSf();
const bytes = (f: string): Uint8Array => new Uint8Array(readFileSync(join(DIR, f)));

describe("sf GLB tiles", () => {
  it("every tile and far cell passes the Khronos glTF validator with no errors or warnings, compressed and decoded", async () => {
    for (const f of [...manifest.tiles.map((t) => t.glb), ...manifest.far.map((c) => c.glb)]) {
      const b = bytes(f);
      const r = await validateGlb(b);
      expect(r.messages, f).toEqual([]);
      expect(r.errors + r.warnings, f).toBe(0);
      // The validator cannot look inside EXT_meshopt_compression: validate the decoded form too.
      const d = await validateGlb(await decodeGlb(b));
      expect(d.messages, `${f} (decoded)`).toEqual([]);
      expect(d.errors + d.warnings, `${f} (decoded)`).toBe(0);
    }
  }, 300_000);

  it("are meshopt-compressed and quantised, and every node dequantises onto a power-of-two grid about its tile centre", () => {
    for (const t of manifest.tiles) {
      const json = glbJson(bytes(t.glb));
      expect(json.extensionsRequired?.sort(), t.glb).toEqual(["EXT_meshopt_compression", "KHR_mesh_quantization"]);
      for (const n of json.nodes) {
        expect(n.translation, `${t.glb} ${n.name}`).toEqual([t.bbox[0] + 250, 0, t.bbox[1] + 250]);
        if (n.extensions?.EXT_mesh_gpu_instancing) {
          // Instanced foliage (W-18): float prototype vertices about the tree's foot, instance
          // translations about the tile centre, which the node carries at scale 1.
          expect(n.name, t.glb).toMatch(/^foliage-/);
          expect(n.scale ?? [1, 1, 1], `${t.glb} ${n.name}`).toEqual([1, 1, 1]);
          continue;
        }
        expect(n.scale![0]).toBe(n.scale![1]);
        expect(Number.isInteger(Math.log2(n.scale![0]!)), `${t.glb} ${n.name} scale is a power of two`).toBe(true);
        if (n.name === "ground" || n.name === "roads") expect(n.scale![0]).toBe(1 / 64);
      }
    }
  });

  it("every tile loads in three.js; ground sits on the tile's 10 m lattice; building ranges match the collider", async () => {
    const v = new Vector3();
    for (const [i, t] of manifest.tiles.entries()) {
      const scene = await loadGlbWithThree(bytes(t.glb));
      expect(scene.userData).toMatchObject({ world: "sf", tile: t.id });
      scene.updateMatrixWorld(true);
      const ground = scene.getObjectByName("ground") as Mesh<BufferGeometry> | undefined;
      expect(ground, t.id).toBeDefined();
      expect(ground!.geometry.attributes.normal).toBeDefined();
      // Dequantised by the node transform, ground vertices lie on the lattice inside the tile.
      const p = ground!.geometry.attributes.position as BufferAttribute;
      for (let k = 0; k < p.count; k++) {
        v.fromBufferAttribute(p, k).applyMatrix4(ground!.matrixWorld);
        expect(v.x >= t.bbox[0] && v.x <= t.bbox[2] && v.z >= t.bbox[1] && v.z <= t.bbox[3] && v.x % 10 === 0 && v.z % 10 === 0, `${t.id} ${v.x},${v.z}`).toBe(true);
      }
      const ids = colliders[i]!.buildings.map((b) => b.id);
      const node = scene.getObjectByName("buildings") as Mesh<BufferGeometry> | undefined;
      if (ids.length === 0) {
        expect(node).toBeUndefined();
        continue;
      }
      const ranges = node!.userData.buildings as Array<[string, number, number]>;
      expect(ranges.map((r) => r[0])).toEqual(ids);
      const last = ranges[ranges.length - 1]!;
      expect(last[1] + last[2]).toBe(node!.geometry.index!.count);
      expect(Object.keys(node!.geometry.attributes).sort()).toEqual(["_facade", "color", "position", "uv"]);
    }
  }, 300_000);

  it("neighbouring tiles' ground meshes meet exactly at the seam (no cracks after dequantisation)", async () => {
    const byId = new Map(manifest.tiles.map((t) => [t.id, t]));
    const seam = async (id: string, side: "east" | "west"): Promise<Map<number, number>> => {
      const t = byId.get(id)!;
      const scene = await loadGlbWithThree(bytes(t.glb));
      scene.updateMatrixWorld(true);
      const g = scene.getObjectByName("ground") as Mesh<BufferGeometry>;
      const p = g.geometry.attributes.position as BufferAttribute;
      const out = new Map<number, number>();
      const x = side === "east" ? t.bbox[2] : t.bbox[0];
      const v = new Vector3();
      for (let k = 0; k < p.count; k++) {
        v.fromBufferAttribute(p, k).applyMatrix4(g.matrixWorld);
        if (v.x === x) out.set(v.z, v.y);
      }
      return out;
    };
    let pairs = 0;
    for (const t of manifest.tiles.filter((_, i) => i % 4 === 0)) {
      const east = `t${t.ix + 1}_${t.iz}`;
      if (!byId.has(east)) continue;
      const a = await seam(t.id, "east");
      const b = await seam(east, "west");
      for (const [z, y] of a) if (b.has(z)) expect(b.get(z), `${t.id}|${east} z=${z}`).toBe(y);
      pairs++;
    }
    expect(pairs).toBeGreaterThan(50);
  }, 120_000);
});

describe("sf far-LOD cells", () => {
  it("each loads in three.js as one mesh named far; triangles match the manifest", async () => {
    let total = 0;
    for (const c of manifest.far) {
      const scene = await loadGlbWithThree(bytes(c.glb));
      const meshes: Array<Mesh<BufferGeometry>> = [];
      scene.traverse((o) => {
        if ((o as Mesh).isMesh) meshes.push(o as Mesh<BufferGeometry>);
      });
      expect(meshes.map((x) => x.name), c.id).toEqual(["far"]);
      const tris = meshes[0]!.geometry.index!.count / 3;
      expect(tris, c.id).toBe(c.stats.triangles);
      total += tris;
    }
    expect(total).toBeGreaterThan(100000);
  });
});

interface GltfJson {
  extensionsRequired?: string[];
  nodes: Array<{ name: string; translation?: number[]; scale?: number[]; extensions?: { EXT_mesh_gpu_instancing?: unknown } }>;
}

function glbJson(b: Uint8Array): GltfJson {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + len))) as GltfJson;
}
