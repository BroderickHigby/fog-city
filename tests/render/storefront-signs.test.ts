// Storefront signs (src/render/storefront-signs.ts): every storefront category has an icon,
// icons have their own atlas cells, and a cell of shops builds its blades, sign slots, neons and
// barber poles. Names are never drawn (docs/design.md: iconography only). No browser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICONS, StorefrontCell, iconFor, iconUv, type StorefrontRecord } from "../../src/render/storefront-signs.ts";
import { ROOT } from "../helpers.ts";

describe("storefront signs", () => {
  const shops = (JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/storefronts.json"), "utf8")) as { storefronts: StorefrontRecord[] }).storefronts;

  it("gives every sf storefront category a specific icon", () => {
    for (const c of new Set(shops.map((s) => s.category))) expect(iconFor(c), c).not.toBe("box");
  });

  it("puts each icon in its own atlas cell", () => {
    const cells = new Set(ICONS.map((i) => iconUv(i).join(",")));
    expect(cells.size).toBe(ICONS.length);
    for (const i of ICONS) for (const v of iconUv(i)) expect(v >= 0 && v <= 1).toBe(true);
  });

  it("builds a cell's signs, a blank sign slot per shop, neon only for bars and poles only for barbers", () => {
    const sample: StorefrontRecord[] = [
      { id: "a", x: 0, z: 0, heading: 0, category: "bar" },
      { id: "b", x: 10, z: 0, heading: Math.PI / 2, category: "barber" },
      { id: "c", x: 20, z: 0, heading: Math.PI, category: "cafe" },
    ];
    const cell = new StorefrontCell(sample, () => 4);
    expect(cell.signs).toBe(3);
    const byName = new Map(cell.group.children.map((o) => [o.name, o]));
    expect((byName.get("storefront sign slots") as { count: number }).count).toBe(3);
    expect((byName.get("bar neons") as { count: number }).count).toBe(1);
    expect((byName.get("barber poles") as { count: number }).count).toBe(1);
    cell.dispose();
  });
});
