// Real street trees (pipeline/lib/street-trees.ts, src/render/street-trees.ts): species
// classes, heights from trunk diameter, and the committed sf output (the Embarcadero's palms,
// Chestnut St's street trees). No network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTrees, treeClass, treeHeight } from "../../pipeline/lib/street-trees.ts";
import { buildPalms, foliagePlacements, type TreeRecord } from "../../src/render/street-trees.ts";
import { toLatLon } from "../../src/geo/project.ts";
import { ROOT } from "../helpers.ts";

describe("tree classes and sizes", () => {
  it("sorts species into broadleaf, conifer and palm, and skips empty sites", () => {
    expect(treeClass("Platanus x hispanica :: Sycamore, London Plane")).toBe("broadleaf");
    expect(treeClass("Phoenix canariensis :: Canary Island Date Palm")).toBe("palm");
    expect(treeClass("Washingtonia robusta :: Mexican Fan Palm")).toBe("palm");
    expect(treeClass("Cupressus macrocarpa :: Monterey Cypress")).toBe("conifer");
    expect(treeClass("Planting site (cut) :: Planting Site (cut)")).toBeNull();
    expect(treeClass(":: To Be Determine")).toBeNull();
  });

  it("grows with trunk diameter, within each class's range", () => {
    expect(treeHeight("broadleaf", 4)).toBeLessThan(treeHeight("broadleaf", 20));
    expect(treeHeight("broadleaf", 200)).toBe(6.5);
    expect(treeHeight("conifer", 100)).toBeLessThanOrEqual(30);
    expect(treeHeight("palm", null)).toBe(8);
  });

  it("places rows in local metres, by tree id, once each", () => {
    const p = toLatLon(100, -50);
    const rows = [
      { treeid: "7", species: "Olea europaea :: Olive Tree", mapdbh: "10", latitude: String(p.lat), longitude: String(p.lon) },
      { treeid: "3", species: "Phoenix canariensis :: Canary Island Date Palm", latitude: String(p.lat), longitude: String(p.lon) },
      { treeid: "7", species: "Olea europaea :: Olive Tree", latitude: String(p.lat), longitude: String(p.lon) },
      { treeid: "9", species: "Planting site (cut) :: Planting Site (cut)", latitude: String(p.lat), longitude: String(p.lon) },
    ];
    const r = buildTrees(rows, () => true);
    expect(r.trees.map((t) => [t[0], t[3]])).toEqual([[3, 2], [7, 0]]);
    expect(r.trees[1]![1]).toBeCloseTo(100, 0);
    expect(r.trees[1]![2]).toBeCloseTo(-50, 0);
    expect(r.skipped).toBe(2);
  });
});

describe("sf street trees", () => {
  const doc = JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/street-trees.json"), "utf8")) as { classes: string[]; trees: TreeRecord[] };
  const near = (x: number, z: number, r: number): TreeRecord[] => doc.trees.filter((t) => Math.hypot(t[1] - x, t[2] - z) < r);

  it("has the city's inventory, with palms along the Embarcadero and street trees on Chestnut St", () => {
    expect(doc.trees.length).toBeGreaterThan(120000);
    expect(doc.classes).toEqual(["broadleaf", "conifer", "palm"]);
    expect(near(0, 0, 400).filter((t) => t[3] === 2).length).toBeGreaterThan(40);
    expect(near(-3750, -590, 150).length).toBeGreaterThan(40);
  });

  it("hands broadleaf and conifer trees to the foliage layer and draws the palms", () => {
    const sample = near(0, 0, 400);
    const placed = foliagePlacements(sample, doc.classes, () => 3);
    expect(placed.length).toBe(sample.filter((t) => t[3] !== 2).length);
    for (const p of placed) {
      expect(p.y).toBe(3);
      expect(p.scale).toBeGreaterThan(0.3);
    }
    const palms = buildPalms(sample, doc.classes, () => 3)!;
    expect(palms.children).toHaveLength(2);
  });
});
