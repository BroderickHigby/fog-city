// Gate suite B: terrain and hills (docs/qa/world-continuity-gate.md, section B), on the collider
// pack's heightfields as the sim reads them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toLocal } from "../../../src/geo/project.ts";
import { groundHeight, type Heightfield } from "../../../src/sim/index.ts";
import { ROOT } from "../../helpers.ts";
import { latticeAt, ll, maxOf, meshGroundHeight, percentile, prng, r2, r3, resample, surfaceAt, tileField, distToSegment, type GameWorld, type P2 } from "../world.ts";
import { Measured } from "./suite.ts";

const FIX = join(ROOT, "tests/helpers/world-gate/fixtures");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), "utf8")) as T;

/** Bilinear height of one heightfield (the sim's heightIn), clamped into its lattice. */
export function bilinearIn(g: Heightfield, x: number, z: number): number {
  const fx = (x - g.x0) / g.cellSizeM;
  const fz = (z - g.z0) / g.cellSizeM;
  const ix = Math.max(0, Math.min(Math.floor(fx), g.nx - 2));
  const iz = Math.max(0, Math.min(Math.floor(fz), g.nz - 2));
  const tx = fx - ix;
  const tz = fz - iz;
  const h = (i: number, k: number): number => g.heights[k * g.nx + i] ?? 0;
  return (h(ix, iz) * (1 - tx) + h(ix + 1, iz) * tx) * (1 - tz) + (h(ix, iz + 1) * (1 - tx) + h(ix + 1, iz + 1) * tx) * tz;
}

/** Heights every 1 m along a path, following the surface (each sample hinted by the last). */
export function surfaceProfile(gw: GameWorld, pts: readonly P2[]): number[] {
  const out: number[] = [];
  let y: number | undefined;
  for (const [x, z] of pts) {
    y = surfaceAt(gw.world, x, z, y);
    out.push(y);
  }
  return out;
}

/** Steepest 10 m grade and the largest grade change across 8 m either side (the QA's "kink"), both in percent. */
export function gradeStats(h: readonly number[]): { steep10: number; kink: number; steepAt: number } {
  let steep10 = 0;
  let steepAt = 0;
  let kink = 0;
  for (let i = 10; i < h.length; i++) {
    const g = Math.abs(h[i]! - h[i - 10]!) / 10;
    if (g > steep10) {
      steep10 = g;
      steepAt = i;
    }
  }
  for (let i = 8; i < h.length - 8; i++) {
    const a = (h[i]! - h[i - 8]!) / 8;
    const b = (h[i + 8]! - h[i]!) / 8;
    kink = Math.max(kink, Math.abs(b - a));
  }
  return { steep10: steep10 * 100, kink: kink * 100, steepAt };
}

/** The famous steep blocks, published steepest grade and tolerance (percent). */
const FAMOUS: ReadonlyArray<{ name: string; street: RegExp; at: [number, number]; pct: number; tol: number }> = [
  { name: "Filbert St, Leavenworth-Hyde", street: /^Filbert St$/, at: [37.80024, -122.41842], pct: 31.5, tol: 1.0 },
  { name: "22nd St, Church-Vicksburg", street: /^22nd St$/, at: [37.75486, -122.42828], pct: 31.5, tol: 1.0 },
  { name: "Jones St, Union-Filbert", street: /^Jones St$/, at: [37.8001, -122.41586], pct: 29, tol: 1.0 },
  { name: "Duboce Ave, Alpine-Divisadero", street: /^Duboce Ave$/, at: [37.76896, -122.43708], pct: 27.9, tol: 2.0 },
  { name: "Fillmore St, Broadway-Vallejo", street: /^Fillmore St$/, at: [37.79505, -122.43535], pct: 24, tol: 1.5 },
];

/** The edge called `street` nearest to a point (within 60 m), resampled at 1 m and clipped to the 80 m either side of it. */
export function blockPath(gw: GameWorld, street: RegExp, lat: number, lon: number): P2[] | null {
  const p = toLocal(lat, lon);
  let best: { pts: P2[]; d: number } | null = null;
  for (const e of gw.roads.edges) {
    if (!street.test(e.name ?? "") || e.pedestrian) continue;
    let d = Infinity;
    for (let i = 1; i < e.points.length; i++) d = Math.min(d, distToSegment(p.x, p.z, e.points[i - 1]![0]!, e.points[i - 1]![1]!, e.points[i]![0]!, e.points[i]![1]!));
    if (d < 60 && (!best || d < best.d)) best = { pts: resample(e.points, 1), d };
  }
  return best ? best.pts.filter(([x, z]) => Math.hypot(x - p.x, z - p.z) <= 80) : null;
}

export function measureTerrain(gw: GameWorld): Measured {
  const m = new Measured("terrain", "pr");
  const world = gw.world;

  // ---- coverage: every built tile has a finite 51 x 51 heightfield and a water mask
  {
    const bad: string[] = [];
    for (const t of gw.tiles) {
      const g = t.ground;
      const ok = g && g.nx === 51 && g.nz === 51 && g.heights.length === 2601 && g.heights.every(Number.isFinite) && g.water?.length === 2601 && g.x0 % 500 === 0 && g.z0 % 500 === 0;
      if (!ok) bad.push(t.tileId);
    }
    m.metric({ id: "B.coverage.badTiles", target: 0, better: "lower", unit: "tiles", defects: [], desc: "built tiles without a finite 51x51 heightfield and water mask on the 500 m grid" }, bad.length, bad);
  }

  // ---- seams: the shared border gives one height from either neighbour's lattice
  {
    let maxStep = 0;
    let samples = 0;
    const fields = new Map(gw.tiles.filter((t) => t.ground).map((t) => [`${t.ground!.x0},${t.ground!.z0}`, t.ground!]));
    for (const g of fields.values()) {
      const east = fields.get(`${g.x0 + 500},${g.z0}`);
      const south = fields.get(`${g.x0},${g.z0 + 500}`);
      for (let s = 0; s <= 500; s += 2.5) {
        if (east) {
          maxStep = Math.max(maxStep, Math.abs(bilinearIn(g, g.x0 + 500, g.z0 + s) - bilinearIn(east, g.x0 + 500, g.z0 + s)));
          samples++;
        }
        if (south) {
          maxStep = Math.max(maxStep, Math.abs(bilinearIn(g, g.x0 + s, g.z0 + 500) - bilinearIn(south, g.x0 + s, g.z0 + 500)));
          samples++;
        }
      }
    }
    m.metric({ id: "B.seams.maxStep", target: 0, better: "lower", unit: "m", defects: [], desc: "largest height difference on a tile border (every 2.5 m) between the two neighbours' lattices" }, r3(maxStep), { samples });
  }

  // ---- sim ground against the drawn ground (W-22)
  {
    const rnd = prng(20261021);
    const tiles = gw.tiles.filter((t) => t.ground);
    const d: number[] = [];
    let worst = { d: 0, at: "" };
    let guard = 0;
    while (d.length < 10_000 && guard++ < 200_000) {
      const t = tiles[Math.floor(rnd() * tiles.length)]!;
      const x = t.ground!.x0 + rnd() * 500;
      const z = t.ground!.z0 + rnd() * 500;
      const g = tileField(world, x, z);
      if (!g) continue;
      const near = latticeAt(world, Math.round(x / 10), Math.round(z / 10));
      if (!near || near.water || near.y <= 0.1) continue;
      const v = Math.abs(groundHeight(world, x, z) - meshGroundHeight(world, x, z));
      d.push(v);
      if (v > worst.d) worst = { d: r3(v), at: ll(x, z) };
    }
    m.metric({ id: "B.groundParity.p99", target: 0.02, better: "lower", unit: "m", defects: ["W-22"], desc: "99th percentile of |sim ground - drawn ground| at 10,000 seeded land points (the drawn ground splits each 10 m cell into two triangles; the sim is bilinear)" }, r3(percentile(d, 99)));
    m.metric({ id: "B.groundParity.max", target: 0.02, better: "lower", unit: "m", defects: ["W-22"], desc: "largest |sim ground - drawn ground| at the same 10,000 points" }, r3(maxOf(d)), worst);
  }

  // ---- summits (pass): the lattice keeps every named summit
  {
    const fails: string[] = [];
    const seenSummits: Record<string, { sim: number; dem: number; published: number }> = {};
    for (const s of fixture<{ summits: Array<{ name: string; at: [number, number]; publishedM: number; demMaxM: number }> }>("summits.json").summits) {
      // The sim's ground maximum within 150 m (2 m samples: the bilinear surface peaks on a lattice vertex of a touched cell).
      const p = toLocal(s.at[0], s.at[1]);
      let top = -Infinity;
      for (let x = p.x - 150; x <= p.x + 150; x += 2) {
        for (let z = p.z - 150; z <= p.z + 150; z += 2) {
          if (Math.hypot(x - p.x, z - p.z) > 150) continue;
          top = Math.max(top, groundHeight(world, x, z));
        }
      }
      if (Math.abs(top - s.demMaxM) > 1) fails.push(`${s.name}: sim ${r2(top)} m, DEM ${s.demMaxM}`);
      seenSummits[s.name] = { sim: r2(top), dem: s.demMaxM, published: s.publishedM };
    }
    m.metric({ id: "B.summits.fails", target: 0, better: "lower", unit: "summits", defects: [], desc: "of 25 named summits, those whose sim ground maximum within 150 m is not within 1 m of the 3DEP DEM maximum (the published heights differ from the DEM by up to 47 m for known reasons and are listed in the details)" }, fails.length, { fails, seen: seenSummits });
  }

  // ---- grades
  {
    const fails: string[] = [];
    const seen: Record<string, number> = {};
    for (const f of FAMOUS) {
      const pts = blockPath(gw, f.street, f.at[0], f.at[1]);
      if (!pts || pts.length < 20) {
        fails.push(`${f.name}: no such street in roads.json`);
        continue;
      }
      const g = gradeStats(surfaceProfile(gw, pts)).steep10;
      seen[f.name] = r2(g);
      if (Math.abs(g - f.pct) > f.tol) fails.push(`${f.name}: ${r2(g)}% against ${f.pct} +/- ${f.tol}`);
    }
    m.metric({ id: "B.grades.famousFails", target: 0, better: "lower", unit: "blocks", defects: [], desc: "famous steep blocks whose steepest 10 m on the drivable surface is outside the published grade's tolerance (Filbert, 22nd, Jones, Duboce, Fillmore)" }, fails.length, { fails, seen });
  }
  {
    const prof = fixture<{ profiles: Record<string, { name: string; dem1m: number[] }> }>("dem1m-profiles.json").profiles;
    const fails: string[] = [];
    const seen: Record<string, unknown> = {};
    for (const id of Object.keys(prof).sort()) {
      const e = gw.edges.get(id);
      if (!e) {
        fails.push(`${id}: not in roads.json`);
        continue;
      }
      const sim = gradeStats(surfaceProfile(gw, resample(e.points, 1)));
      const dem = gradeStats(prof[id]!.dem1m);
      seen[id] = { name: prof[id]!.name, simSteep: r2(sim.steep10), demSteep: r2(dem.steep10), simKink: r2(sim.kink), demKink: r2(dem.kink) };
      if (sim.steep10 > dem.steep10 + 5 || sim.kink > dem.kink + 10) fails.push(id);
    }
    m.metric({ id: "B.grades.hillsideLatticeFails", target: 0, better: "lower", unit: "roads", defects: ["W-31"], desc: "hillside-crossing roads (Vermont c13216002, Twin Peaks Blvd c12770000, Vasquez c13186101, Kensington c7806001) whose steepest 10 m exceeds the 1 m DEM's by more than 5 points or whose grade break exceeds it by more than 10" }, fails.length, seen);
  }

  // ---- inland lakes (W-11): the hydro-flattened surfaces as water at their level
  {
    const lakes = fixture<{ lakes: Array<{ name: string; levelM: number; runs: number[][] }> }>("lakes.json").lakes;
    let minShare = 1;
    let dry = 0;
    const seen: Record<string, number> = {};
    for (const l of lakes) {
      let n = 0;
      let wet = 0;
      for (const [gz, gx0, gx1] of l.runs) {
        for (let gx = gx0!; gx <= gx1!; gx++) {
          n++;
          const L = latticeAt(world, gx, gz!);
          if (L && L.water && Math.abs(L.y - l.levelM) <= 0.5) wet++;
          else dry++;
        }
      }
      const share = n ? wet / n : 1;
      seen[l.name] = r3(share);
      minShare = Math.min(minShare, share);
    }
    m.metric({ id: "B.lakes.minWaterShare", target: 0.9, better: "higher", unit: "share", defects: ["W-11"], desc: "the smallest share, over Lake Merced, Stow, Spreckels, Pine, Elk Glen, Laguna Honda, the Palace lagoon and the Crissy marsh, of the lake's lattice vertices that are water at the lake's level" }, r3(minShare), seen);
    m.metric({ id: "B.lakes.dryHa", target: 0, better: "lower", unit: "ha", defects: ["W-11"], desc: "lake surface (the same eight lakes) that is dry land, hectares (one lattice vertex = 0.01 ha)" }, r2(dry / 100));
  }
  return m;
}
