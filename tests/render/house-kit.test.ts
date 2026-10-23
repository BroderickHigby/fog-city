// The San Francisco house kit, render half (docs/qa/house-kit-spec.md; world QA W-15, W-37,
// W-38, W-46 to W-50, L-14): the facade pass (house-kit.ts prepareFacades through
// house-kit-mesh.ts applyHouseKit, as the tile streamer runs it on every glb), the window layout
// the facade shader draws (facadeOpenings, generated into the GLSL from the same tables), the
// palette colours (house-colours.ts) and the kit geometry (house-kit-props.ts), checked on the
// shipped sf tiles.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BufferAttribute } from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { HOUSE_PALETTES, hsvSaturation } from "../../src/content/housePalettes.ts";
import { shopfrontFor } from "../../src/content/storefronts.ts";
import { toLocal } from "../../src/geo/project.ts";
import { FACADE_FRAGMENT } from "../../src/render/facade-shader.ts";
import { parentKey } from "../../src/render/house-colours.ts";
import {
  BF_LANDMARK,
  BF_ROW,
  ENTRY_STOREY_RISE_M,
  facadeOpenings,
  FRONT_BAY,
  FRONT_GARAGE,
  FRONT_STOOP,
  GARAGE_H,
  MAT_BRICK,
  MAT_CLAPBOARD,
  MAT_CURTAIN,
  MAT_SHINGLE,
  MAT_SHIPLAP,
  MAT_STONE,
  MAT_STUCCO,
  WALL_FRONT,
  WALL_PARTY,
  WALL_REAR,
  WALL_ROOF,
  WF_DOOR,
  WF_GARAGE,
  WF_SHOP,
  WF_STOOP,
  type BuildingKit,
  type WallInfo,
} from "../../src/render/house-kit.ts";
import { buildShopfronts, KIT_PROTOS, mergePlacements, parseKitDoc, planHouseKit, type ProtoNode, type StorefrontAnchor } from "../../src/render/house-kit-props.ts";
import { protoNodes } from "../../src/render/house-kit-mesh.ts";
import { HAS_SF, loadGlb, prepareTiles, SF, type PreparedTile } from "./house-kit-fixture.ts";

/** The house kit's triangle budget per tile (house-kit-spec Budget: draw calls +2 per tile, kit drawn within 400 m). */
const KIT_TRIANGLES_PER_TILE = 260_000;

// Liberty St (Mission), 30th Ave (Sunset), Alamo Square (the Painted Ladies), Mission St, downtown.
const MISSION = ["t-6_8", "t-7_8", "t-6_7", "t-5_7", "t-5_8"];
const SUNSET = ["t-17_8", "t-18_8"];
const ALAMO = ["t-7_4"];
const DOWNTOWN = ["t-1_1"];
const ALL = [...MISSION, ...SUNSET, ...ALAMO, ...DOWNTOWN];
// Colour rows across the tile borders of the sample.
const COLOUR = [...new Set(ALL.flatMap((id) => {
  const [, a, b] = /^t(-?\d+)_(-?\d+)$/.exec(id)!;
  const out: string[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(`t${Number(a) + dx}_${Number(b) + dz}`);
  return out;
}))];

let tiles = new Map<string, PreparedTile>();
let colours: Awaited<ReturnType<typeof prepareTiles>>["colours"];
beforeAll(async () => {
  if (!HAS_SF) return;
  ({ tiles, colours } = await prepareTiles(ALL, COLOUR));
}, 300_000);

const kitOf = (t: PreparedTile, w: WallInfo): BuildingKit => t.prep.buildings[w.building]!;

/** A named street's centreline segments near a point (roads.json). */
function street(name: string, near: { x: number; z: number }): (x: number, z: number) => number {
  const roads = JSON.parse(readFileSync(join(SF, "roads.json"), "utf8")) as { edges: Array<{ name?: string; points: Array<[number, number]> }> };
  const segs: Array<[[number, number], [number, number]]> = [];
  for (const e of roads.edges) {
    if (e.name !== name || !e.points.some(([x, z]) => Math.hypot(x - near.x, z - near.z) < 600)) continue;
    for (let i = 1; i < e.points.length; i++) segs.push([e.points[i - 1]!, e.points[i]!]);
  }
  return (x, z) =>
    Math.min(
      ...segs.map(([a, b]) => {
        const ex = b[0] - a[0], ez = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1)));
        return Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
      }),
    );
}

const isHouse = (b: BuildingKit): boolean => b.glazing > 0.2 && b.glazing < 0.3;

describe.skipIf(!HAS_SF)("house kit on the sf tiles", () => {
  it("K1 (W-46): every wall triangle's provoking vertex carries that wall's own frame", () => {
    for (const t of tiles.values()) {
      const idx = t.geometry.index!.array;
      const uv = t.geometry.getAttribute("uv") as BufferAttribute;
      const fac = t.geometry.getAttribute("_facade") as BufferAttribute;
      const wall = t.geometry.getAttribute("_wall") as BufferAttribute;
      const pos = t.geometry.getAttribute("position");
      let walls = 0;
      for (let k = 0; k < idx.length; k += 3) {
        const v = [idx[k]!, idx[k + 1]!, idx[k + 2]!];
        if (Math.round(fac.getW(v[0]!) * 255) === WALL_ROOF) continue;
        if (pos.getY(v[0]!) === pos.getY(v[1]!) && pos.getY(v[1]!) === pos.getY(v[2]!)) continue;
        const us = v.map((i) => uv.getX(i));
        const L = Math.max(...us) - Math.min(...us);
        if (L < 0.01) continue;
        walls++;
        const p = v[2]!; // WebGL 2's provoking vertex
        // It starts the wall (smallest u) and holds the wall's length, to the decimetre.
        expect(uv.getX(p)).toBeCloseTo(Math.min(...us), 4);
        expect(Math.abs(wall.getX(p) / 10 - L), `${t.id} triangle ${k / 3}`).toBeLessThanOrEqual(0.051);
      }
      expect(walls, t.id).toBeGreaterThan(1000);
    }
  });

  it("K1 (W-46): party walls draw no windows; side and rear walls fewer than fronts", () => {
    for (const id of ["t-6_8", "t-17_8", "t-7_4"]) {
      const t = tiles.get(id)!;
      let party = 0, front = 0, frontArea = 0, rear = 0, rearArea = 0;
      for (const w of t.prep.walls) {
        const o = facadeOpenings(w, kitOf(t, w));
        const area = o.windows.reduce((s, r) => s + (r[1] - r[0]) * (r[3] - r[2]), 0);
        if (w.cls === WALL_PARTY) {
          party++;
          expect(o.windows.length, `${id} party wall of ${kitOf(t, w).id}`).toBe(0);
          expect(o.door, "no door on a party wall").toBeNull();
          expect(o.garage, "no garage on a party wall").toBeNull();
        } else if (w.cls === WALL_FRONT) {
          front += o.windows.length;
          frontArea += area;
        } else if (w.cls === WALL_REAR) {
          rear += o.windows.length;
          rearArea += area;
        }
      }
      expect(party, id).toBeGreaterThan(200);
      // Smaller windows on side and rear walls (the shader also leaves about 30% of them out).
      expect(rearArea / rear, id).toBeLessThan(0.8 * (frontArea / front));
    }
    // The shader's party branch: no window, door or garage.
    expect(FACADE_FRAGMENT).toMatch(/bool rowOk = [^;]*!party/);
  });

  it("K9 (L-14): no window splits at a corner or is sliced by the roofline", () => {
    let windows = 0, split = 0, sliced = 0;
    for (const t of tiles.values()) {
      for (const w of t.prep.walls) {
        const b = kitOf(t, w);
        for (const r of facadeOpenings(w, b).windows) {
          windows++;
          if (r[0] < 0.1 || r[1] > w.lengthM - 0.1) split++;
          if (r[3] > b.topM - 0.25) sliced++;
        }
      }
    }
    expect(windows).toBeGreaterThan(20_000);
    expect(split / windows).toBeLessThan(0.05); // baseline 48% of corners
    expect(sliced).toBe(0); // baseline 21,321 rows
  });

  it("K2 (W-15): fronts are drawn on believable storeys from the street", () => {
    let n = 0, tall = 0, rows = 0;
    for (const t of tiles.values()) {
      for (const w of t.prep.walls) {
        const b = kitOf(t, w);
        if (w.cls !== WALL_FRONT || !isHouse(b)) continue;
        n++;
        if (Math.min(8, Math.max(2.6, b.storeyM)) >= 5) tall++;
        // A front of a house of two storeys or more shows windows on at least two rows.
        const o = facadeOpenings(w, b);
        if (b.topM >= 2 * b.storeyM + 1 && w.lengthM >= 4) {
          const ys = new Set(o.windows.map((r) => Math.round(r[2] * 10)));
          if (ys.size >= 2) rows++;
          else rows += o.garage || o.door ? 1 : 0;
        }
      }
    }
    expect(n).toBeGreaterThan(2000);
    expect(tall / n).toBeLessThan(0.02); // baseline 61%
    expect(rows).toBeGreaterThan(n * 0.3);
  });

  it("K4 (W-48): 30th Ave, Kirkham to Lawton: 90% of the houses show a garage door at the sidewalk; none on a party wall", () => {
    const ave = street("30th Ave", toLocal(37.7592, -122.48885));
    const north = toLocal(37.7591, -122.48885).z, south = toLocal(37.7577, -122.48885).z;
    let houses = 0, garages = 0;
    for (const id of SUNSET) {
      const t = tiles.get(id)!;
      const byBuilding = new Map<number, WallInfo[]>();
      for (const w of t.prep.walls) (byBuilding.get(w.building) ?? byBuilding.set(w.building, []).get(w.building)!).push(w);
      t.prep.buildings.forEach((b, bi) => {
        const m = t.buildings.get(b.id);
        if (!m || m.meta.towerOf !== undefined || !(m.meta.use ?? "").toLowerCase().includes("residential")) return;
        const xs = m.footprint.map((p) => p[0]), zs = m.footprint.map((p) => p[1]);
        const x = (Math.min(...xs) + Math.max(...xs)) / 2, z = (Math.min(...zs) + Math.max(...zs)) / 2;
        const d = ave(x, z);
        if (!(d > 8 && d < 32 && z > north && z < south)) return;
        houses++;
        const near = (byBuilding.get(bi) ?? []).filter((w) => w.cls === WALL_FRONT && w.flags & WF_GARAGE && ave((w.ax + w.cx) / 2, (w.az + w.cz) / 2) < 22);
        // One garage door, at sidewalk level (y 0 to GARAGE_H above the street).
        if (near.length === 1 && facadeOpenings(near[0]!, b).garage?.[2] === 0) garages++;
      });
    }
    expect(houses).toBeGreaterThanOrEqual(25);
    expect(garages / houses).toBeGreaterThanOrEqual(0.9);
    for (const t of tiles.values()) for (const w of t.prep.walls) if (w.cls !== WALL_FRONT) expect(w.flags & (WF_GARAGE | WF_DOOR), `${t.id} ${kitOf(t, w).id}`).toBe(0);
    expect(GARAGE_H).toBeGreaterThanOrEqual(2.1);
  });

  it("K7 (W-50): no house front has more than 2.5 m of blank wall at its foot", () => {
    let fronts = 0, blank = 0;
    for (const t of tiles.values()) {
      const byBuilding = new Map<number, WallInfo[]>();
      for (const w of t.prep.walls) if (w.cls === WALL_FRONT && w.lengthM >= 3) (byBuilding.get(w.building) ?? byBuilding.set(w.building, []).get(w.building)!).push(w);
      for (const [bi, ws] of byBuilding) {
        const b = t.prep.buildings[bi]!;
        if (!isHouse(b) || b.topM < 4 || b.flags & BF_LANDMARK) continue;
        fronts++;
        let low = Infinity;
        for (const w of ws) {
          const o = facadeOpenings(w, b);
          for (const r of [...o.windows, ...(o.door ? [o.door] : []), ...(o.garage ? [o.garage] : []), ...(o.shop ? [o.shop] : [])]) low = Math.min(low, r[2]);
          // A stoop climbs from the sidewalk to the raised door (house-kit-props.ts planHouseKit).
          if (w.flags & WF_STOOP && o.door) low = Math.min(low, 0);
        }
        if (low > 2.5) blank++;
      }
    }
    expect(fronts).toBeGreaterThan(1500);
    expect(blank / fronts).toBeLessThan(0.01); // baseline: 12,542 fronts citywide with 3.5 m or more
  });

  it("K3 (W-37): era and district palettes; touching houses never share a body; the Painted Ladies wear their hand colours", () => {
    let old = 0, saturated = 0;
    const body = new Map<string, string>();
    for (const t of tiles.values()) {
      for (const b of t.prep.buildings) {
        if (!isHouse(b) || !b.body) continue;
        body.set(parentKey(b.id), b.body);
        if (b.year !== null && b.year <= 1915 && parentKey(b.id) === b.id) {
          old++;
          if (hsvSaturation(b.body) >= 0.3) saturated++;
        }
      }
    }
    expect(old).toBeGreaterThan(1000);
    expect(saturated / old).toBeGreaterThanOrEqual(0.3); // shipped palette: 0
    // Touching houses (Content's 0.6 m) among the sample's houses.
    let pairs = 0, same = 0;
    for (const [k, c] of body) {
      for (const n of colours.neighbours(k)) {
        const d = body.get(n);
        if (!d || n < k) continue;
        pairs++;
        if (d === c) same++;
      }
    }
    expect(pairs).toBeGreaterThan(2000);
    expect(same).toBe(0);
    // No body is in two palettes, so houses on different palettes never match either.
    const seen = new Map<string, string>();
    for (const [id, p] of Object.entries(HOUSE_PALETTES.palettes)) for (const s of p.schemes) for (const c of s.bodies) {
      expect(seen.get(c), `${c} in ${id} and ${seen.get(c)}`).toBeUndefined();
      seen.set(c, id);
    }
    // The Painted Ladies (700 block of Steiner): every listed record in its hand colours.
    const ladies = HOUSE_PALETTES.overrides.flatMap((o) => o.records);
    expect(ladies.length).toBe(7);
    const drawn = [...tiles.values()].flatMap((t) => t.prep.buildings);
    for (const r of ladies) {
      const b = drawn.find((x) => x.id === r.id);
      expect(b, r.id).toBeDefined();
      expect(b!.body).toBe(r.body);
      expect(b!.trim).toBe(r.trim);
    }
  });

  it("K3: a house's colours do not depend on which tile loaded first (rows are coloured whole)", async () => {
    const ids = ["t-7_4", "t-6_8"];
    const a = (await prepareTiles(ids, COLOUR)).tiles;
    const b = (await prepareTiles([...ids].reverse(), COLOUR)).tiles;
    let n = 0;
    for (const id of ids) {
      const x = a.get(id)!.prep.buildings, y = b.get(id)!.prep.buildings;
      x.forEach((bx, i) => {
        expect(y[i]!.body, bx.id).toBe(bx.body);
        expect(y[i]!.trim, bx.id).toBe(bx.trim);
        n++;
      });
    }
    expect(n).toBeGreaterThan(800);
  }, 120_000);

  it("textured facades: every building gets a material by era and use", () => {
    const by = new Map<number, number>();
    let oldWood = 0, old = 0, rowStucco = 0, rows = 0;
    for (const t of tiles.values()) {
      for (const b of t.prep.buildings) {
        by.set(b.material, (by.get(b.material) ?? 0) + 1);
        if (!isHouse(b) || b.flags & BF_LANDMARK || b.year === null) continue;
        if (b.year <= 1915) {
          old++;
          if (b.material === MAT_CLAPBOARD || b.material === MAT_SHIPLAP || b.material === MAT_SHINGLE) oldWood++;
        } else if (b.year < 1960) {
          rows++;
          if (b.material === MAT_STUCCO) rowStucco++;
        }
        if (b.glazing >= 0.7) expect(b.material).toBe(MAT_CURTAIN);
      }
    }
    // Victorians and Edwardians in painted wood; interwar and postwar rows in stucco.
    expect(oldWood / old).toBe(1);
    expect(rowStucco / rows).toBeGreaterThan(0.85);
    // Every material shows up in the sample (brick and stone downtown and in the Mission).
    for (const m of [MAT_CLAPBOARD, MAT_SHIPLAP, MAT_SHINGLE, MAT_STUCCO, MAT_BRICK, MAT_STONE, MAT_CURTAIN]) expect(by.get(m) ?? 0, `material ${m}`).toBeGreaterThan(0);
    // Procedural: the facade shader samples no texture (0 bytes of texture memory).
    expect(FACADE_FRAGMENT).not.toMatch(/texture2D|texture\(/);
  });
});

describe.skipIf(!HAS_SF)("house kit geometry on the sf tiles (K5-K8)", () => {
  const kit = parseKitDoc(JSON.parse(readFileSync(join(SF, "../../models/house-kit/house-kit.json"), "utf8")))!;
  const lib = new Map<string, Map<string, ProtoNode>>();
  beforeAll(async () => {
    for (const k of KIT_PROTOS) lib.set(k, protoNodes(await loadGlb(new Uint8Array(readFileSync(join(SF, "../../models", kit.prototypes[k]!.file))))));
  }, 60_000);

  it("K6 (W-49): Liberty St's Victorians get their bays; K8 (W-38): every row front gets a cornice or coping, none above the roofline", () => {
    const st = street("Liberty St", toLocal(37.75733, -122.42275));
    const west = toLocal(37.75733, -122.4236).x, east = toLocal(37.75733, -122.4214).x;
    let victorian = 0, withBay = 0;
    for (const id of MISSION) {
      const t = tiles.get(id)!;
      const roofs = new Map([...t.buildings.values()].map((b) => [b.id, b]));
      const { placements, stats } = planHouseKit(kit, t.fronts, t.prep.frontWalls, t.prep.frontDoors, t.prep.buildings, roofs);
      expect(stats.rooflines, id).toBeGreaterThan(0);
      t.fronts.forEach((f, fi) => {
        const b = t.prep.buildings[f.record]!;
        const m = t.buildings.get(b.id);
        if (!m || st(f.x, f.z) >= 14 || f.x < west || f.x > east || (m.meta.year ?? 9999) > 1915 || f.lengthM < 4.5 || f.storeys < 2) return;
        if (!(m.meta.use ?? "").toLowerCase().includes("residential")) return;
        victorian++;
        const mine = placements.filter((p) => p.proto.startsWith("bay-") && Math.hypot(p.matrix[12]! - f.x, p.matrix[14]! - f.z) < f.lengthM / 2 + 1);
        if (mine.length > 0 || (f.flags & FRONT_BAY && (t.prep.frontWalls[fi] ?? 0) >= 3)) withBay++;
      });
      // Mouldings never rise more than 0.1 m above the roofline they are laid on (house-kit.json frames).
      for (const p of placements.filter((q) => q.proto.startsWith("cornice") || q.proto === "parapet-coping")) {
        const one = mergePlacements(lib, [p]);
        let top = -Infinity;
        for (let i = 1; i < one.positions.length; i += 3) top = Math.max(top, one.positions[i]!);
        expect(top, `${p.proto} at ${p.matrix[12]}, ${p.matrix[14]}`).toBeLessThanOrEqual(p.matrix[13]! + 0.1 + 1e-6);
      }
    }
    expect(victorian).toBeGreaterThanOrEqual(12);
    expect(withBay / victorian).toBeGreaterThanOrEqual(0.9); // baseline: none
    // Every row front (a house with party walls) gets a roofline moulding.
    for (const id of [...MISSION, ...SUNSET]) {
      const t = tiles.get(id)!;
      const { placements } = planHouseKit(kit, t.fronts, t.prep.frontWalls, t.prep.frontDoors, t.prep.buildings);
      const rowFronts = t.fronts.filter((f) => {
        const b = t.prep.buildings[f.record]!;
        return b.flags & BF_ROW && !(b.flags & BF_LANDMARK) && isHouse(b) && b.topM > 2.5;
      });
      const mould = placements.filter((p) => p.node === "segment");
      for (const f of rowFronts) expect(mould.some((p) => Math.abs(p.matrix[13]! - (f.streetY + t.prep.buildings[f.record]!.topM)) < 0.01 && Math.hypot(p.matrix[12]! - f.x, p.matrix[14]! - f.z) <= f.lengthM / 2 + 0.01), `${id} front of ${t.prep.buildings[f.record]!.id}`).toBe(true);
    }
  });

  it("K7 (W-50): a stoop up to the door of 90% of the raised pre-1940 houses", () => {
    let raised = 0, stoops = 0;
    for (const t of tiles.values()) {
      const { stats } = planHouseKit(kit, t.fronts, t.prep.frontWalls, t.prep.frontDoors, t.prep.buildings);
      const want = t.fronts.filter((f) => {
        const b = t.prep.buildings[f.record]!;
        return f.flags & FRONT_STOOP && (b.year ?? 9999) < 1940 && f.floorM <= ENTRY_STOREY_RISE_M && f.lengthM >= 2;
      }).length;
      raised += want;
      stoops += Math.min(want, stats.stoops);
    }
    expect(raised).toBeGreaterThan(30);
    expect(stoops / raised).toBeGreaterThanOrEqual(0.9);
  });

  it("K5 (W-47): shop glazing on the wall of 95% of the storefront anchors, and a shopfront for every anchor not on a civic landmark", () => {
    const all = (JSON.parse(readFileSync(join(SF, "storefronts.json"), "utf8")) as { storefronts: StorefrontAnchor[] }).storefronts;
    let n = 0, glazed = 0, plans = 0, civic = 0;
    for (const t of tiles.values()) {
      const mine = all.filter((a) => a.x >= t.bbox[0] && a.x < t.bbox[2] && a.z >= t.bbox[1] && a.z < t.bbox[3] && t.buildings.has(a.buildingId));
      const shops = [];
      for (const a of mine) {
        n++;
        const plan = shopfrontFor(a);
        if (plan) {
          plans++;
          shops.push({ anchor: a, plan });
        } else civic++;
        // The anchor's wall: a front of its building within 1 m.
        let best: WallInfo | null = null, bd = Infinity;
        for (const w of t.prep.walls) {
          if (t.prep.buildings[w.building]!.id !== a.buildingId) continue;
          const ex = w.cx - w.ax, ez = w.cz - w.az;
          const u = Math.max(0, Math.min(1, ((a.x - w.ax) * ex + (a.z - w.az) * ez) / (ex * ex + ez * ez || 1)));
          const d = Math.hypot(a.x - w.ax - ex * u, a.z - w.az - ez * u);
          if (d < bd) {
            bd = d;
            best = w;
          }
        }
        if (best && bd <= 1 && best.flags & WF_SHOP) glazed++;
      }
      const { count } = buildShopfronts(shops);
      expect(count).toBe(shops.length);
    }
    expect(n).toBeGreaterThan(300);
    expect(glazed / n).toBeGreaterThanOrEqual(0.95); // baseline 8.1%
    expect(plans + civic).toBe(n);
  });

  it("budgets: one mesh (one draw call) per tile for the house kit and one for the shopfronts, triangles bounded, 16 bytes per vertex", () => {
    for (const t of tiles.values()) {
      const { placements } = planHouseKit(kit, t.fronts, t.prep.frontWalls, t.prep.frontDoors, t.prep.buildings, new Map([...t.buildings.values()].map((b) => [b.id, b])));
      const merged = mergePlacements(lib, placements);
      expect(merged.indices.length / 3).toBe(merged.triangles);
      expect(merged.triangles, t.id).toBeLessThanOrEqual(KIT_TRIANGLES_PER_TILE);
      // Per-vertex attributes the facade pass adds: _wall (4 x int16) and _kit (4 x uint16).
      const v = t.geometry.getAttribute("position").count;
      expect((t.geometry.getAttribute("_wall").array as Int16Array).byteLength + (t.geometry.getAttribute("_kit").array as Uint16Array).byteLength).toBe(16 * v);
    }
  });
});
