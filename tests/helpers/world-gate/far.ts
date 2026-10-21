// Gate nightly checks on the far layer (docs/qa/world-continuity-gate.md, section B): the
// near/far seam at the streaming ring, far terrain beyond the city's edge, and the far hulls
// against the buildings they stand in for. The far cells' terrain is a 100 m lattice (every
// vertex on whole 100 m multiples, src/render/far-layer.ts onFarLattice); hull triangles are not.

import { toLocal } from "../../../src/geo/project.ts";
import { cellKey, groundHeight } from "../../../src/sim/index.ts";
import { centroid, ll, maxOf, percentile, r2, readGlb, triangleHeight, type GameWorld } from "../world.ts";
import { Measured } from "./suite.ts";

const onLat = (x: number, z: number): boolean => Math.abs(x / 100 - Math.round(x / 100)) < 1e-3 && Math.abs(z / 100 - Math.round(z / 100)) < 1e-3;

class TriGrid {
  readonly cells = new Map<number, number[]>();
  readonly tris: number[] = [];
  readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  add(t: readonly number[]): void {
    const k = this.tris.length / 9;
    this.tris.push(...t);
    const xs = [t[0]!, t[3]!, t[6]!];
    const zs = [t[2]!, t[5]!, t[8]!];
    for (let a = Math.floor(Math.min(...xs) / this.size); a <= Math.floor(Math.max(...xs) / this.size); a++) {
      for (let b = Math.floor(Math.min(...zs) / this.size); b <= Math.floor(Math.max(...zs) / this.size); b++) {
        const key = cellKey(a, b);
        let l = this.cells.get(key);
        if (!l) this.cells.set(key, (l = []));
        l.push(k);
      }
    }
  }
  /** The highest triangle over (x, z), or null. */
  top(x: number, z: number): number | null {
    const l = this.cells.get(cellKey(Math.floor(x / this.size), Math.floor(z / this.size)));
    if (!l) return null;
    let best: number | null = null;
    const T = this.tris;
    for (const k of l) {
      const o = k * 9;
      const y = triangleHeight(x, z, T[o]!, T[o + 1]!, T[o + 2]!, T[o + 3]!, T[o + 4]!, T[o + 5]!, T[o + 6]!, T[o + 7]!, T[o + 8]!);
      if (y !== null && (best === null || y > best)) best = y;
    }
    return best;
  }
}

/** The far layer decoded: its terrain triangles and its hull triangles, gridded. */
export async function farLayer(gw: GameWorld): Promise<{ terrain: TriGrid; hulls: TriGrid }> {
  const terrain = new TriGrid(100);
  const hulls = new TriGrid(20);
  const far = (gw.manifest as { far?: Array<{ glb: string }> }).far ?? [];
  for (const c of far) {
    const g = await readGlb(`public/tiles/${gw.name}/${c.glb}`, undefined, ["POSITION"]);
    for (const n of g.nodes) {
      const P = n.positions;
      for (let q = 0; q < n.indices.length; q += 3) {
        const v = [n.indices[q]! * 3, n.indices[q + 1]! * 3, n.indices[q + 2]! * 3];
        const tri = v.flatMap((i) => [P[i]!, P[i + 1]!, P[i + 2]!]);
        if (v.every((i) => onLat(P[i]!, P[i + 2]!))) terrain.add(tri);
        else hulls.add(tri);
      }
    }
  }
  return { terrain, hulls };
}

/** Tiles at the south edge and beside YBI that neither the built set nor manifest.outside covered (W-40). */
export const UNCOVERED_TILES: readonly string[] = ["t-16_21", "t-4_21", "t-3_21", "t7_-5"];

export async function measureFar(gw: GameWorld): Promise<Measured> {
  const m = new Measured("far", "nightly");
  const world = gw.world;
  const { terrain, hulls } = await farLayer(gw);
  m.lap("decode");
  const built = (ix: number, iz: number): boolean => world.tileGround?.has(cellKey(ix, iz)) ?? false;

  // ---- the ring seam (W-17): near ground against the far terrain across every tile border, every 5 m
  {
    const d: number[] = [];
    let farAboveM = 0;
    let worst = { d: 0, at: "" };
    let uncovered = 0;
    for (const t of gw.tiles) {
      const g = t.ground;
      if (!g) continue;
      const ix = g.x0 / 500;
      const iz = g.z0 / 500;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const outer = !built(ix + dx, iz + dz);
        for (let s = 2.5; s < 500; s += 5) {
          const x = dx === 1 ? g.x0 + 500 : dx === -1 ? g.x0 : g.x0 + s;
          const z = dz === 1 ? g.z0 + 500 : dz === -1 ? g.z0 : g.z0 + s;
          const near = groundHeight(world, x - dx * 0.01, z - dz * 0.01);
          if (near <= 0.1) continue;
          // Across the border by 1 m: what the far layer draws there.
          const fy = terrain.top(x + dx * 1, z + dz * 1);
          if (fy === null) {
            if (outer) uncovered++;
            continue;
          }
          const diff = fy - near;
          d.push(Math.abs(diff));
          if (diff > 1) farAboveM += 5;
          if (Math.abs(diff) > worst.d) worst = { d: r2(Math.abs(diff)), at: ll(x, z) };
        }
      }
    }
    m.metric({ id: "N.far.ringStepP99M", target: 1, better: "lower", unit: "m", defects: ["W-17"], desc: "99th percentile of |near ground - far terrain| across every built tile's border, every 5 m (the step at the streaming ring)" }, r2(percentile(d, 99)), { samples: d.length });
    m.metric({ id: "N.far.ringStepMaxM", target: 2, better: "lower", unit: "m", defects: ["W-17"], desc: "the largest such step" }, r2(maxOf(d, 0)), worst);
    m.metric({ id: "N.far.farAboveNearKm", target: 0, better: "lower", unit: "km", defects: ["W-17"], desc: "border length where the far terrain stands more than 1 m above the near ground (the sea shows through the crack)" }, r2(farAboveM / 1000));
    m.metric({ id: "N.far.outerLandUncovered", target: 0, better: "lower", unit: "samples", defects: ["W-40"], desc: "land samples on the city's outer edge (every 5 m) with no far terrain 1 m beyond them (the city edge floats over the sea)" }, uncovered);
  }
  m.lap("ring");

  // ---- far coverage of the four uncovered tiles, and San Bruno Mountain (W-40)
  {
    let minShare = 1;
    const per: Record<string, number> = {};
    for (const id of UNCOVERED_TILES) {
      const [ix, iz] = id.slice(1).split("_").map(Number) as [number, number];
      let n = 0;
      let hit = 0;
      for (let x = ix * 500 + 25; x < ix * 500 + 500; x += 50) {
        for (let z = iz * 500 + 25; z < iz * 500 + 500; z += 50) {
          n++;
          if (terrain.top(x, z) !== null) hit++;
        }
      }
      per[id] = n ? hit / n : 0;
      minShare = Math.min(minShare, per[id]!);
    }
    m.metric({ id: "N.far.uncoveredTilesMinShare", target: 0.95, better: "higher", unit: "share", defects: ["W-40"], desc: "the lowest far-terrain coverage of t-16_21, t-4_21, t-3_21 and t7_-5 (land beside the built tiles that has no far terrain)" }, r2(minShare), per);
    const sb = toLocal(37.6866, -122.4353);
    let top = 0;
    for (let x = sb.x - 300; x <= sb.x + 300; x += 20) for (let z = sb.z - 300; z <= sb.z + 300; z += 20) top = Math.max(top, terrain.top(x, z) ?? 0);
    m.metric({ id: "N.far.sanBrunoSummitErrorM", target: 10, better: "lower", unit: "m", defects: ["W-40", "W-17"], desc: "San Bruno Mountain's far-terrain summit against its 402 m (the far layer stops short of it)" }, r2(Math.abs(402 - top)));
  }

  // ---- far hulls against the buildings (W-41)
  {
    let tallOff = 0;
    let noHull = 0;
    const low: number[] = [];
    const worst: string[] = [];
    for (const t of gw.tiles) {
      for (const b of t.buildings) {
        const [cx, cz] = centroid(b.footprint);
        const top = hulls.top(cx, cz);
        if (top === null) {
          noHull++;
          continue;
        }
        const d = top - b.topY;
        if (b.topY - b.baseY >= 30) {
          if (Math.abs(d) > 3) {
            tallOff++;
            if (worst.length < 10) worst.push(`${b.id} ${r2(d)} m`);
          }
        } else low.push(Math.abs(d));
      }
    }
    m.metric({ id: "N.far.tallHullsOff3m", target: 0, better: "lower", unit: "records", defects: ["W-41"], desc: "records 30 m or taller whose far hull's roof over their centroid differs from their roof by more than 3 m (the skyline pops when the tile streams in)" }, tallOff, worst);
    m.metric({ id: "N.far.recordsWithoutHull", target: 0, better: "lower", unit: "records", defects: ["W-41"], desc: "records with no far hull or cluster over their centroid" }, noHull);
    m.metric({ id: "N.far.lowHullsP99M", target: 5, better: "lower", unit: "m", defects: ["W-41"], desc: "the 99th percentile of |far hull roof - roof| for records under 30 m" }, r2(percentile(low, 99)));
  }
  return m;
}
