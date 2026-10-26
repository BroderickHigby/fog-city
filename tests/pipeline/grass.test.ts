// Lawn provenance, stable identities, untouched holes and byte-identical offline output.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGrassFiles, grassIndex, grassLayer, lawnPieces, readGrassSnapshot, GRASS_ATTRIBUTION, GRASS_FILE, type GrassPiece } from "../../pipeline/build-grass.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const DIR = join(ROOT, "public/tiles/sf");
const SF_BOUNDS = [-11000, -4500, 3500, 10500] as const;
const square = (x: number, z: number, size: number): number[] => [x, z, x + size, z, x + size, z + size, x, z + size];
const piece = (rings: number[][]): GrassPiece => ({ id: "rpd:1:0@0,0", kind: "lawn", rings });

describe("DataSF lawn source", () => {
  const { source, snapshot } = readGrassSnapshot(ROOT);
  const layer = grassLayer(source, snapshot, SF_BOUNDS);

  it("keeps the pinned Lawn-only geometry and every hole; makes IDs unique", () => {
    const original = (source as { grass: GrassPiece[] }).grass;
    expect(original).toHaveLength(2850);
    expect(layer.grass).toHaveLength(2844);
    expect(new Set(layer.grass.map(p => p.id)).size).toBe(2844);
    expect(layer.grass.every(p => p.kind === "lawn" && p.id.startsWith("rpd:"))).toBe(true);
    expect(layer.grass.filter(p => p.rings.length > 1)).toHaveLength(19);
    expect(layer.grass.filter(p => p.sourceId !== undefined)).toHaveLength(73);
    const expected = original.filter(p => p.rings[0]!.some((x, i) => i % 2 === 0 && x >= SF_BOUNDS[0] && x <= SF_BOUNDS[2]));
    expect(new Set(layer.grass.map(p => JSON.stringify(p.rings)))).toEqual(new Set(expected.map(p => JSON.stringify(p.rings))));
    for (const p of layer.grass) {
      const match = /@(-?\d+),(-?\d+)$/.exec(p.id)!;
      const cx = Number(match[1]), cz = Number(match[2]);
      for (const ring of p.rings) for (let i = 0; i < ring.length; i += 2) {
        expect(Number.isFinite(ring[i]) && Number.isFinite(ring[i + 1])).toBe(true);
        expect(ring[i]!).toBeGreaterThanOrEqual(cx * 100 - .02);
        expect(ring[i]!).toBeLessThanOrEqual((cx + 1) * 100 + .02);
        expect(ring[i + 1]!).toBeGreaterThanOrEqual(cz * 100 - .02);
        expect(ring[i + 1]!).toBeLessThanOrEqual((cz + 1) * 100 + .02);
      }
    }
  });

  it("contains the actual near-Ferry, Washington Square and Marina lawn pieces", () => {
    for (const id of ["rpd:211:13@-2,-1", "rpd:11921:1@-15,-6", "rpd:19106:0@-40,-13"]) expect(layer.grass.some(p => p.id === id)).toBe(true);
    expect(snapshot.datasetId).toBe("38b7-6db3");
    expect(snapshot.license).toBe("ODC PDDL 1.0");
    expect(snapshot.snapshotDate).toBe("2026-10-23");
    expect(snapshot.originalResponseNote).toContain("does not refetch");
  });

  it("reproduces committed data and registration without cache or network", () => {
    const files = buildGrassFiles(ROOT, DIR);
    for (const [file, bytes] of Object.entries(files)) expect(bytes).toBe(readFileSync(join(DIR, file), "utf8"));
    const index = JSON.parse(files["street-detail.json"]!) as { layers: Record<string, string>; counts: Record<string, number>; attribution: string[] };
    expect(index.layers.grass).toBe(GRASS_FILE);
    expect(index.counts.grassPieces).toBe(2844);
    expect(index.attribution.filter(s => s === GRASS_ATTRIBUTION)).toHaveLength(1);
    const runtime = files[GRASS_FILE]!;
    expect(runtime).not.toMatch(/street-osm|OpenStreetMap|ODbL|"barriers"|"piers"|"kind":"(?:natural|meadow)"/);
  });

  it("excludes only wholly out-of-world source pieces without clipping the others", () => {
    const provenance = layer.source as { excludedSourceIds: string[]; worldBounds: number[]; sourcePieces: number };
    expect(provenance.worldBounds).toEqual(SF_BOUNDS);
    expect(provenance.sourcePieces).toBe(2850);
    expect(provenance.excludedSourceIds).toEqual([
      "rpd:806432:0@2235,-93", "rpd:806432:0@2235,-94", "rpd:806432:0@2235,-95",
      "rpd:806432:0@2236,-93", "rpd:806432:0@2236,-94", "rpd:806432:0@2236,-95",
    ]);
  });
});

describe("lawn identity and input contract", () => {
  it("retains holes and disambiguates duplicated source IDs independent of input order", () => {
    const a = piece([square(1, 1, 20), square(5, 5, 3)]), b = piece([square(35, 35, 10)]);
    const forward = lawnPieces({ grass: [a, b] }), reverse = lawnPieces({ grass: [b, a] });
    expect(forward).toEqual(reverse);
    expect(new Set(forward.map(p => p.id)).size).toBe(2);
    expect(forward.map(p => p.sourceId)).toEqual([a.id, a.id]);
    expect(new Set(forward.map(p => JSON.stringify(p.rings)))).toEqual(new Set([a, b].map(p => JSON.stringify(p.rings))));
  });

  it("rejects invalid kinds, coordinates, rings and cells", () => {
    const good = piece([square(1, 1, 10)]);
    for (const p of [{ ...good, kind: "natural" }, { ...good, id: "osm:w1" }, { ...good, rings: [[1, 2, 3]] }, { ...good, rings: [[1, 2, 3, 4, 5, Infinity]] }, { ...good, rings: [square(95, 95, 10)] }]) expect(() => lawnPieces({ grass: [p] })).toThrow();
  });

  it("preserves other layers and does not duplicate lawn attribution", () => {
    const input = { world: "sf", attribution: ["existing", GRASS_ATTRIBUTION], layers: { trees: "street-trees.json" }, counts: { trees: 4 } };
    const out = grassIndex(input, 12);
    expect(out).toEqual({ world: "sf", attribution: ["existing", GRASS_ATTRIBUTION], layers: { trees: "street-trees.json", grass: GRASS_FILE }, counts: { trees: 4, grassPieces: 12 } });
    expect(input.counts).toEqual({ trees: 4 });
  });
});
