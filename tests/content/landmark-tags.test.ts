// The places table of hero landmarks (content/landmark-tags.json, house kit K10), world QA W-27
// ("hero landmarks read as office boxes": tag the records the places-table probes list, draw them
// with glazing 0 in a stone or white palette) and L-04 ("the saints-peter-and-paul probe points
// 143 m away, at 201006.0003946; the church is 201006.0001265 and its -tower").
// Every entry is checked against the committed sf world.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { unionRings } from "../../pipeline/lib/polygon.ts";
import {
  LANDMARK_TAGS, checkLandmarkTags, distToRing, landmarkMaterialFor, landmarkTagFor, resolveProbe, storefrontAllowedOn, type LandmarkTagsFile,
} from "../../src/content/landmarkTags.ts";
import { shopfrontFor } from "../../src/content/storefronts.ts";
import { toLocal } from "../../src/geo/project.ts";
import { ROOT } from "../helpers.ts";
import { recordsNear, type SfRecord } from "./sf-houses.ts";

vi.setConfig({ testTimeout: 60_000 });

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const tag = (id: string) => LANDMARK_TAGS.landmarks.find((l) => l.id === id)!;
/** A record's podium (towers and terrace or span pieces belong to it). */
const podium = (r: SfRecord): string => r.meta?.towerOf ?? r.meta?.pieceOf ?? r.id;

describe("content/landmark-tags.json", () => {
  it("passes its consistency rules", () => expect(checkLandmarkTags()).toEqual([]));

  it("lists the hero landmarks of W-27, each with no shop band", () => {
    const ids = LANDMARK_TAGS.landmarks.map((l) => l.id);
    for (const id of ["600-montgomery", "city-hall", "coit-tower", "palace-of-fine-arts", "ballpark", "grace-cathedral", "conservatory-of-flowers", "dutch-windmill", "mission-dolores", "saints-peter-and-paul", "sutro-tower", "dragon-gate", "sutro-baths", "ferry-building", "fort-point"]) {
      expect(ids, id).toContain(id);
    }
    for (const l of LANDMARK_TAGS.landmarks) expect(l.shopBand, l.id).toBe(false);
  });

  it("checkLandmarkTags rejects a record tagged twice, a tower listed instead of its podium and a site with records", () => {
    const f = clone(LANDMARK_TAGS) as LandmarkTagsFile;
    f.landmarks[1]!.records.push(f.landmarks[0]!.records[0]!);
    f.landmarks[2]!.records.push("201006.0006230-tower");
    f.landmarks.find((l) => l.kind === "site")!.records.push("201006.0000001");
    const errs = checkLandmarkTags(f).join("\n");
    expect(errs).toContain("tagged by both");
    expect(errs).toContain("not its tower or piece");
    expect(errs).toContain("a site entry lists records");
  });
});

describe("every building entry's point resolves, on the committed sf world, to exactly its records", () => {
  for (const l of LANDMARK_TAGS.landmarks.filter((x) => x.kind === "building")) {
    it(l.id, () => {
      const near = recordsNear(l.point.lat, l.point.lon);
      const byId = new Map(near.map((r) => [r.id, r]));
      for (const id of l.records) {
        expect(near.some((r) => podium(r) === id), `${l.id}: ${id} and its pieces are not records of the world`).toBe(true);
      }
      const res = resolveProbe(l.point, near);
      expect(res.nearestM, `${l.id}: the point is in no record`).toBe(0);
      // The resolved records, mapped to their podiums, are exactly the listed records.
      expect([...new Set(res.buildings.map((id) => podium(byId.get(id)!)))].sort()).toEqual([...l.records].sort());
      // Every tower the listed podiums carry comes with them.
      for (const id of l.records) {
        const t = byId.get(id)!.meta?.tower;
        if (t) expect(res.buildings, `${l.id}: ${t}`).toContain(t);
      }
      // A single-point probe sits well inside its record, not on a wall a regeneration could move.
      if (l.point.radiusM === undefined) expect(res.insideByM, l.id).toBeGreaterThan(2);
    });
  }
});

describe("L-04: Saints Peter and Paul", () => {
  const sspp = tag("saints-peter-and-paul");
  const near = recordsNear(sspp.point.lat, sspp.point.lon);
  const byId = new Map(near.map((r) => [r.id, r]));

  it("the probe resolves to the church, 201006.0001265, and its spire record, 16 m inside its walls", () => {
    const res = resolveProbe(sspp.point, near);
    expect(res.buildings).toEqual(["201006.0001265", "201006.0001265-tower"]);
    expect(res.nearestM).toBe(0);
    // Terracing divides one church into several collider strips. Those internal seams are
    // not walls: retain the original clearance assertion against the source footprint's union.
    expect(res.insideByM).toBeGreaterThan(2);
    const { x, z } = toLocal(sspp.point.lat, sspp.point.lon);
    const church = unionRings(near.filter((r) => podium(r) === "201006.0001265" && !r.meta?.towerOf).map((r) => r.footprint));
    expect(church).toHaveLength(1);
    expect(distToRing(x, z, church[0]!.outer)).toBeGreaterThan(15);
  });

  it("201006.0001265 is the church: a non-residential hall of the 1920s with a spire rising over 50 m, the tallest record within 150 m", () => {
    const church = byId.get("201006.0001265")!;
    const spire = byId.get("201006.0001265-tower")!;
    expect(church.meta?.use).not.toMatch(/Residential/);
    expect(church.meta?.year).toBeGreaterThanOrEqual(1920);
    expect(church.meta?.year).toBeLessThanOrEqual(1926);
    expect(spire.meta?.towerOf).toBe("201006.0001265");
    expect(spire.topY - spire.baseY).toBeGreaterThan(50);
    const { x, z } = toLocal(sspp.point.lat, sspp.point.lon);
    const within = near.filter((r) => distToRing(x, z, r.footprint) < 150);
    expect(Math.max(...within.map((r) => r.topY))).toBe(spire.topY);
  });

  it("the record the old probe found, 201006.0003946, is an apartment building south of Washington Square, not the church", () => {
    const old = byId.get("201006.0003946")!;
    expect(old.meta?.use).toMatch(/Residential/);
    expect(landmarkTagFor(old)).toBeNull();
    // The old probe point (pipeline/areas.json before L-04): in no record; its nearest record is
    // that apartment building, 9.1 m away.
    const res = resolveProbe({ lat: 37.8003, lon: -122.4104 }, near);
    expect(res.buildings).toEqual(["201006.0003946"]);
    expect(res.nearestM).toBeGreaterThan(5);
    const a = toLocal(sspp.point.lat, sspp.point.lon);
    const b = toLocal(37.8003, -122.4104);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(130);
  });
});

describe("site entries stand in no footprint", () => {
  for (const l of LANDMARK_TAGS.landmarks.filter((x) => x.kind === "site")) {
    it(l.id, () => {
      const near = recordsNear(l.point.lat, l.point.lon);
      const res = resolveProbe({ lat: l.point.lat, lon: l.point.lon }, near);
      // nearestM is 0 only when a record contains the point.
      expect(res.nearestM, l.id).toBeGreaterThan(0);
    });
  }

  it("the gate stands over Grant Ave, within 8 m of its centreline", () => {
    const roads = JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/roads.json"), "utf8")) as { edges: Array<{ name?: string; points: Array<[number, number]> }> };
    const g = tag("dragon-gate");
    const { x, z } = toLocal(g.point.lat, g.point.lon);
    const polylineDist = (pts: Array<[number, number]>): number => {
      let best = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i]!;
        const [bx, bz] = pts[i + 1]!;
        const l2 = (bx - ax) ** 2 + (bz - az) ** 2;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / l2)) : 0;
        best = Math.min(best, Math.hypot(ax + t * (bx - ax) - x, az + t * (bz - az) - z));
      }
      return best;
    };
    const d = Math.min(...roads.edges.filter((e) => e.name === "Grant Ave").map((e) => polylineDist(e.points)));
    expect(d).toBeLessThan(8);
  });
});

describe("tagging and drawing rules", () => {
  it("a tower and a terrace piece take their podium's tag; an untagged record has none", () => {
    expect(landmarkTagFor({ id: "201006.0006230-tower", meta: { towerOf: "201006.0006230" } })?.id).toBe("coit-tower");
    expect(landmarkTagFor({ id: "201006.0000041-s1", meta: { pieceOf: "201006.0000041" } })?.id).toBe("city-hall");
    // The storefront payload has only buildingId; preserve the source landmark policy after
    // the pipeline replaces its footprint with smaller slope/bridge pieces.
    expect(landmarkTagFor({ id: "201006.0000003-s1" })?.id).toBe("ballpark");
    expect(landmarkTagFor({ id: "201006.0000003-tower-s1" })?.id).toBe("ballpark");
    expect(landmarkTagFor({ id: "201006.0000041-b2" })?.id).toBe("city-hall");
    expect(storefrontAllowedOn("201006.0000041-b2")).toBe(false);
    expect(storefrontAllowedOn("201006.0000003-s1")).toBe(true);
    expect(landmarkTagFor({ id: "201006.0003946" })).toBeNull();
    expect(landmarkMaterialFor({ id: "201006.0001265" })).toEqual(LANDMARK_TAGS.materials.white);
    expect(landmarkMaterialFor({ id: "201006.0000856" })).toEqual(LANDMARK_TAGS.materials.brick);
  });

  it("storefront anchors on civic landmarks are not drawn; the market hall and the ballpark keep theirs", () => {
    const anchors = (JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/storefronts.json"), "utf8")) as { storefronts: Array<{ id: string; naics: string; buildingId: string }> }).storefronts;
    const onTagged = anchors.filter((a) => landmarkTagFor({ id: a.buildingId }) !== null);
    const hidden = onTagged.filter((a) => !storefrontAllowedOn(a.buildingId));
    // City Hall (1), Coit Tower (1) and the pyramid tower (1) today.
    expect(hidden.map((a) => landmarkTagFor({ id: a.buildingId })!.id).sort()).toEqual(["600-montgomery", "city-hall", "coit-tower"]);
    for (const a of hidden) expect(shopfrontFor(a)).toBeNull();
    const kept = onTagged.filter((a) => storefrontAllowedOn(a.buildingId));
    expect(new Set(kept.map((a) => landmarkTagFor({ id: a.buildingId })!.id))).toEqual(new Set(["ferry-building", "ballpark"]));
    for (const a of kept) expect(shopfrontFor(a)).not.toBeNull();
  });

  it("landmark materials are stone, sandstone, white, brick or bare concrete: quiet, never glass", () => {
    for (const [id, m] of Object.entries(LANDMARK_TAGS.materials)) {
      for (const hex of [m.wall, m.trim, m.roof]) {
        const v = parseInt(hex.slice(1), 16);
        const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
        const sat = (Math.max(...ch) - Math.min(...ch)) / Math.max(...ch);
        expect(sat, `${id} ${hex}`).toBeLessThan(0.6);
      }
    }
  });
});
