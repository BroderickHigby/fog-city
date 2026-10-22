// World QA W-37, W-38, W-46 to W-50 (house kit K1, K4-K8, data half): every wall carries its class
// in _FACADE.w (0 rear or side, 85 party, 170 front, 255 roof), and each tile's buildings node lists
// the front walls the kit is laid on (extras.fronts: pipeline/lib/house.ts FrontRow) with flags for
// bays, stoops, garage doors, shopfronts and roofline mouldings. Checked on the glbs as shipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BufferAttribute, BufferGeometry, Mesh } from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { toLocal } from "../../src/geo/project.ts";
import { FRONT_BAY, FRONT_GARAGE, FRONT_ROOFLINE, FRONT_SHOP, FRONT_STOOP } from "../../pipeline/lib/house.ts";
import { interiorPoint, type P2 } from "../../pipeline/lib/geom.ts";
import { ROOT } from "../helpers.ts";
import { loadGlbWithThree, loadSf, type SfBuilding } from "./util.ts";

const { manifest, colliders, storefronts } = loadSf();
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

// The 30th Ave block (Kirkham to Lawton), Liberty St (Guerrero to Valencia), a Mission St block.
const SUNSET = ["t-17_8", "t-18_8"];
const MISSION = ["t-6_8", "t-7_8", "t-6_7"];
beforeAll(async () => {
  for (const id of [...new Set([...SUNSET, ...MISSION, "t-7_4", "t-9_-1"])]) if (tileIndex.has(id)) await load(id);
}, 300_000);

const angle = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

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
    // The avenue runs north-south at about -122.48885; Kirkham St is at about 37.7602 and Lawton St at 37.7583.
    const ave = toLocal(37.7592, -122.48885).x;
    const north = toLocal(37.7599, -122.48885).z, south = toLocal(37.7586, -122.48885).z;
    const houses = colliders
      .filter((c) => SUNSET.includes(c.tileId))
      .flatMap((c) => c.buildings)
      .filter((b) => {
        const [x, z] = interiorPoint(b.footprint as P2[]);
        return b.meta.towerOf === undefined && Math.abs(x - ave) > 8 && Math.abs(x - ave) < 30 && z > north && z < south && (b.meta.use ?? "").toLowerCase().includes("residential");
      });
    expect(houses.length).toBeGreaterThanOrEqual(30);
    const all = SUNSET.flatMap((id) => fronts.get(id) ?? []);
    let right = 0, garage = 0;
    for (const b of houses) {
      const [x] = interiorPoint(b.footprint as P2[]);
      const want = x > ave ? 270 : 90;
      const mine = all.filter((f) => f.b.id === b.id);
      if (mine.some((f) => angle(f.heading, want) <= 30) && !mine.some((f) => angle(f.heading, want) > 60)) right++;
      if (mine.some((f) => angle(f.heading, want) <= 30 && f.flags & FRONT_GARAGE)) garage++;
    }
    expect(right / houses.length).toBeGreaterThanOrEqual(0.95);
    expect(garage / houses.length).toBeGreaterThanOrEqual(0.9);
  });

  it("Liberty St's Victorians get bays on their fronts (90%), and their flat-roof rows a roofline", () => {
    const st = toLocal(37.75733, -122.42275).z;
    const west = toLocal(37.75733, -122.4245).x, east = toLocal(37.75733, -122.4221).x;
    const rows = MISSION.flatMap((id) => fronts.get(id) ?? []).filter(
      (f) => Math.abs(f.z - st) < 12 && f.x > west && f.x < east && (f.b.meta.year ?? 9999) <= 1915 && f.lengthM >= 4.5 && f.storeys >= 2 && (f.b.meta.use ?? "").toLowerCase().includes("residential"),
    );
    expect(rows.length).toBeGreaterThanOrEqual(15);
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
    const loaded = new Set(fronts.keys());
    const tileOf = (x: number, z: number): string => `t${Math.floor(x / 500)}_${Math.floor(z / 500)}`;
    let n = 0, on = 0;
    for (const s of storefronts.storefronts) {
      const id = tileOf(s.x, s.z);
      if (!loaded.has(id)) continue;
      n++;
      const list = (fronts.get(id) ?? []).filter((f) => f.b.id === s.buildingId && f.flags & FRONT_SHOP);
      if (list.some((f) => Math.hypot(f.x - s.x, f.z - s.z) <= f.lengthM / 2 + 1)) on++;
    }
    expect(n).toBeGreaterThan(200);
    expect(on / n).toBeGreaterThanOrEqual(0.9);
  });
});
