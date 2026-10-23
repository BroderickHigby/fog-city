// World QA W-15 and W-29 (house kit K0, K2): facades are drawn with believable storeys from the
// street. Read from the glbs as the renderer gets them: the storey height in _FACADE.x and the
// storey grid's origin (y - uv.v on a wall vertex), against the colliders and the sim's ground.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BufferAttribute, BufferGeometry, Mesh } from "three";
import { Vector3 } from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { distToSegment, type P2 } from "../../pipeline/lib/geom.ts";
import { ROOT } from "../helpers.ts";
import { groundIndex, loadGlbWithThree, loadSf, type SfBuilding } from "./util.ts";

const { manifest, colliders, roads } = loadSf();
const heightAt = groundIndex(colliders);
/** Every third tile, plus the QA report's sample tiles (Sunset, Mission, Marina, Russian Hill). */
const sampleTiles = manifest.tiles.filter((t, i) => i % 3 === 0 || ["t-17_8", "t-6_8", "t-7_4", "t-9_-1", "t-5_-1"].includes(t.id));

interface Drawn {
  b: SfBuilding;
  storeyM: number;
  origin: number;
}
const drawn: Drawn[] = [];

beforeAll(async () => {
  const v = new Vector3();
  for (const t of sampleTiles) {
    const c = colliders[manifest.tiles.indexOf(t)]!;
    const byId = new Map(c.buildings.map((b) => [b.id, b]));
    const scene = await loadGlbWithThree(new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", t.glb))));
    scene.updateMatrixWorld(true);
    const node = scene.getObjectByName("buildings") as Mesh<BufferGeometry> | undefined;
    if (!node) continue;
    const pos = node.geometry.attributes.position as BufferAttribute;
    const uv = node.geometry.attributes.uv as BufferAttribute;
    const fac = node.geometry.attributes._facade as BufferAttribute;
    const index = node.geometry.index!;
    for (const [id, first, count] of node.userData.buildings as Array<[string, number, number]>) {
      const b = byId.get(id)!;
      if (b.meta.towerOf !== undefined) continue;
      for (let k = first; k < first + count; k++) {
        const vi = index.getX(k);
        if (fac.getW(vi) > 0.9) continue; // a roof vertex
        v.fromBufferAttribute(pos, vi).applyMatrix4(node.matrixWorld);
        drawn.push({ b, storeyM: fac.getX(vi) * 8, origin: v.y - uv.getY(vi) });
        break;
      }
    }
  }
}, 300_000);

const residential = (b: SfBuilding): boolean => {
  const use = (b.meta.use ?? "").toLowerCase();
  return use.includes("residential") || (use === "" && b.topY - b.baseY < 16);
};

describe("facade storeys (W-15, W-29)", () => {
  it("fewer than 2% of residential records are drawn with storeys of 5 m or more (baseline 61%), and none over 4.25 m", () => {
    const res = drawn.filter((d) => residential(d.b));
    expect(res.length).toBeGreaterThan(30_000);
    const tall = res.filter((d) => d.storeyM >= 5);
    expect(tall.length / res.length).toBeLessThan(0.02);
    expect(res.filter((d) => d.storeyM > 4.25).length).toBe(0);
  });

  it("the Sunset's 1920-1960 rows show their garage storey: at least the roll's storeys plus one where the wall is tall enough", () => {
    const rows = drawn.filter((d) => residential(d.b) && (d.b.meta.year ?? 0) >= 1920 && (d.b.meta.year ?? 0) <= 1960 && d.b.meta.stories === 1 && d.b.topY - (d.b.meta.streetY ?? d.b.baseY) >= 7.5);
    expect(rows.length).toBeGreaterThan(1000);
    const one = rows.filter((d) => (d.b.topY - (d.b.meta.streetY ?? d.b.baseY)) / d.storeyM < 1.5);
    expect(one.length / rows.length).toBeLessThan(0.05);
  });

  it("at most 1% of street-facing buildings start their storey grid more than 1.5 m off the sidewalk (baseline 11.1%)", () => {
    // The QA audit's street wall: of the walls 3 m or longer, the one whose middle is nearest a
    // vehicular centreline less half its width, within 6 m; the sidewalk is the sim's ground there.
    const segs = roads.edges.filter((e) => !e.pedestrian && e.kind !== "freeway" && e.kind !== "ramp").flatMap((e) => e.points.slice(1).map((b, i) => [e.points[i]! as P2, b as P2, e.widthM / 2] as const));
    const cells = new Map<string, Array<(typeof segs)[number]>>();
    for (const s of segs) {
      const [a, b] = s;
      for (let cx = Math.floor((Math.min(a[0], b[0]) - 20) / 50); cx <= Math.floor((Math.max(a[0], b[0]) + 20) / 50); cx++) {
        for (let cz = Math.floor((Math.min(a[1], b[1]) - 20) / 50); cz <= Math.floor((Math.max(a[1], b[1]) + 20) / 50); cz++) (cells.get(`${cx},${cz}`) ?? cells.set(`${cx},${cz}`, []).get(`${cx},${cz}`)!).push(s);
      }
    }
    let facing = 0, off = 0;
    const worst: string[] = [];
    for (const d of drawn) {
      const f = d.b.footprint as P2[];
      let best: { d: number; m: P2 } | null = null;
      for (let i = 0; i < f.length; i++) {
        const a = f[i]!, c = f[(i + 1) % f.length]!;
        if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 3) continue;
        const m: P2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
        for (const [p, q, hw] of cells.get(`${Math.floor(m[0] / 50)},${Math.floor(m[1] / 50)}`) ?? []) {
          const dd = distToSegment(m[0], m[1], p, q).d - hw;
          if (dd <= 6 && (!best || dd < best.d)) best = { d: dd, m };
        }
      }
      if (!best) continue;
      facing++;
      const gap = d.origin - heightAt(best.m[0], best.m[1]);
      if (Math.abs(gap) > 1.5) {
        off++;
        if (worst.length < 10) worst.push(`${d.b.id} ${gap.toFixed(2)} m`);
      }
    }
    expect(facing).toBeGreaterThan(20_000);
    expect(off / facing, worst.join(", ")).toBeLessThanOrEqual(0.01);
  });

  it("meta.streetY is the drawn grid's origin wherever it is written", () => {
    let n = 0;
    for (const d of drawn) {
      if (d.b.meta.streetY === undefined) {
        expect(Math.abs(d.origin - d.b.baseY), d.b.id).toBeLessThan(0.05);
        continue;
      }
      n++;
      expect(Math.abs(d.origin - d.b.meta.streetY), d.b.id).toBeLessThan(0.05);
    }
    expect(n).toBeGreaterThan(5000);
  });
});
