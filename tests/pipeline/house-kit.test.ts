// World QA W-37, W-38, W-46 to W-50 (house kit K1, K4-K8, data half): every wall carries its class
// in _FACADE.w (0 rear or side, 85 party, 170 front, 255 roof), and each tile's buildings node lists
// the front walls the kit is laid on (extras.fronts: pipeline/lib/house.ts FrontRow) with flags for
// bays, stoops, garage doors, shopfronts and roofline mouldings. Checked on the glbs as shipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BufferAttribute, BufferGeometry, Mesh } from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { toLocal } from "../../src/geo/project.ts";
import { facades, FRONT_BAY, FRONT_GARAGE, FRONT_ROOFLINE, FRONT_SHOP, FRONT_STOOP, WALL_FRONT, WALL_PARTY, WALL_REAR } from "../../pipeline/lib/house.ts";
import { interiorPoint, type P2 } from "../../pipeline/lib/geom.ts";
import { ROOT } from "../helpers.ts";
import { loadGlbWithThree, loadSf, type SfBuilding } from "./util.ts";

const { manifest, colliders, storefronts, roads } = loadSf();
const tileIndex = new Map(manifest.tiles.map((t, i) => [t.id, i]));

interface Front {
  b: SfBuilding;
  x: number;
  z: number;
  heading: number;
  lengthM: number;
  streetY: number;
  floorM: number;
  storeys: number;
  storeyM: number;
  flags: number;
}
const fronts = new Map<string, Front[]>();
const classes = new Map<string, Record<number, number>>();

async function load(id: string): Promise<void> {
  const t = manifest.tiles[tileIndex.get(id)!]!;
  const c = colliders[tileIndex.get(id)!]!;
  const scene = await loadGlbWithThree(new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", t.glb))));
  const node = scene.getObjectByName("buildings") as Mesh<BufferGeometry> | undefined;
  if (!node) return;
  const ranges = node.userData.buildings as Array<[string, number, number]>;
  const byId = new Map(c.buildings.map((b) => [b.id, b]));
  const rows = (node.userData.fronts ?? []) as number[][];
  fronts.set(
    id,
    rows.map((r) => ({
      b: byId.get(ranges[r[0]!]![0])!,
      x: t.bbox[0] + r[1]! / 10,
      z: t.bbox[1] + r[2]! / 10,
      heading: r[3]!,
      lengthM: r[4]! / 10,
      streetY: r[5]! / 100,
      floorM: r[6]! / 10,
      storeys: r[7]!,
      storeyM: r[8]! / 100,
      flags: r[9]!,
    })),
  );
  const fac = node.geometry.attributes._facade as BufferAttribute;
  const count: Record<number, number> = {};
  for (let i = 0; i < fac.count; i++) {
    const w = Math.round(fac.getW(i) * 255);
    count[w] = (count[w] ?? 0) + 1;
  }
  classes.set(id, count);
}

// The 30th Ave block (Kirkham to Lawton), Liberty St (Guerrero to Valencia), Mission St (16th to 24th).
const SUNSET = ["t-17_8", "t-18_8"];
const MISSION = ["t-6_8", "t-7_8", "t-6_7", "t-5_7", "t-5_8"];
beforeAll(async () => {
  for (const id of [...new Set([...SUNSET, ...MISSION, "t-7_4", "t-9_-1"])]) if (tileIndex.has(id)) await load(id);
}, 300_000);

const angle = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

/** A named street's centreline near a point (its roads.json edges within 600 m). */
function street(name: string, near: { x: number; z: number }): { dist(x: number, z: number): number; xAt(z: number): number } {
  const segs: Array<[P2, P2]> = [];
  for (const e of roads.edges) {
    if (e.name !== name || !e.points.some(([x, z]) => Math.hypot(x - near.x, z - near.z) < 600)) continue;
    for (let i = 1; i < e.points.length; i++) segs.push([e.points[i - 1]!, e.points[i]!]);
  }
  if (segs.length === 0) throw new Error(`no ${name} near ${near.x}, ${near.z}`);
  const seg = (x: number, z: number, [a, b]: [P2, P2]): { d: number; px: number } => {
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1)));
    return { d: Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t), px: a[0] + ex * t };
  };
  return {
    dist: (x, z) => Math.min(...segs.map((g) => seg(x, z, g).d)),
    xAt: (z) => {
      let best = { d: Infinity, px: 0 };
      for (const g of segs) {
        const r = seg(near.x, z, g);
        const lo = Math.min(g[0][1], g[1][1]), hi = Math.max(g[0][1], g[1][1]);
        if (z >= lo && z <= hi && r.d < best.d) best = r;
      }
      return best.px;
    },
  };
}

describe("house kit data (K1, K4-K8)", () => {
  it("walls carry their class: rows have party walls and fronts, and only 0, 85, 170 and 255 occur", () => {
    for (const id of ["t-17_8", "t-6_8", "t-7_4"]) {
      const c = classes.get(id)!;
      expect(Object.keys(c).map(Number).sort((a, b) => a - b), id).toEqual([0, 85, 170, 255]);
      const walls = c[0]! + c[85]! + c[170]!;
      expect(c[85]! / walls, `${id} party share`).toBeGreaterThan(0.2);
      expect(c[170]! / walls, `${id} front share`).toBeGreaterThan(0.1);
    }
  });

  it("30th Ave, Kirkham to Lawton: every mid-block house's front faces the avenue (95%), with its garage door (90%)", () => {
    // The avenue's own centreline (roads.json), between Kirkham St (its node at about 37.7593) and Lawton St
    // (about 37.7575): a house on the avenue has its interior point 8 to 32 m from it (a Sunset lot
    // is about 37 m deep, behind a 12 m half street).
    const ave = street("30th Ave", toLocal(37.7592, -122.48885));
    // The block between the avenue's Kirkham and Lawton nodes (z about 4016 and 4223), corner lots
    // (which face the cross streets) left out.
    const north = toLocal(37.7591, -122.48885).z, south = toLocal(37.7577, -122.48885).z;
    const houses = colliders
      .filter((c) => SUNSET.includes(c.tileId))
      .flatMap((c) => c.buildings)
      .filter((b) => {
        const [x, z] = interiorPoint(b.footprint as P2[]);
        const d = ave.dist(x, z);
        return b.meta.towerOf === undefined && d > 8 && d < 32 && z > north && z < south && (b.meta.use ?? "").toLowerCase().includes("residential");
      });
    // 28 residential records stand on the block's two faces between those bounds.
    expect(houses.length).toBeGreaterThanOrEqual(25);
    const all = SUNSET.flatMap((id) => fronts.get(id) ?? []);
    let right = 0, garage = 0;
    for (const b of houses) {
      const [x, z] = interiorPoint(b.footprint as P2[]);
      const want = x > ave.xAt(z) ? 270 : 90;
      const mine = all.filter((f) => f.b.id === b.id);
      if (mine.some((f) => angle(f.heading, want) <= 30) && !mine.some((f) => angle(f.heading, want) > 60)) right++;
      if (mine.some((f) => angle(f.heading, want) <= 30 && f.flags & FRONT_GARAGE)) garage++;
    }
    expect(right / houses.length).toBeGreaterThanOrEqual(0.95);
    expect(garage / houses.length).toBeGreaterThanOrEqual(0.9);
  });

  it("Liberty St's Victorians get bays on their fronts (90%), and their flat-roof rows a roofline", () => {
    // Liberty St's centreline (roads.json) between Valencia (about -122.4214) and Guerrero (about
    // -122.4236): a front facing it has its anchor within 14 m of it.
    const st = street("Liberty St", toLocal(37.75733, -122.42275));
    const west = toLocal(37.75733, -122.4236).x, east = toLocal(37.75733, -122.4214).x;
    const rows = MISSION.flatMap((id) => fronts.get(id) ?? []).filter(
      (f) => st.dist(f.x, f.z) < 14 && f.x > west && f.x < east && (f.b.meta.year ?? 9999) <= 1915 && f.lengthM >= 4.5 && f.storeys >= 2 && (f.b.meta.use ?? "").toLowerCase().includes("residential"),
    );
    // 13 such facades stand on the block (others' fronts are split by deep recesses into pieces under 4.5 m).
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows.filter((f) => f.flags & FRONT_BAY).length / rows.length).toBeGreaterThanOrEqual(0.9);
    expect(rows.filter((f) => f.flags & FRONT_ROOFLINE).length).toBeGreaterThan(0);
  });

  it("a stoop exactly where a house's first floor stands 1 m or more over the sidewalk", () => {
    let stoops = 0;
    for (const list of fronts.values()) {
      for (const f of list) {
        const res = (f.b.meta.use ?? "").toLowerCase().includes("residential") || (f.b.meta.use === undefined && f.b.topY - f.b.baseY < 16);
        expect(Boolean(f.flags & FRONT_STOOP), f.b.id).toBe(res && f.floorM >= 1);
        if (f.flags & FRONT_STOOP) stoops++;
        expect(f.storeyM, f.b.id).toBeGreaterThanOrEqual(2.6);
        expect(f.storeys, f.b.id).toBeGreaterThanOrEqual(1);
      }
    }
    expect(stoops).toBeGreaterThan(50);
  });

  it("storefront anchors sit on fronts flagged for shopfronts (90% in the loaded tiles)", () => {
    // A record's fronts are in its own tile's list (the anchor may stand across a tile border).
    const tileOfRecord = new Map<string, string>();
    for (const id of fronts.keys()) for (const b of colliders[tileIndex.get(id)!]!.buildings) tileOfRecord.set(b.id, id);
    let n = 0, on = 0;
    for (const s of storefronts.storefronts) {
      const id = tileOfRecord.get(s.buildingId);
      if (id === undefined) continue;
      n++;
      const list = (fronts.get(id) ?? []).filter((f) => f.b.id === s.buildingId && f.flags & FRONT_SHOP);
      if (list.some((f) => Math.hypot(f.x - s.x, f.z - s.z) <= f.lengthM / 2 + 1)) on++;
    }
    expect(n).toBeGreaterThan(200);
    expect(on / n).toBeGreaterThanOrEqual(0.9);
  });

  it("a facade is a run of front walls facing the same way: a bay's facets and a recessed entry join it, a corner splits", () => {
    // A row house 6 m wide facing north (-z): its front is a 3 m wall, a 45-degree bay (two
    // facets and a 1.6 m face) between x 3 and 6, then party, rear and party walls.
    const ring: P2[] = [[0, 0], [3, 0], [3.5, -0.6], [5.1, -0.6], [6, 0], [6, 20], [0, 20]];
    const W = [WALL_FRONT, WALL_FRONT, WALL_FRONT, WALL_FRONT, WALL_PARTY, WALL_REAR, WALL_PARTY];
    expect(facades(ring, W)).toEqual([[0, 1, 2, 3]]);
    // A corner house: fronts on the north and the east are two facades.
    const corner: P2[] = [[0, 0], [10, 0], [10, 20], [0, 20]];
    expect(facades(corner, [WALL_FRONT, WALL_FRONT, WALL_REAR, WALL_PARTY])).toEqual([[0], [1]]);
    // Runs broken by a party wall stay apart; the run that wraps past the first vertex is one.
    expect(facades(corner, [WALL_FRONT, WALL_PARTY, WALL_FRONT, WALL_REAR])).toEqual([[0], [2]]);
    expect(facades(ring, [WALL_FRONT, WALL_FRONT, WALL_FRONT, WALL_REAR, WALL_PARTY, WALL_REAR, WALL_REAR])).toEqual([[0, 1, 2]]);
    expect(facades(ring, W.map(() => WALL_REAR))).toEqual([]);
    // A Sunset front with a recessed entry (1 m deep, its sides other walls): one facade; a 4 m
    // deep light well is not a recess.
    const recess: P2[] = [[0, 0], [3, 0], [3, 1], [4.5, 1], [4.5, 0], [6, 0], [6, 20], [0, 20]];
    expect(facades(recess, [WALL_FRONT, WALL_REAR, WALL_FRONT, WALL_REAR, WALL_FRONT, WALL_PARTY, WALL_REAR, WALL_PARTY])).toEqual([[0, 2, 4]]);
    const well: P2[] = [[0, 0], [3, 0], [3, 4], [4.5, 4], [4.5, 0], [6, 0], [6, 20], [0, 20]];
    expect(facades(well, [WALL_FRONT, WALL_REAR, WALL_REAR, WALL_REAR, WALL_FRONT, WALL_PARTY, WALL_REAR, WALL_PARTY])).toEqual([[0], [4]]);
  });
});
