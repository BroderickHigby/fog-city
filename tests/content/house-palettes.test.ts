// House colours by era and district (content/house-palettes.json, house kit K3), world QA W-37:
// "96.7% of footprints are pastel at glazing 0.25; 34 wall colours, saturation at most 0.23; the
// Painted Ladies are drawn as an ordinary row, and two of them share a colour."
// Acceptance (world-qa-report.md W-37, house-kit-spec.md K3): at least 30% of pre-1915 houses
// have saturation 0.3 or more; no two adjacent houses on a block face share a colour; the
// override is applied to all 7 Painted Ladies ids. Checked here on the committed sf world.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  HOUSE_PALETTES, assignHouseColours, checkHousePalettes, colourKey, houseAdjacency, houseOverrideFor, hsvSaturation, paletteRuleFor, scaleHex,
  type HouseColours, type HouseLot, type HousePalettesFile,
} from "../../src/content/housePalettes.ts";
import { contrastRatio } from "../../src/content/billboards.ts";
import { toLocal } from "../../src/geo/project.ts";
import { ROOT } from "../helpers.ts";
import { allRecords, centroid, houseLots, recordsNear, type SfHouseLot, type SfRecord } from "./sf-houses.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const POSTCARD_ROW = HOUSE_PALETTES.overrides.find((o) => o.id === "postcard-row")!;
const rect = (x: number, z: number, w = 7, d = 20): Array<[number, number]> => [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];

describe("content/house-palettes.json", () => {
  it("passes its consistency rules", () => expect(checkHousePalettes()).toEqual([]));

  it("every rule's districts are Analysis Neighborhoods of the sf world", () => {
    const d = JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/districts.json"), "utf8")) as { districts: Array<{ id: string }> };
    const ids = new Set(d.districts.map((x) => x.id));
    for (const r of HOUSE_PALETTES.rules) for (const id of r.districts ?? []) expect(ids.has(id), `${r.id}: ${id}`).toBe(true);
  });

  it("picks the palette by era, then district", () => {
    const rule = (y: number | null, d: string | null) => paletteRuleFor(y, d).id;
    expect(rule(1875, "mission")).toBe("victorian");
    expect(rule(1915, "marina")).toBe("victorian");
    expect(rule(1928, "marina")).toBe("marina-stucco");
    expect(rule(1945, "marina")).toBe("interwar");
    expect(rule(1938, "sunset-parkside")).toBe("avenues");
    expect(rule(1952, "outer-richmond")).toBe("avenues");
    expect(rule(1938, "mission")).toBe("interwar");
    expect(rule(1938, null)).toBe("interwar");
    expect(rule(1968, "sunset-parkside")).toBe("sixties");
    expect(rule(2004, "mission-bay")).toBe("modern");
    expect(rule(null, "marina")).toBe("undated");
  });

  it("Victorian bodies are saturated (0.3 to 0.6) outside the white-and-grey scheme, and every trim contrasts", () => {
    const vic = HOUSE_PALETTES.palettes.victorian!;
    const all = vic.schemes.flatMap((s) => s.bodies);
    const saturated = vic.schemes.filter((s) => s.id !== "muted").flatMap((s) => s.bodies);
    for (const b of saturated) {
      expect(hsvSaturation(b), b).toBeGreaterThanOrEqual(0.3);
      expect(hsvSaturation(b), b).toBeLessThanOrEqual(0.6);
    }
    // Most Victorian bodies are saturated: the white and grey ones carry coloured trim instead.
    expect(saturated.length / all.length).toBeGreaterThan(0.6);
    for (const s of vic.schemes) for (const b of s.bodies) for (const t of s.trims) expect(contrastRatio(b, t), `${b} on ${t}`).toBeGreaterThanOrEqual(1.5);
  });

  it("the later palettes are quieter than the Victorian one, and modern houses get more glass", () => {
    const maxSat = (id: string) => Math.max(...HOUSE_PALETTES.palettes[id]!.schemes.flatMap((s) => s.bodies.map(hsvSaturation)));
    for (const id of ["avenues", "sixties", "modern"]) expect(maxSat(id), id).toBeLessThan(0.3);
    expect(HOUSE_PALETTES.palettes.modern!.glazingDelta).toBeGreaterThan(0);
    expect(HOUSE_PALETTES.palettes.marinaStucco!.roofEdges?.length).toBeGreaterThan(0);
  });

  it("checkHousePalettes rejects a dull Victorian body, a low-contrast trim, a missing palette and neighbours sharing a hand colour", () => {
    const f = clone(HOUSE_PALETTES) as HousePalettesFile;
    f.palettes.victorian!.schemes[0]!.bodies.push("#c9c4bd");
    f.palettes.victorian!.schemes[1]!.trims.push("#e0d090");
    f.rules[0]!.palette = "baroque";
    f.overrides[0]!.records[1]!.body = f.overrides[0]!.records[0]!.body;
    const errs = checkHousePalettes(f).join("\n");
    expect(errs).toContain("saturation");
    expect(errs).toContain("contrast");
    expect(errs).toContain("palette baroque does not exist");
    expect(errs).toContain("share body");
  });
});

describe("assignHouseColours", () => {
  const row = (n: number, year: number): HouseLot[] => Array.from({ length: n }, (_, i) => ({ id: `201006.${String(9000000 + i)}`, footprint: rect(i * 7, 0), year, district: "mission" }));

  it("never gives two touching houses the same body, and keeps a 2 m gap apart", () => {
    const lots = row(40, 1900);
    const c = assignHouseColours(lots);
    for (let i = 1; i < lots.length; i++) expect(c.get(lots[i]!.id)!.body).not.toBe(c.get(lots[i - 1]!.id)!.body);
    const adj = houseAdjacency([{ id: "a", footprint: rect(0, 0) }, { id: "b", footprint: rect(9, 0) }, { id: "c", footprint: rect(7.5, 30) }]);
    expect(adj.get("a")).toEqual([]);
    expect(houseAdjacency([{ id: "a", footprint: rect(0, 0) }, { id: "b", footprint: rect(7.4, 0) }]).get("a")).toEqual(["b"]);
  });

  it("does not depend on the order the lots come in", () => {
    const lots = row(25, 1890);
    const a = assignHouseColours(lots);
    const b = assignHouseColours([...lots].reverse());
    expect([...b].sort()).toEqual([...a].sort());
  });

  it("applies a hand palette and its neighbours avoid it", () => {
    const id = POSTCARD_ROW.records[3]!.id;
    const lots: HouseLot[] = [
      { id, footprint: rect(0, 0), year: 1900, district: "hayes-valley" },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `201006.${String(9100000 + i)}`, footprint: rect((i % 2 === 0 ? -1 : 1) * 7 * (1 + (i >> 1)), 0), year: 1900, district: "hayes-valley" })),
    ];
    const c = assignHouseColours(lots);
    expect(c.get(id)).toMatchObject({ body: POSTCARD_ROW.records[3]!.body, trim: POSTCARD_ROW.records[3]!.trim, override: "postcard-row" });
    for (const l of lots.slice(1)) expect(c.get(l.id)!.body).not.toBe(POSTCARD_ROW.records[3]!.body);
  });

  it("falls back to a shade of the hashed body when every body of the palette is taken next door", () => {
    const f = clone(HOUSE_PALETTES) as HousePalettesFile;
    f.palettes.tiny = { label: "tiny", glazingDelta: 0, schemes: [{ id: "x", bodies: ["#a04040", "#40a040", "#4040a0"], trims: ["#f8f5ee"] }] };
    f.rules = [{ id: "all", palette: "tiny" }];
    f.overrides = [];
    // A courtyard: one house touched by eight around it.
    const lots: HouseLot[] = [{ id: "201006.0000100", footprint: rect(0, 0, 10, 10) }];
    let k = 101;
    for (const [dx, dz] of [[-10, -10], [0, -10], [10, -10], [-10, 0], [10, 0], [-10, 10], [0, 10], [10, 10]] as const) lots.push({ id: `201006.0000${k++}`, footprint: rect(dx, dz, 10, 10) });
    const c = assignHouseColours(lots, f);
    const adj = houseAdjacency(lots);
    for (const [id, ns] of adj) for (const n of ns) expect(c.get(id)!.body, `${id} ${n}`).not.toBe(c.get(n)!.body);
    // A 3 x 3 block where corners touch needs four colours: some house wears a shade.
    const base = ["#a04040", "#40a040", "#4040a0"];
    const shadeSet = base.flatMap((b) => [0.93, 1.07, 0.86, 1.14, 0.8, 0.74, 0.68, 0.62].map((k2) => scaleHex(b, k2)));
    const shades = [...c.values()].map((x) => x.body).filter((b) => !base.includes(b));
    expect(shades.length).toBeGreaterThan(0);
    for (const s of shades) expect(shadeSet).toContain(s);
  });

  it("towers and terrace pieces wear their podium's colours", () => {
    expect(colourKey({ id: "201006.0001265-tower", meta: { towerOf: "201006.0001265" } })).toBe("201006.0001265");
    expect(colourKey({ id: "201006.0001291-s2", meta: { pieceOf: "201006.0001291" } })).toBe("201006.0001291");
    expect(colourKey({ id: "201006.0001291" })).toBe("201006.0001291");
  });
});

describe("the Painted Ladies on the committed sf world", () => {
  // An independent locate: the road graph's Steiner St nodes at Hayes St and Grove St, then the
  // records whose street wall stands within 12 m of the centreline on the east side, Alamo
  // Square's side facing them. The seven built by 1900 in a row are the override's seven.
  let row: SfRecord[];
  beforeAll(() => {
    const roads = JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/roads.json"), "utf8")) as { nodes: Array<{ id: string; x: number; z: number }>; edges: Array<{ a: string; b: string; name?: string }> };
    const ends = (name: string) => new Set(roads.edges.filter((e) => e.name === name).flatMap((e) => [e.a, e.b]));
    const steiner = ends("Steiner St");
    const node = (name: string) => roads.nodes.find((n) => steiner.has(n.id) && ends(name).has(n.id))!;
    const g = node("Grove St");
    const h = node("Hayes St");
    const len = Math.hypot(h.x - g.x, h.z - g.z);
    const ux = (h.x - g.x) / len;
    const uz = (h.z - g.z) / len;
    let nx = -uz;
    let nz = ux;
    if (nx < 0) [nx, nz] = [-nx, -nz];
    const front = recordsNear(37.7762, -122.4327).filter((r) => {
      const [cx, cz] = centroid(r.footprint);
      const s = (cx - g.x) * ux + (cz - g.z) * uz;
      const wall = Math.min(...r.footprint.map(([x, z]) => (x - g.x) * nx + (z - g.z) * nz));
      return s > 0 && s < len && wall > 0 && wall < 12;
    });
    row = front.filter((r) => (r.meta?.year ?? 9999) <= 1900).sort((a, b) => centroid(a.footprint)[1] - centroid(b.footprint)[1]);
  });

  it("the override lists exactly the seven houses fronting the east side of Steiner between Grove and Hayes, built by 1900, north to south", () => {
    expect(row.map((r) => r.id)).toEqual(POSTCARD_ROW.records.map((r) => r.id));
    expect(row.map((r) => r.meta?.parcel)).toEqual(POSTCARD_ROW.records.map((r) => r.parcel));
    expect(POSTCARD_ROW.records.map((r) => r.parcel)).toEqual(["0803023", "0803022", "0803021", "0803020", "0803019", "0803018", "0803017"]);
    for (const r of row) expect(r.meta?.use ?? "", r.id).toMatch(/Residential/);
  });

  it("the two other candidates the houses audit listed stand back from the street", () => {
    const ids = new Set(row.map((r) => r.id));
    expect(ids.has("201006.0088534")).toBe(false);
    expect(ids.has("201006.0072707")).toBe(false);
  });
});

describe("house colours across the committed sf world", () => {
  let lots: SfHouseLot[];
  let adj: Map<string, string[]>;
  let colours: Map<string, HouseColours>;
  beforeAll(() => {
    lots = houseLots(allRecords());
    adj = houseAdjacency(lots);
    colours = assignHouseColours(lots, HOUSE_PALETTES, adj);
  });

  it("colours every house the pipeline draws in its house class", () => {
    expect(lots.length).toBeGreaterThan(160_000);
    expect(colours.size).toBe(lots.length);
  });

  it("at least 30% of pre-1915 houses have saturation 0.3 or more (baseline 0 of 46,283)", () => {
    const pre = lots.filter((l) => l.year !== null && l.year !== undefined && l.year <= 1915 && l.use.includes("residential"));
    const saturated = pre.filter((l) => hsvSaturation(colours.get(l.id)!.body) >= 0.3).length;
    expect(pre.length).toBeGreaterThan(40_000);
    expect(saturated / pre.length).toBeGreaterThanOrEqual(0.3);
    // The palette is built for about 72% (white and grey Victorians carry coloured trim).
    expect(saturated / pre.length).toBeGreaterThan(0.6);
  });

  it("no two touching houses share a body colour, citywide", () => {
    let pairs = 0;
    const same: string[] = [];
    for (const [id, ns] of adj) {
      for (const n of ns) {
        if (n <= id) continue;
        pairs++;
        if (colours.get(id)!.body === colours.get(n)!.body) same.push(`${id} ${n}`);
      }
    }
    expect(pairs).toBeGreaterThan(100_000);
    expect(same).toEqual([]);
  });

  it("an independent brute-force neighbour search in five sample blocks agrees, and finds no shared colour", () => {
    // Vertex-to-wall distances both ways (no grid, no crossing test): every pair it finds within
    // 0.6 m must be in houseAdjacency, and must wear different bodies.
    const boxes: Array<[string, number, number]> = [
      ["Sunset, 30th Ave", 37.75865, -122.48885], ["Mission, Liberty St", 37.75733, -122.42275], ["Marina, Avila St", 37.8016, -122.4405],
      ["Russian Hill, Filbert St", 37.80027, -122.41817], ["Steiner St, 700 block", 37.7762, -122.4327],
    ];
    const byId = new Map(lots.map((l) => [l.id, l]));
    const wallDist = (px: number, pz: number, ring: ReadonlyArray<readonly [number, number]>): number => {
      let best = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i]!;
        const [bx, bz] = ring[(i + 1) % ring.length]!;
        const l2 = (bx - ax) ** 2 + (bz - az) ** 2;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (pz - az) * (bz - az)) / l2)) : 0;
        best = Math.min(best, Math.hypot(ax + t * (bx - ax) - px, az + t * (bz - az) - pz));
      }
      return best;
    };
    let found = 0;
    for (const [name, lat, lon] of boxes) {
      const { x, z } = toLocal(lat, lon);
      const near = recordsNear(lat, lon).filter((r) => byId.has(r.id)).filter((r) => {
        const [cx, cz] = centroid(r.footprint);
        return Math.abs(cx - x) < 120 && Math.abs(cz - z) < 120;
      });
      expect(near.length, name).toBeGreaterThan(20);
      for (let i = 0; i < near.length; i++) {
        for (let j = i + 1; j < near.length; j++) {
          const a = near[i]!.footprint;
          const b = near[j]!.footprint;
          const gap = Math.min(...a.map(([px, pz]) => wallDist(px, pz, b)), ...b.map(([px, pz]) => wallDist(px, pz, a)));
          if (gap > 0.6) continue;
          found++;
          const [p, q] = [near[i]!.id, near[j]!.id];
          expect(adj.get(p), `${name}: ${p} ${q}`).toContain(q);
          expect(colours.get(p)!.body, `${name}: ${p} ${q}`).not.toBe(colours.get(q)!.body);
        }
      }
    }
    expect(found).toBeGreaterThan(200);
  });

  it("the Painted Ladies override is applied to all 7 ids", () => {
    for (const r of POSTCARD_ROW.records) {
      expect(colours.get(r.id), r.id).toMatchObject({ body: r.body, trim: r.trim, accent: r.accent, override: "postcard-row" });
      expect(houseOverrideFor(r.id)?.record).toEqual(r);
    }
  });

  it("every era rule colours houses somewhere, and the Marina's interwar stucco has its red tile edge", () => {
    const byRule = new Map<string, number>();
    for (const c of colours.values()) byRule.set(c.rule, (byRule.get(c.rule) ?? 0) + 1);
    for (const r of HOUSE_PALETTES.rules) expect(byRule.get(r.id) ?? 0, r.id).toBeGreaterThan(500);
    for (const l of lots) {
      const c = colours.get(l.id)!;
      if (c.rule === "marina-stucco") expect(HOUSE_PALETTES.palettes.marinaStucco!.roofEdges).toContain(c.roofEdge);
      else expect(c.roofEdge).toBeNull();
    }
  });

  it("the city has far more than 34 wall colours, and no palette dominates", () => {
    const bodies = new Set([...colours.values()].map((c) => c.body));
    expect(bodies.size).toBeGreaterThan(60);
    const counts = new Map<string, number>();
    for (const c of colours.values()) counts.set(c.body, (counts.get(c.body) ?? 0) + 1);
    expect(Math.max(...counts.values()) / colours.size).toBeLessThan(0.05);
  });
});
