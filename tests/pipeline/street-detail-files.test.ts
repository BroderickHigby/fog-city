// The committed street-detail files are exactly what pipeline/build-street-detail.ts writes:
// byte-identical to the producer's own serialisation of their content, with the index's counts
// matching the layers. Catches a hand-edited, reformatted or half-regenerated file (release #67
// reformatted street-detail.json and only `--check`, which needs the download cache, noticed).
// No network: the producer itself needs the cached downloads, so this checks the outputs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FURNITURE_FILE, LAYER_LINE_KEYS, MARKINGS_FILE, SIGNS_FILE, TREES_FILE } from "../../pipeline/build-street-detail.ts";
import { jsonLines, jsonPretty } from "../../pipeline/lib/output.ts";
import { STREET_DETAIL_INDEX } from "../../src/render/street-markings.ts";
import { ROOT } from "../helpers.ts";

const DIR = join(ROOT, "public/tiles/sf");
const text = (f: string): string => readFileSync(join(DIR, f), "utf8");
const doc = (f: string): Record<string, unknown> => JSON.parse(text(f)) as Record<string, unknown>;

interface Index {
  snapshotDate: string;
  layers: Record<string, string>;
  counts: Record<string, number>;
}

describe("sf street-detail files", () => {
  const index = doc(STREET_DETAIL_INDEX) as unknown as Index;
  // storefronts.json is the storefront producer's file, listed here only for the renderer.
  const own = Object.entries(index.layers).filter(([name]) => name !== "storefronts");

  it("writes the index as the producer does", () => {
    expect(text(STREET_DETAIL_INDEX)).toBe(jsonPretty(index));
  });

  it("writes every layer as the producer does, from the same snapshot", () => {
    for (const [name, file] of own) {
      const keys = LAYER_LINE_KEYS[file];
      expect(keys, `${name}: ${file} has no LAYER_LINE_KEYS entry`).toBeDefined();
      const layer = doc(file);
      expect(text(file) === jsonLines(layer, keys!), `${file} differs from the producer's serialisation`).toBe(true);
      expect(layer.snapshotDate, file).toBe(index.snapshotDate);
    }
  });

  it("counts what the layers hold", () => {
    const markings = doc(MARKINGS_FILE) as { junctions: Array<{ legs: unknown[][] }> };
    const legs = markings.junctions.flatMap((j) => j.legs);
    const furniture = doc(FURNITURE_FILE) as { signals: unknown[]; stopSigns: unknown[] };
    const signs = doc(SIGNS_FILE) as { corners: unknown[]; curb: unknown[] };
    const trees = doc(TREES_FILE) as { trees: unknown[] };
    expect(index.counts).toMatchObject({
      junctions: markings.junctions.length,
      continentalCrosswalks: legs.filter((l) => l[7] === "c").length,
      standardCrosswalks: legs.filter((l) => l[7] === "s").length,
      stopBars: legs.filter((l) => (l[10] as number) > 0).length,
      signalPoles: furniture.signals.length,
      stopSigns: furniture.stopSigns.length,
      signPosts: signs.corners.length,
      curbSigns: signs.curb.length,
      trees: trees.trees.length,
    });
  });
});
