// Gate suite H: the San Francisco house kit (docs/qa/house-kit-spec.md; W-35 to W-38, W-46 to
// W-50), measured on what the GLBs draw (_FACADE, COLOR_0, roof vertices, anchor lists) and on
// the collider records. Where the kit adds new data (per-wall classes in _FACADE.w, anchor lists
// for bays, stoops and garages), the gate reads the encoding house-kit-spec.md gives:
//   _FACADE.w per wall vertex: 0 rear, 85 party, 170 front, 255 roof;
//   anchor lists as node extras arrays named "bays", "stoops", "garages", "storefronts".

import { RoadSurface, trafficEdges } from "../../../pipeline/lib/road-surface.ts";
import type { RoadEdge as PipelineRoadEdge } from "../../../pipeline/lib/roads.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { groundHeight, nearbyBuildings, pointInPolygon } from "../../../src/sim/index.ts";
import { readJson } from "../../helpers.ts";
import { colliderRecords, distToSegment, districtOf, r3, readGlb, type GameWorld, type SfRecord } from "../world.ts";
import { Measured } from "./measured.ts";

/** The houses audit's four sample boxes (x0, z0, x1, z1), local metres. */
export const CRACK_BOXES: Readonly<Record<string, [number, number, number, number]>> = {
  "sunset-30th": [-8700, 3800, -8100, 4400],
  "mission-liberty": [-2850, 4000, -2300, 4500],
  marina: [-4300, -1100, -3800, -600],
  "russian-hill": [-2450, -750, -1950, -300],
};

const toSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function polyDistance(a: ReadonlyArray<readonly [number, number]>, b: ReadonlyArray<readonly [number, number]>): number {
  let d = Infinity;
  for (const [x, z] of a) for (let i = 0, j = b.length - 1; i < b.length; j = i++) d = Math.min(d, distToSegment(x, z, b[j]![0], b[j]![1], b[i]![0], b[i]![1]));
  for (const [x, z] of b) for (let i = 0, j = a.length - 1; i < a.length; j = i++) d = Math.min(d, distToSegment(x, z, a[j]![0], a[j]![1], a[i]![0], a[i]![1]));
  return d;
}

const isResidential = (r: SfRecord): boolean => !r.id.endsWith("-tower") && /residential/i.test(r.meta.use ?? "");

/** Street-facing records: a wall sample (1 m) within 4 m of a traffic ribbon; the ground at that sample. */
function streetFacing(gw: GameWorld, recs: readonly SfRecord[]): Map<string, number> {
  const surf = new RoadSurface(trafficEdges(gw.roads.edges as unknown as PipelineRoadEdge[]), 6);
  const out = new Map<string, number>();
  for (const r of recs) {
    if (r.id.endsWith("-tower")) continue;
    const P = r.footprint;
    let best = Infinity;
    let bx = 0;
    let bz = 0;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [ax, az] = P[j]!;
      const [cx, cz] = P[i]!;
      const n = Math.max(1, Math.ceil(Math.hypot(cx - ax, cz - az)));
      for (let s = 0; s <= n; s++) {
        const x = ax + ((cx - ax) * s) / n;
        const z = az + ((cz - az) * s) / n;
        const c = surf.clearance(x, z);
        if (c < best) {
          best = c;
          bx = x;
          bz = z;
        }
      }
    }
    if (best <= 4) out.set(r.id, groundHeight(gw.world, bx, bz));
  }
  return out;
}

export async function measureHouses(gw: GameWorld): Promise<Measured> {
  const m = new Measured("houses", "pr");
  const recs = colliderRecords(gw);
  const byId = new Map(recs.map((r) => [r.id, r]));
  const facing = streetFacing(gw, recs);
  m.lap("facing");

  // ---- cracks between row houses (W-36), in the four sample boxes
  {
    let cracks = 0;
    const per: Record<string, number> = {};
    for (const [name, [x0, z0, x1, z1]] of Object.entries(CRACK_BOXES)) {
      let n = 0;
      const seen = new Set<string>();
      for (const a of recs) {
        if (!isResidential(a)) continue;
        const [ax, az] = a.footprint[0]!;
        if (ax < x0 || ax > x1 || az < z0 || az > z1) continue;
        for (const b of nearbyBuildings(gw.world, ax, az, 40)) {
          const rb = byId.get(b.id);
          if (!rb || rb.id === a.id || !isResidential(rb)) continue;
          const key = a.id < rb.id ? `${a.id}|${rb.id}` : `${rb.id}|${a.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (a.footprint.some(([x, z]) => pointInPolygon(x, z, rb.footprint)) || rb.footprint.some(([x, z]) => pointInPolygon(x, z, a.footprint))) continue;
          const d = polyDistance(a.footprint, rb.footprint);
          if (d > 0.05 && d < 0.6) n++;
        }
      }
      per[name] = n;
      cracks += n;
    }
    m.metric({ id: "H.cracks.sampleBoxPairs", target: 0, better: "lower", unit: "pairs", defects: ["W-36"], desc: "row-house pairs 5 to 60 cm apart (cracks opened by simplification) in the Sunset, Mission, Marina and Russian Hill sample boxes" }, cracks, per);
  }
  m.lap("cracks");

  // ---- the drawn houses: palette, roofs, wall classes, shop bands, anchors
  {
    let pre1915 = 0;
    let saturated = 0;
    let sfr = 0;
    let shaped = 0;
    let res = 0;
    let fronted = 0;
    const glazing = new Map<string, number>();
    const anchors = { bays: 0, garages: 0, stoops: 0, storefronts: 0 };
    for (const t of gw.manifest.tiles) {
      if (!t.glb) continue;
      const g = await readGlb(`public/tiles/${gw.name}/${t.glb}`, undefined, ["POSITION", "COLOR_0", "_FACADE"]);
      for (const n of g.nodes) {
        for (const [k, v] of Object.entries(n.extras ?? {})) {
          const key = (Object.keys(anchors) as Array<keyof typeof anchors>).find((a) => k.toLowerCase() === a);
          if (key && Array.isArray(v)) anchors[key] += v.length;
        }
      }
      const bn = g.nodes.find((n) => n.name === "buildings");
      const fac = bn?.attributes._FACADE;
      if (!bn || !fac || !bn.colors) continue;
      for (const [id, first, count] of (bn.extras?.buildings ?? []) as Array<[string, number, number]>) {
        const r = byId.get(id);
        if (!r) continue;
        let roofMin = Infinity;
        let roofMax = -Infinity;
        let front = false;
        let wallColour = -1;
        for (let q = first; q < first + count; q++) {
          const v = bn.indices[q]!;
          const w = fac.data[v * fac.size + 3]!;
          if (w > 0.98) {
            const y = bn.positions[v * 3 + 1]!;
            roofMin = Math.min(roofMin, y);
            roofMax = Math.max(roofMax, y);
          } else {
            if (Math.abs(w - 170 / 255) < 0.02) front = true;
            if (wallColour < 0) wallColour = v;
          }
        }
        glazing.set(id, fac.data[bn.indices[first]! * fac.size + 1]!);
        if (!isResidential(r)) continue;
        res++;
        if (front) fronted++;
        if (r.meta.use === "Single Family Residential") {
          sfr++;
          if (roofMax - roofMin > 0.5) shaped++;
        }
        if ((r.meta.year ?? 9999) <= 1915 && wallColour >= 0) {
          pre1915++;
          const R = toSrgb(bn.colors[wallColour * 4]!);
          const G = toSrgb(bn.colors[wallColour * 4 + 1]!);
          const B = toSrgb(bn.colors[wallColour * 4 + 2]!);
          const max = Math.max(R, G, B);
          if (max > 0 && (max - Math.min(R, G, B)) / max >= 0.3) saturated++;
        }
      }
    }
    m.metric({ id: "H.palette.pre1915SaturatedShare", target: 0.3, better: "higher", unit: "share", defects: ["W-37"], desc: "share of pre-1915 houses drawn with a wall colour of saturation 0.3 or more (Victorian and Edwardian colours, not one pastel class)" }, r3(pre1915 ? saturated / pre1915 : 0), { pre1915 });
    m.metric({ id: "H.roofs.shapedShare", target: 0.8, better: "higher", unit: "share", defects: ["W-38"], desc: "share of single-family houses whose drawn roof is not one flat slab (roof vertices span more than 0.5 m: gables, hips, parapets)" }, r3(sfr ? shaped / sfr : 0), { houses: sfr });
    m.metric({ id: "H.walls.frontClassedShare", target: 0.9, better: "higher", unit: "share", defects: ["W-46"], desc: "share of residential records with a wall drawn as the street front (_FACADE.w = 170), so fronts, party walls and rear walls differ" }, r3(res ? fronted / res : 0), { residential: res });
    // Storefront anchors whose building is drawn with a shop band (glazing 0.35 or more).
    const sf = readJson<{ storefronts: Array<{ buildingId: string; x: number; z: number }> }>(`public/tiles/${gw.name}/storefronts.json`).storefronts;
    const banded = sf.filter((s) => (glazing.get(s.buildingId) ?? 0) >= 0.35 - 1e-6).length;
    m.metric({ id: "H.storefronts.shopBandShare", target: 0.95, better: "higher", unit: "share of anchors", defects: ["W-47"], desc: "share of the storefront anchors (storefronts.json) whose wall is drawn with shop glazing" }, r3(sf.length ? banded / sf.length : 0), { anchors: sf.length, banded });
    // Garage doors (K4) and bay windows (K6): anchors against their candidates.
    const rowDistricts = /^(Sunset\/Parkside|West of Twin Peaks|Outer Richmond|Excelsior|Marina)$/;
    let garageCandidates = 0;
    let bayCandidates = 0;
    for (const r of recs) {
      if (!isResidential(r) || !facing.has(r.id)) continue;
      const year = r.meta.year ?? 0;
      if (year >= 1920 && year <= 1960) {
        const [cx, cz] = r.footprint[0]!;
        if (rowDistricts.test(districtOf(gw, cx, cz))) garageCandidates++;
      }
      if (year > 0 && year <= 1925) bayCandidates++;
    }
    m.metric({ id: "H.garages.anchorShare", target: 0.9, better: "higher", unit: "share of candidates", defects: ["W-48"], desc: "garage-door anchors drawn (GLB extras \"garages\") against the street-facing 1920-1960 houses of the Sunset, West of Twin Peaks, Outer Richmond, Excelsior and Marina rows" }, r3(Math.min(1, anchors.garages / Math.max(1, garageCandidates))), { candidates: garageCandidates, anchors: anchors.garages });
    m.metric({ id: "H.bays.anchorShare", target: 0.9, better: "higher", unit: "share of candidates", defects: ["W-49"], desc: "bay-window anchors drawn (GLB extras \"bays\") against the street-facing houses from 1925 or earlier" }, r3(Math.min(1, anchors.bays / Math.max(1, bayCandidates))), { candidates: bayCandidates, anchors: anchors.bays });
  }
  m.lap("glb");

  // ---- blank plinths (W-50): the first-storey line more than 2.5 m above the street at the front
  {
    let blank = 0;
    for (const r of recs) {
      if (!isResidential(r)) continue;
      const street = facing.get(r.id);
      if (street === undefined) continue;
      const line = typeof r.meta.streetY === "number" ? (r.meta.streetY as number) : r.baseY;
      if (line - street > 2.5) blank++;
    }
    m.metric({ id: "H.stoops.blankBandOver2_5m", target: 0, better: "lower", unit: "houses", defects: ["W-50"], desc: "street-facing houses whose drawn first-storey line stands more than 2.5 m above the street at their front (a blank plinth with no stoop, entry or garage storey)" }, blank);
  }

  // ---- the Embarcadero seawall (W-35): the promenade keeps its height to the water's edge
  {
    const a = toLocal(37.8085, -122.41);
    const b = toLocal(37.779, -122.388);
    const W = gw.world.walls!;
    let samples = 0;
    let ramps = 0;
    for (const w of W.segments) {
      if (w.kind !== "shore") continue;
      for (let s = 0; s < w.len; s += 10) {
        const x = w.ax + w.ux * s;
        const z = w.az + w.uz * s;
        if (x < a.x || x > b.x || z < a.z || z > b.z) continue;
        const inland = groundHeight(gw.world, x + w.nx * 10, z + w.nz * 10);
        if (inland < 2.5) continue;
        samples++;
        if (groundHeight(gw.world, x + w.nx * 1, z + w.nz * 1) < 2) ramps++;
      }
    }
    m.metric({ id: "H.seawall.embarcaderoRampShare", target: 0, better: "lower", unit: "share of shore samples", defects: ["W-35"], desc: "Embarcadero shore samples (every 10 m, Pier 39 to the ballpark) where the promenade, 2.5 m or higher 10 m inland, falls below 2 m within 1 m of the shore line (a ramp into the Bay, no quay face)" }, r3(samples ? ramps / samples : 0), { samples });
  }
  return m;
}
