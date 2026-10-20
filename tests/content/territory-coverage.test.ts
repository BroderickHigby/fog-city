// Territory coverage (docs/roadmap.md, Rules for every wave): every shipped (active) district has
// at least one activity marker, at least one bounty template and a safehouse or garage within
// 1.5 km; the excluded areas have no mode instance. The 1.5 km rule is measured from a district's
// hub, and for an excluded area from its nearest point (excluded areas are long strips, and they
// are exempt from the activity and bounty counts but not from the 1.5 km rule).
import { describe, expect, it } from "vitest";
import { PACKS } from "../../src/content/packs.ts";
import { tileId, tileIndexOf, toLocal } from "../../src/geo/project.ts";
import { manifestTiles, shippedDistricts } from "./content-files.ts";
import {
  ACTIVITIES, DISTRICTS, INSTANCES, MODES, MOAT_SITES, PROTECTED_AREAS, SAFEHOUSE_RADIUS_M, SITES, distanceM, distanceToPolygonM,
  districtById, nearestSite, pointInPolygon, polygonsIntersect,
} from "../../src/content/places.ts";

/** The wave this content ships for. Activity markers and sites from later waves do not count yet. */
const WAVE = 2;
// The shipped districts come from the tile manifest when it carries district ids, otherwise
// from districts.json's active flags (content-files.ts shippedDistricts).
const shipped = shippedDistricts();
const active = DISTRICTS.filter((d) => shipped.ids.includes(d.id));
const excluded = PROTECTED_AREAS.filter((a) => a.excluded);

describe("territory coverage", () => {
  it("the shipped set agrees with the manifest and with districts.json", () => {
    // Every district the manifest names exists; the manifest and the active flags agree.
    for (const id of shipped.ids) expect(districtById(id), `manifest district ${id} is not in content/districts.json`).toBeDefined();
    expect(DISTRICTS.filter((d) => d.active).map((d) => d.id).sort(), `shipped districts come from ${shipped.source}`).toEqual(shipped.ids);
    // Every shipped district is built: its hub or a corner of its polygon lies on a tile of the
    // current sf manifest that has roads or buildings.
    const tiles = manifestTiles();
    for (const d of active) {
      const onBuilt = [[d.hub.lat, d.hub.lon] as const, ...d.polygon].some(([lat, lon]) => {
        const { x, z } = toLocal(lat, lon);
        const { ix, iz } = tileIndexOf(x, z);
        const t = tiles.get(tileId(ix, iz));
        return t !== undefined && (t.stats?.roadEdges ?? 0) + (t.stats?.buildings ?? 0) > 0;
      });
      expect(onBuilt, `${d.id} ships but no built tile of public/tiles/sf/manifest.json covers it`).toBe(true);
    }
  });

  it("the shipped districts are territory steps 1-3, all active", () => {
    expect(active.map((d) => d.id).sort()).toEqual(
      ["bay-bridge-approach", "dogpatch", "downtown", "embarcadero", "fidi", "fishermans-wharf", "marina", "mission-bay", "north-beach", "rincon-hill", "soma"].sort(),
    );
    for (const d of active) expect(d.step).toBeLessThanOrEqual(3);
  });

  for (const d of active) {
    describe(d.name, () => {
      it("has at least one activity marker of a shipped activity, inside the district", () => {
        const here = ACTIVITIES.filter((a) => a.district === d.id && a.wave <= WAVE);
        expect(here.length, d.id).toBeGreaterThan(0);
        for (const a of here) expect(pointInPolygon([a.lat, a.lon], d.polygon), a.id).toBe(true);
      });

      it("has at least one bounty template, with its local tell", () => {
        const p = PACKS[d.id];
        expect(p, `content/packs/${d.id}.json`).toBeDefined();
        expect(p!.bounties.length).toBeGreaterThan(0);
        expect(p!.bounties.some((b) => b.localTell)).toBe(true);
      });

      it(`has a safehouse or garage within ${SAFEHOUSE_RADIUS_M / 1000} km of its hub`, () => {
        expect(pointInPolygon([d.hub.lat, d.hub.lon], d.polygon), "hub inside the district").toBe(true);
        const n = nearestSite([d.hub.lat, d.hub.lon], WAVE);
        expect(n, d.id).not.toBeNull();
        expect(n!.m, `${d.id}: nearest is ${n!.site.id} at ${Math.round(n!.m)} m`).toBeLessThanOrEqual(SAFEHOUSE_RADIUS_M);
      });
    });
  }

  for (const a of excluded.filter((x) => x.step <= 3)) {
    it(`excluded area ${a.name} (shipped) has a safehouse or garage within 1.5 km`, () => {
      const best = Math.min(...SITES.filter((s) => s.wave <= WAVE).map((s) => distanceToPolygonM([s.lat, s.lon], a.polygon)));
      expect(best).toBeLessThanOrEqual(SAFEHOUSE_RADIUS_M);
    });
  }

  it("no activity marker, bounty anchor or Moat Labs site lies in an excluded area", () => {
    const points: Array<[string, number, number]> = [
      ...ACTIVITIES.map((a) => [`activity ${a.id}`, a.lat, a.lon] as [string, number, number]),
      ...Object.values(PACKS).flatMap((p) => p.bounties.map((b) => [`bounty ${b.id}`, b.lastSeen.lat, b.lastSeen.lon] as [string, number, number])),
      ...MOAT_SITES.map((s) => [`moat site ${s.id}`, s.lat, s.lon] as [string, number, number]),
    ];
    for (const [what, lat, lon] of points) for (const a of excluded) expect(pointInPolygon([lat, lon], a.polygon), `${what} in ${a.name}`).toBe(false);
  });

  it("no Moat Labs HQ, depot or car-theft destination is placed in any protected area", () => {
    for (const s of MOAT_SITES) for (const a of PROTECTED_AREAS) expect(pointInPolygon([s.lat, s.lon], a.polygon), `${s.id} in ${a.name}`).toBe(false);
  });

  it("excluded areas have no mode instance (and instances stay clear of every protected area)", () => {
    expect(excluded.map((a) => a.id).sort()).toEqual(["civic-center", "division-13th", "sixth-street", "tenderloin"]);
    for (const i of INSTANCES) {
      for (const a of PROTECTED_AREAS) expect(polygonsIntersect(i.polygon, a.polygon), `instance ${i.id} meets ${a.name}`).toBe(false);
    }
  });

  it("the instance rotation is FiDi, North Beach, the Marina, Dogpatch, then SoMa to Mission Bay", () => {
    expect(INSTANCES.map((i) => i.district)).toEqual(["fidi", "north-beach", "marina", "dogpatch", "soma"]);
    for (const i of INSTANCES) {
      expect(districtById(i.district)?.active, i.id).toBe(true);
      for (const m of i.modes) expect(MODES.some((x) => x.id === m), m).toBe(true);
    }
    // The SoMa instance covers the convention-center block, Rincon Hill and Mission Bay.
    const soma = INSTANCES.find((i) => i.id === "soma-bay")!;
    expect(pointInPolygon([37.78352, -122.40082], soma.polygon), "convention-center block").toBe(true);
    expect(pointInPolygon([37.786, -122.392], soma.polygon), "Rincon Hill").toBe(true);
    expect(pointInPolygon([37.7700, -122.3900], soma.polygon), "Mission Bay").toBe(true);
  });

  it("wave-2 sites are the FiDi coworking desk, the Marina garage and the Mission Bay garage, each inside its district", () => {
    const w2 = SITES.filter((s) => s.wave === 2);
    expect(w2.map((s) => s.id).sort()).toEqual(["fidi-desk", "marina-garage", "mission-bay-garage"]);
    for (const s of w2) expect(pointInPolygon([s.lat, s.lon], districtById(s.district)!.polygon), s.id).toBe(true);
    expect(w2.find((s) => s.id === "fidi-desk")!.garage).toBe(false);
    // The Marina garage sits at the east end of Marina Blvd, toward Fisherman's Wharf.
    const marina = w2.find((s) => s.id === "marina-garage")!;
    expect(distanceM([marina.lat, marina.lon], [37.8052, -122.43209])).toBeLessThan(80);
  });

  it("the coverage check fails when a district loses its only safehouse (it can fail)", () => {
    const fw = districtById("fishermans-wharf")!;
    const others = SITES.filter((s) => s.wave <= WAVE && s.id !== "marina-garage");
    const best = Math.min(...others.map((s) => distanceM([fw.hub.lat, fw.hub.lon], [s.lat, s.lon])));
    expect(best).toBeGreaterThan(SAFEHOUSE_RADIUS_M);
  });
});
