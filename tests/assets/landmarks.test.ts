// The interim landmarks (docs/qa world gate, section A: W-24, W-25, W-27): Sutro Tower, the
// Golden Gate Bridge and the Bay Bridge's west span, and the hero landmarks' interim shapes.
// Each is checked against the sf world it stands in (public/tiles/sf, read through the same
// tool that wrote assets/blender/data/landmark-sites.json) and against content/landmarks.json,
// which is what the renderer places. No Blender, no network.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSites, fileTileReader, formatSites, fromModelFrame, groundAt, SITES_FILE, toModelFrame, waterAt, type Site, type SitesDoc } from "../../assets/blender/tools/landmark-sites.ts";
import { TILE_SIZE_M, toLocal } from "../../src/geo/project.ts";
import { LIGHT_NIGHT_INTENSITY, isLightMaterial, lightBaseName } from "../../src/render/lights.ts";
import { ROOT, readJson } from "../helpers.ts";
import { clearanceHits, describeHits, type RoadEdge } from "./clearance.ts";
import { allPositions, allTriangles, box, loadModel, node, nodePositions, sceneNodes, sectionAt, subtree, triangleCount, type V3 } from "./glb.ts";

interface Landmark {
  id: string;
  model: string;
  lat: number;
  lon: number;
  headingDeg: number;
  scale?: number;
  replacesBuildingIds?: string[];
}

const LANDMARKS = readJson<{ landmarks: Landmark[] }>("content/landmarks.json").landmarks;
const SITES = readJson<SitesDoc>(SITES_FILE).sites;
const READ = fileTileReader();
const site = (id: string): Site => {
  const s = SITES.find((x) => x.id === id);
  if (!s) throw new Error(`no site ${id}`);
  return s;
};
const entry = (id: string): Landmark => {
  const l = LANDMARKS.find((x) => x.id === id);
  if (!l) throw new Error(`content/landmarks.json has no ${id} entry`);
  return l;
};
const fileOf = (l: Landmark): string => l.model.replace(/^models\//, "");
const scaleOf = (l: Landmark): number => l.scale ?? 1;

/** Interim landmarks: id -> [GLB, triangle budget, root node]. */
const INTERIM: Record<string, [string, number, string]> = {
  "sutro-tower": ["sutro-tower.glb", 12_000, "sutro_tower"],
  "golden-gate-bridge": ["golden-gate-bridge.glb", 30_000, "golden_gate_bridge"],
  "bay-bridge-west": ["bay-bridge-west.glb", 30_000, "bay_bridge_west"],
  "600-montgomery": ["600-montgomery.glb", 4_000, "pyramid_tower"],
  "coit-tower": ["coit-tower.glb", 8_000, "coit_tower"],
  "city-hall": ["city-hall.glb", 16_000, "city_hall"],
  "palace-of-fine-arts": ["palace-of-fine-arts.glb", 12_000, "palace_of_fine_arts"],
  "grace-cathedral": ["grace-cathedral.glb", 12_000, "grace_cathedral"],
  "dragon-gate": ["dragon-gate.glb", 6_000, "dragon_gate"],
  "sutro-baths": ["sutro-baths.glb", 6_000, "sutro_baths"],
  "mission-dolores": ["mission-dolores.glb", 6_000, "mission_dolores"],
  "conservatory-of-flowers": ["conservatory-of-flowers.glb", 8_000, "conservatory"],
};
const IDS = Object.keys(INTERIM);

/** A landmark's model-frame point -> world (x, z), as the renderer places it. */
function toWorld(l: Landmark, mx: number, mz: number): [number, number] {
  return fromModelFrame(toLocal(l.lat, l.lon), l.headingDeg, mx * scaleOf(l), mz * scaleOf(l));
}

const horiz = (p: V3): number => Math.hypot(p[0], p[2]);
const bearingOf = (x: number, z: number): number => ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
const angDiff = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

function pointInRing(x: number, z: number, ring: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

describe("assets/blender/data/landmark-sites.json", () => {
  it("is what the sf world gives today (rerun tools/landmark-sites.ts and rebuild the landmarks when the world moves)", () => {
    const fresh = formatSites(buildSites(READ));
    expect(fresh === readFileSync(join(ROOT, SITES_FILE), "utf8"), `${SITES_FILE} is stale: node assets/blender/tools/landmark-sites.ts`).toBe(true);
  });
});

describe("content/landmarks.json places every interim landmark on its site", () => {
  it.each(IDS)("%s", (id) => {
    const l = entry(id);
    const s = site(id);
    expect(l.model).toBe(`models/${INTERIM[id]![0]}`);
    expect(statSync(join(ROOT, "public", l.model)).size).toBeGreaterThan(1000);
    expect([l.lat, l.lon, l.headingDeg, scaleOf(l)]).toEqual([s.lat, s.lon, s.headingDeg, 1]);
    expect([...(l.replacesBuildingIds ?? [])].sort()).toEqual(s.replacesBuildingIds);
    // ids carry no brand: the pyramid tower is named by its address
    expect(id).not.toMatch(/transamerica|salesforce/i);
  });
});

describe("Sutro Tower (W-25)", () => {
  const l = () => entry("sutro-tower");
  it("stands within 100 m of 37.7552, -122.4528, on the sim's ground", () => {
    const p = toLocal(l().lat, l().lon);
    const want = toLocal(37.7552, -122.4528);
    expect(Math.hypot(p.x - want.x, p.z - want.z)).toBeLessThan(100);
    expect(Math.abs(groundAt(READ, p.x, p.z) - site("sutro-tower").groundY)).toBeLessThan(0.05);
  });

  it("reaches at least 290 m above its ground (published 297.8 m)", async () => {
    const { doc } = await loadModel("sutro-tower.glb");
    const top = box(allPositions(doc)).max[1] * scaleOf(l());
    expect(top).toBeGreaterThanOrEqual(290);
    expect(top).toBeLessThan(300);
  });

  it("is its own far silhouette: lattice above 250 m within 30 m of the tower's point, in a model the landmark layer never culls", async () => {
    const { doc } = await loadModel("sutro-tower.glb");
    const high = nodePositions(node(doc, "tower")).filter((p) => p[1] >= 250);
    expect(high.length).toBeGreaterThan(30);
    const want = toLocal(37.7552, -122.4528);
    for (const p of high) {
      const [x, z] = toWorld(l(), p[0], p[2]);
      expect(Math.hypot(x - want.x, z - want.z)).toBeLessThan(30);
    }
    // one model, no LOD switch: every mesh node is always drawn
    expect(sceneNodes(doc).some((n) => /lod/i.test(n.getName()))).toBe(false);
  });

  it("has three tapering legs on footings that reach below the ground", async () => {
    const { doc } = await loadModel("sutro-tower.glb");
    const legs = nodePositions(node(doc, "tower")).filter((p) => p[1] < 12 && horiz(p) > 20);
    const bearings = new Set(legs.map((p) => Math.round(bearingOf(p[0], p[2]) / 30) * 30 % 360));
    expect([...bearings].sort((a, b) => a - b)).toEqual([30, 150, 270]);
    const at160 = nodePositions(node(doc, "tower")).filter((p) => Math.abs(p[1] - 160) < 8 && horiz(p) < 30);
    expect(Math.max(...at160.map(horiz))).toBeLessThan(15); // the waist
    const base = nodePositions(node(doc, "base"));
    for (const b of [270, 30, 150]) {
      const bx = Math.sin((b * Math.PI) / 180) * 26.4;
      const bz = -Math.cos((b * Math.PI) / 180) * 26.4;
      const [wx, wz] = toWorld(l(), bx, bz);
      const g = groundAt(READ, wx, wz) - site("sutro-tower").groundY;
      const footing = base.filter((p) => Math.hypot(p[0] - bx, p[2] - bz) < 6);
      expect(footing.length, `footing at ${b}`).toBeGreaterThan(4);
      expect(Math.min(...footing.map((p) => p[1]))).toBeLessThan(g - 1);
    }
  });

  it("draws every record it replaces where the sim has it (no invisible walls on the summit)", async () => {
    const { doc } = await loadModel("sutro-tower.glb");
    const base = nodePositions(node(doc, "base"));
    const s = site("sutro-tower");
    expect(s.records.map((r) => r.id).sort()).toEqual(s.replacesBuildingIds);
    for (const r of s.records) {
      for (const [x, z] of r.footprint) {
        const hit = base.some((p) => Math.hypot(p[0] - x, p[2] - z) < 0.05 && Math.abs(p[1] - r.topY) < 0.05);
        expect(hit, `${r.id} corner (${x}, ${z}) at its roof ${r.topY}`).toBe(true);
      }
    }
  });
});

describe("the bridges (W-24)", () => {
  it("both entries exist, at sea level, with towers, a deck and main cables", async () => {
    for (const id of ["golden-gate-bridge", "bay-bridge-west"]) {
      const l = entry(id);
      const p = toLocal(l.lat, l.lon);
      expect(groundAt(READ, p.x, p.z), `${id} origin on the water`).toBe(0);
      const { doc } = await loadModel(fileOf(l));
      for (const n of ["towers", "deck", "cables", "anchorages"]) expect(nodePositions(node(doc, n)).length, `${id} ${n}`).toBeGreaterThan(20);
    }
  });

  it("Golden Gate: two 227 m towers 1,280 m apart, a crowned deck about 70 m up, cables sagging to the deck at mid span", async () => {
    const { doc } = await loadModel("golden-gate-bridge.glb");
    const tw = nodePositions(node(doc, "towers")).filter((p) => p[1] > 200);
    const zs = [...new Set(tw.map((p) => Math.round(p[2] / 100) * 100))].sort((a, b) => a - b);
    expect(zs).toEqual([-1300, 0]);
    expect(Math.max(...tw.map((p) => p[1]))).toBeGreaterThan(225);
    const cab = nodePositions(node(doc, "cables"));
    const mid = cab.filter((p) => Math.abs(p[2] + 640) < 12);
    expect(Math.min(...mid.map((p) => p[1]))).toBeGreaterThan(74);
    expect(Math.min(...mid.map((p) => p[1]))).toBeLessThan(85);
    const deck = nodePositions(node(doc, "deck"));
    const atMid = deck.filter((p) => Math.abs(p[2] + 640) < 15);
    expect(Math.max(...atMid.map((p) => p[1]))).toBeGreaterThan(70);
  });

  it("Golden Gate: the south anchorage meets the end of Hwy 101 north of Fort Point, the approach lands on the toll plaza's ground", async () => {
    const l = entry("golden-gate-bridge");
    const s = site("golden-gate-bridge");
    const { doc } = await loadModel("golden-gate-bridge.glb");
    const an = nodePositions(node(doc, "anchorages")).filter((p) => p[2] > 0);
    const roadEnd = -(s.extra!.roadEndT as number); // model z of the road's end
    expect(Math.abs(Math.min(...an.map((p) => p[2])) - roadEnd)).toBeLessThan(6);
    expect(Math.min(...an.map((p) => p[1]))).toBeLessThan(-3);
    const deck = nodePositions(node(doc, "deck"));
    const southEnd = Math.max(...deck.map((p) => p[2]));
    const top = Math.max(...deck.filter((p) => p[2] > southEnd - 25).map((p) => p[1]));
    const [wx, wz] = toWorld(l, 0, southEnd - 10);
    const g = groundAt(READ, wx, wz);
    expect(top - g).toBeGreaterThan(0);
    expect(top - g).toBeLessThan(8);
  });

  it("Bay Bridge: four 160 m towers and the centre anchorage stand on the piers the DEM marks along the I-80 edge", async () => {
    const s = site("bay-bridge-west");
    const { doc } = await loadModel("bay-bridge-west.glb");
    const tw = nodePositions(node(doc, "towers")).filter((p) => p[1] > 150);
    const stations = [...new Set(tw.map((p) => Math.round(-p[2])))];
    const clusters: number[] = [];
    for (const t of stations.sort((a, b) => a - b)) if (!clusters.some((c) => Math.abs(c - t) < 30)) clusters.push(t);
    expect(clusters).toHaveLength(4);
    const prof = s.profile!;
    const landNear = (t: number, r: number): boolean => {
      for (let i = 0; i < prof.ground.length; i++) {
        const ti = prof.from + i * prof.step;
        if (Math.abs(ti - t) <= r && prof.ground[i]! > 0.3) return true;
      }
      return false;
    };
    // W3, W5, W6 (the first tower west of Rincon Point is not marked in the 10 m DEM)
    expect(clusters.filter((t) => landNear(t, 25))).toHaveLength(3);
    // the centre anchorage rises out of the bay where the DEM marks it
    const centre = nodePositions(node(doc, "anchorages")).filter((p) => p[1] > 60 && Math.abs(-p[2] + 742) < 40);
    expect(centre.length).toBeGreaterThan(4);
    expect(landNear(-742, 25)).toBe(true);
    // the deck runs from Rincon Hill (land) to Yerba Buena Island (land)
    const deck = nodePositions(node(doc, "deck"));
    const tMin = Math.min(...deck.map((p) => -p[2]));
    const tMax = Math.max(...deck.map((p) => -p[2]));
    const groundAtT = (t: number): number => prof.ground[Math.round((t - prof.from) / prof.step)]!;
    expect(groundAtT(tMin + 20)).toBeGreaterThan(0.5);
    expect(groundAtT(tMax - 20)).toBeGreaterThan(0.5);
  });

  it("carry no text, signs or logos (legal review in assets/blender/README.md)", async () => {
    for (const f of ["golden-gate-bridge.glb", "bay-bridge-west.glb"]) {
      const { json } = await loadModel(f);
      const names = [...(json.materials ?? []).map((m) => m.name ?? ""), ...(json.nodes ?? []).map((n) => n.name ?? "")];
      for (const n of names) expect(n, f).not.toMatch(/text|sign|logo|label|letter|lights_art/i);
    }
    const readme = readFileSync(join(ROOT, "assets/blender/README.md"), "utf8");
    expect(readme).toMatch(/pre-release legal\s+checklist/i);
    expect(readme).toMatch(/golden-gate-bridge\.glb/);
  });
});

describe("hero landmarks: interim shapes (W-27)", () => {
  it("Coit Tower is a fluted column within 5% of 64 m", async () => {
    const { doc } = await loadModel("coit-tower.glb");
    const top = box(allPositions(doc)).max[1] * scaleOf(entry("coit-tower"));
    expect(Math.abs(top - 64) / 64).toBeLessThanOrEqual(0.05);
    const shaft = nodePositions(node(doc, "column")).filter((p) => Math.abs(p[1] - 20) < 0.01);
    const radii = shaft.map(horiz);
    const outer = radii.filter((r) => r > Math.max(...radii) - 0.05).length;
    const inner = radii.filter((r) => r < Math.max(...radii) - 0.3).length;
    expect(outer).toBeGreaterThanOrEqual(16);
    expect(inner).toBeGreaterThanOrEqual(16);
  });

  it("the pyramid tower tapers: at 200 m its silhouette is narrower than 40% of its base (seen across the wings), with a spire to 260 m", async () => {
    const { doc } = await loadModel("600-montgomery.glb");
    const tris = allTriangles(doc, "tower");
    const span = (pts: Array<[number, number]>, k: 0 | 1): number => Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k]));
    const base = sectionAt(tris, 7.0);
    const at200 = sectionAt(tris, 200);
    expect(span(base, 0)).toBeGreaterThan(50);
    expect(span(base, 1)).toBeGreaterThan(50);
    expect(span(at200, 1) / span(base, 1)).toBeLessThan(0.4);
    // across the wings (east-west) the elevator and stair wings stand out, as on the real tower
    expect(span(at200, 0) / span(base, 0)).toBeLessThan(0.65);
    expect(box(allPositions(doc)).max[1]).toBeGreaterThan(255);
  });

  it("City Hall and the Palace of Fine Arts carry round domes; Grace Cathedral two front towers and a fleche over the crossing", async () => {
    {
      const { doc } = await loadModel("city-hall.glb");
      const sec = sectionAt(allTriangles(doc, "dome"), 70);
      const r = sec.map(([x, z]) => Math.hypot(x, z));
      expect(Math.min(...r) / Math.max(...r)).toBeGreaterThan(0.9);
      expect(box(nodePositions(node(doc, "dome"))).max[1]).toBeGreaterThan(88);
    }
    {
      const { doc } = await loadModel("palace-of-fine-arts.glb");
      const sec = sectionAt(allTriangles(doc, "rotunda"), 44);
      const r = sec.map(([x, z]) => Math.hypot(x, z));
      expect(Math.min(...r) / Math.max(...r)).toBeGreaterThan(0.9);
      expect(Math.abs(box(allPositions(doc)).max[1] - 49)).toBeLessThan(2);
    }
    {
      const s = site("grace-cathedral");
      const { doc } = await loadModel("grace-cathedral.glb");
      const pts = nodePositions(node(doc, "cathedral"));
      const towers = pts.filter((p) => p[1] > 48 && p[1] < 60);
      const front = Math.min(...s.records[0]!.footprint.map(([, z]) => z));
      expect(towers.every((p) => p[2] < front + 12)).toBe(true);
      expect(new Set(towers.map((p) => Math.sign(p[0] - (s.extra!.crossing as number[])[0]!))).size).toBe(2);
      const [cx, cz] = s.extra!.crossing as number[];
      const fl = pts.filter((p) => p[1] > 65);
      expect(fl.length).toBeGreaterThan(0);
      for (const p of fl) expect(Math.hypot(p[0] - cx!, p[2] - cz!)).toBeLessThan(4);
    }
  });

  it("every hero landmark probe has a model replacing exactly its records (Saints Peter and Paul waits for its probe, L-04)", () => {
    const report = readJson<{ probes: Array<{ id: string; buildings: string[] }> }>("public/tiles/sf/report.json");
    const heroes = ["600-montgomery", "coit-tower", "palace-of-fine-arts", "city-hall", "grace-cathedral", "mission-dolores", "conservatory-of-flowers", "sutro-tower"];
    for (const id of heroes) {
      const probe = report.probes.find((p) => p.id === id)!;
      expect([...(entry(id).replacesBuildingIds ?? [])].sort(), id).toEqual([...probe.buildings].sort());
    }
    for (const id of ["dragon-gate", "sutro-baths", "golden-gate-bridge", "bay-bridge-west"]) expect(entry(id).model, id).toMatch(/\.glb$/);
  });

  it("every replaced record is drawn: extruded on its footprint, or inside another replaced record that is", async () => {
    for (const id of IDS) {
      const s = site(id);
      if (s.records.length === 0) continue;
      const { doc } = await loadModel(INTERIM[id]![0]);
      const pts = allPositions(doc);
      const drawn = s.records.filter((r) => r.footprint.every(([x, z]) => pts.some((p) => Math.hypot(p[0] - x, p[2] - z) < 0.05 && p[1] < r.footY + 0.01)));
      expect(drawn.length, `${id}: no record drawn on its footprint`).toBeGreaterThan(0);
      for (const r of s.records) {
        if (drawn.includes(r)) continue;
        const inside = drawn.some((d) => r.footprint.every(([x, z]) => pointInRing(x, z, d.footprint)));
        expect(inside, `${id}: ${r.id} is neither drawn nor inside a drawn record`).toBe(true);
      }
    }
  });

  it("no interim shape carries an office window grid: untextured stone, concrete, copper and tile", async () => {
    for (const id of IDS) {
      const { doc, json } = await loadModel(INTERIM[id]![0]);
      expect(doc.getRoot().listTextures(), id).toHaveLength(0);
      for (const m of json.materials ?? []) expect(m.name ?? "", id).not.toMatch(/facade|window_grid|glazing|office/i);
    }
  });

  it("the Dragon Gate spans Grant Ave just north of Bush St, portals south, its central portal over the road's centreline", async () => {
    const l = entry("dragon-gate");
    const s = site("dragon-gate");
    const roads = readJson<{ edges: Array<{ id: string; points: Array<[number, number]> }> }>("public/tiles/sf/roads.json");
    const grant = roads.edges.find((e) => e.id === s.extra!.edge)!;
    const o = toLocal(l.lat, l.lon);
    const [a, b] = [grant.points[0]!, grant.points[grant.points.length - 1]!];
    const north = bearingOf(b[0] - a[0], b[1] - a[1]);
    expect(angDiff(l.headingDeg, north + 180)).toBeLessThan(3);
    const local = grant.points.map(([x, z]) => toModelFrame(o, l.headingDeg, x, z));
    expect(Math.min(...local.map(([x]) => Math.abs(x)))).toBeLessThan(3);
    const { doc } = await loadModel("dragon-gate.glb");
    const all = allPositions(doc);
    expect(box(all).size[0]).toBeLessThanOrEqual((s.extra!.spanM as number) + 1.2); // eaves may overhang a little
    // Grant's ribbon runs off-centre between the faces the gate spans: the pillars and the lions
    // stand on the sidewalks either side of it, and nothing of the gate comes lower than 4.5 m
    // over it (the sim has no collider for the gate: a pillar there is a stone the car drives through)
    const cl = s.extra!.centrelineX as number;
    const halfRoad = (s.extra!.roadWidthM as number) / 2;
    const low = all.filter((p) => p[1] > 0.3 && p[1] < 4.5);
    expect(low.filter((p) => p[0] < cl).length).toBeGreaterThan(8);
    expect(low.filter((p) => p[0] > cl).length).toBeGreaterThan(8);
    for (const p of low) expect(Math.abs(p[0] - cl), `(${p[0].toFixed(2)}, ${p[1].toFixed(2)}) is on Grant Ave's ribbon`).toBeGreaterThan(halfRoad);
    const over = all.filter((p) => Math.abs(p[0] - cl) < halfRoad && p[1] > 0.3);
    expect(over.length).toBeGreaterThan(20); // the lintels, pendant posts and roofs span the road
    expect(Math.min(...over.map((p) => p[1]))).toBeGreaterThan(4.5);
  });

  it("the Sutro Baths' pools hold water above the basin floor, walls rooted below it", async () => {
    const l = entry("sutro-baths");
    const s = site("sutro-baths");
    const { doc } = await loadModel("sutro-baths.glb");
    const water = allTriangles(doc).filter((t) => t.every((p) => Math.abs(p[1] - t[0][1]) < 1e-4));
    expect(water.length).toBeGreaterThan(4);
    const pts = allPositions(doc);
    for (const p of pts) {
      const [wx, wz] = toWorld(l, p[0], p[2]);
      const g = groundAt(READ, wx, wz) - s.groundY;
      expect(p[1], `(${p[0].toFixed(1)}, ${p[2].toFixed(1)})`).toBeGreaterThan(g - 2.5);
    }
    expect(box(pts).min[1]).toBeLessThan(0);
  });
});

describe("road clearance: no landmark stands where a car or a walker goes (the sim has no collider for landmark models)", () => {
  // Every roads.json ribbon (pedestrian paths too), from road + 0.3 m to road + 4.5 m, where the
  // road is the sim's ground. Not tested: freeway ribbons over the water (the sea wall closes
  // them, src/sim/boundary.ts) and the piers in the bay (boundary.json's islets, with 15 m of
  // water round them), which nobody can reach. Allowed: a replaced record drawn where the sim
  // has it (its collider stops the car there anyway, as on La Avanzada under Sutro Tower).
  const EDGES = readJson<{ edges: Array<RoadEdge & { gradeSeparated?: boolean }> }>("public/tiles/sf/roads.json").edges;
  const BOUNDARY = readJson<{ shore: Array<{ closed: boolean; points: Array<[number, number]> }> }>("public/tiles/sf/boundary.json");
  const ISLETS = BOUNDARY.shore
    .filter((r) => r.closed)
    .map((r) => {
      const xs = r.points.map((p) => p[0]);
      const zs = r.points.map((p) => p[1]);
      return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] as const;
    })
    .filter(([x0, x1, z0, z1]) => x1 - x0 < 100 && z1 - z0 < 100);
  const reachable = (x: number, z: number, e: RoadEdge & { gradeSeparated?: boolean }): boolean => {
    if (ISLETS.some(([x0, x1, z0, z1]) => x > x0 - 15 && x < x1 + 15 && z > z0 - 15 && z < z1 + 15)) return false;
    return !(waterAt(READ, x, z) && (e.gradeSeparated === true || e.kind === "freeway" || e.kind === "ramp"));
  };
  const onRing = (x: number, z: number, ring: ReadonlyArray<readonly [number, number]>): boolean => {
    if (pointInRing(x, z, ring)) return true;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i]!;
      const [bx, bz] = ring[(i + 1) % ring.length]!;
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < 0.05) return true;
    }
    return false;
  };
  /** The footprints (model frame) of the records a landmark replaces, as the sim has them. */
  const replacedRings = (l: Landmark): Array<Array<[number, number]>> => {
    const ids = new Set(l.replacesBuildingIds ?? []);
    if (ids.size === 0) return [];
    const o = toLocal(l.lat, l.lon);
    const out = new Map<string, Array<[number, number]>>();
    for (let i = -1; i <= 1; i++) {
      for (let k = -1; k <= 1; k++) {
        const c = READ(`t${Math.floor(o.x / TILE_SIZE_M) + i}_${Math.floor(o.z / TILE_SIZE_M) + k}`);
        for (const b of c?.buildings ?? []) if (ids.has(b.id)) out.set(b.id, b.footprint.map(([x, z]) => toModelFrame(o, l.headingDeg, x, z)));
      }
    }
    return [...out.values()];
  };

  it.each(LANDMARKS.map((l) => l.id))("%s", async (id) => {
    const l = entry(id);
    const rings = replacedRings(l);
    expect(rings.length, `${id}: every replaced record found`).toBe(new Set(l.replacesBuildingIds ?? []).size);
    const { doc } = await loadModel(fileOf(l));
    const allow = (t: readonly [V3, V3, V3]): boolean => rings.some((r) => t.every((p) => onRing(p[0] * scaleOf(l), p[2] * scaleOf(l), r)));
    const hits = clearanceHits(READ, l, allTriangles(doc), EDGES, { allow, reachable });
    expect(describeHits(hits), `${id} stands in a road's clearance`).toEqual([]);
  });

  it("the check sees the roads the bridges and the gate span (it is not vacuous)", async () => {
    // the same check with the band moved up into the models finds them over the roads
    for (const [id, edge, lo, hi] of [
      ["golden-gate-bridge", "c19205000", 6, 20], // Hwy 101 under the south anchorage's portal
      ["bay-bridge-west", "c14248000", 6, 30], // I-80 under the San Francisco anchorage's portal
      ["dragon-gate", "c6389000", 4.5, 8], // Grant Ave under the gate's lintels
    ] as const) {
      const l = entry(id);
      const { doc } = await loadModel(fileOf(l));
      const hits = clearanceHits(READ, l, allTriangles(doc), EDGES.filter((e) => e.id === edge), { lo, hi, reachable });
      expect(hits.length, `${id} over ${edge}`).toBeGreaterThan(3);
    }
  });
});

describe("landmark budgets (the landmark layer draws every landmark at any distance)", () => {
  it.each(IDS)("%s: within its triangle budget, at most 10 draw calls, under 1 MiB, night lights the renderer knows", async (id) => {
    const [file, budget] = INTERIM[id]!;
    const { doc, json, bytes } = await loadModel(file);
    expect(triangleCount(doc)).toBeLessThanOrEqual(budget);
    const prims = sceneNodes(doc).reduce((n, x) => n + (x.getMesh()?.listPrimitives().length ?? 0), 0);
    expect(prims).toBeLessThanOrEqual(10);
    expect(bytes.byteLength).toBeLessThan(1024 * 1024);
    for (const m of json.materials ?? []) {
      const name = m.name ?? "";
      const glows = (m.emissiveFactor ?? [0, 0, 0]).some((c) => c > 0.05);
      expect(glows, `${file} ${name}`).toBe(isLightMaterial(name));
      if (isLightMaterial(name)) expect(LIGHT_NIGHT_INTENSITY[lightBaseName(name)], `${name} has a night level`).toBeGreaterThan(0);
      expect(m.alphaMode ?? "OPAQUE").not.toBe("BLEND");
    }
    expect(subtree(node(doc, INTERIM[id]![2])).length).toBeGreaterThan(1);
  });

  it("all interim landmarks together stay under 80k triangles", async () => {
    let total = 0;
    for (const id of IDS) total += triangleCount((await loadModel(INTERIM[id]![0])).doc);
    expect(total).toBeLessThan(80_000);
  });
});
