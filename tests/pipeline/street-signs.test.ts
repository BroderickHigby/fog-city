// Street-name blades, one-way and kerbside signs (pipeline/lib/street-signs.ts) on the
// committed sf output around Chestnut St, plus the text parsers. No network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoadGraph } from "../../pipeline/lib/roads.ts";
import { insideRibbon } from "../../pipeline/lib/street-markings.ts";
import { cornerBearing, sideBearing, type CornerPost, type CurbSign } from "../../pipeline/lib/street-signs.ts";
import { decodeJunction } from "../../src/render/street-markings.ts";
import { bladeGeometry, bladeNames } from "../../src/render/street-signs.ts";
import { ROOT } from "../helpers.ts";

describe("SFMTA sign text", () => {
  it("reads corners and sides as compass bearings", () => {
    expect(cornerBearing("NORTH EAST CORNER, WESTBOUND TRAFFIC")).toBeCloseTo(Math.PI / 4, 9);
    expect(cornerBearing("SOUTH WEST CORNER")).toBeCloseTo((5 * Math.PI) / 4, 9);
    expect(cornerBearing("EAST SIDE")).toBeNull();
    expect(sideBearing("WEST SIDE")).toBeCloseTo((3 * Math.PI) / 2, 9);
    expect(sideBearing("NORTH EAST CORNER")).toBeNull();
  });
});

describe("sf street signs around Chestnut St", () => {
  const dir = join(ROOT, "public/tiles/sf");
  const doc = JSON.parse(readFileSync(join(dir, "street-signs.json"), "utf8")) as { corners: CornerPost[]; curb: CurbSign[] };
  const roads = JSON.parse(readFileSync(join(dir, "roads.json"), "utf8")) as RoadGraph;
  const chestnutEdges = roads.edges.filter((e) => e.name === "Chestnut St");
  const chestnutNodes = new Set(chestnutEdges.flatMap((e) => [e.a, e.b]));
  const near = roads.edges.filter((e) => chestnutNodes.has(e.a) || chestnutNodes.has(e.b));
  const posts = doc.corners.filter((c) => chestnutNodes.has(c.node));
  const markings = JSON.parse(readFileSync(join(dir, "street-markings.json"), "utf8")) as { junctions: unknown[] };
  const junctions = new Map(markings.junctions.map((r) => decodeJunction(r)!).map((j) => [j.id, j.legs]));

  it("signs Chestnut St at its corners with the real names", () => {
    expect(posts.length).toBeGreaterThanOrEqual(15);
    const names = new Set(posts.flatMap((p) => p.blades.map((b) => b.name)));
    for (const n of ["CHESTNUT ST", "FILLMORE ST", "SCOTT ST", "STEINER ST"]) expect(names.has(n), n).toBe(true);
    // Chestnut & Scott: SFMTA lists a blade on every corner.
    expect(posts.filter((p) => p.node === "n26972000" && !p.inferred)).toHaveLength(4);
  });

  it("lays each blade along the street it names", () => {
    let checked = 0;
    for (const p of posts) {
      for (const b of p.blades) {
        const named = new Set(near.filter((x) => x.name.toUpperCase() === b.name).map((x) => x.id));
        const legs = (junctions.get(p.node) ?? []).filter((l) => named.has(l.edge));
        if (!legs.length) continue;
        // Parallel (either way) to one of the legs it names, as the junction paint lays them.
        const align = Math.max(...legs.map((l) => Math.abs(Math.sin(b.heading) * l.ux - Math.cos(b.heading) * l.uz)));
        expect(align, `${p.id} ${b.name}`).toBeGreaterThan(0.95);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("stands every post off the carriageway, on the sidewalk near its corner", () => {
    const curb = doc.curb.filter((s) => near.some((e) => insideRibbon(s.x, s.z, e.points, e.widthM / 2 + 3)));
    expect(curb.length).toBeGreaterThan(30);
    for (const s of [...posts, ...curb]) {
      for (const e of near) expect(insideRibbon(s.x, s.z, e.points, e.widthM / 2), `${s.id} on ${e.id}`).toBe(false);
    }
  });
});

describe("blade meshes", () => {
  const corners = [
    { id: "a", x: 0, z: 0, blades: [{ name: "CHESTNUT ST", heading: Math.PI / 2 }, { name: "SCOTT ST", heading: 0 }], oneWay: [] },
    { id: "b", x: 10, z: 0, blades: [{ name: "CHESTNUT ST", heading: Math.PI / 2 }], oneWay: [] },
  ];

  it("gives each distinct name one atlas row, and each blade two faces", () => {
    expect(bladeNames(corners)).toEqual(["CHESTNUT ST", "SCOTT ST"]);
    const b = bladeGeometry(corners, () => 5);
    expect(b.blades).toBe(3);
    expect(b.geometry.getAttribute("position").count).toBe(3 * 2 * 4);
    const pos = b.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBeGreaterThan(7.5);
    // A blade along heading π/2 (east) spans x, not z.
    const xs = [0, 1, 2, 3].map((i) => pos.getX(i)), zs = [0, 1, 2, 3].map((i) => pos.getZ(i));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.8);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.05);
  });
});
