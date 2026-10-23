// How the world gate's reference fixtures (tests/helpers/world-gate/fixtures/) were made: once,
// from the world QA run's evidence folder (its scratch space, `qa-world/`, not committed) and the
// committed world at 544f67c. Kept for provenance; rerun only to rebuild a fixture from the same
// evidence (`node scripts/golden/world-fixtures.ts <path to qa-world/>`), never to make a metric
// pass. Heavy (loads the whole city): run it under the machine's heavy-job lock.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toLocal, toLatLon } from "../../src/geo/project.ts";
import { parseGeoTiff } from "../../pipeline/lib/geotiff.ts";
import { Elevation } from "../../pipeline/lib/terrain.ts";
import { gameWorld, latticeAt, resample, distToSegment } from "../../tests/helpers/world.ts";

if (!process.argv[2]) {
  console.error("usage: node scripts/golden/world-fixtures.ts <path to the QA run's qa-world/ folder>");
  process.exit(1);
}
const QW = process.argv[2].endsWith("/") ? process.argv[2] : process.argv[2] + "/";
const OUT = join(import.meta.dirname, "..", "..", "tests/helpers/world-gate/fixtures") + "/";
mkdirSync(OUT, { recursive: true });
const j = (f: string) => JSON.parse(readFileSync(QW + f, "utf8"));
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const save = (name: string, obj: unknown, pretty = false) => writeFileSync(OUT + name, (pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj)) + "\n");
const gw = gameWorld();
const ll = (x: number, z: number) => { const p = toLatLon(x, z); return [r6(p.lat), r6(p.lon)]; };

// 1. post-2015 parcel points with storeys and no record within 25 m at 7dbb362 (W-04)
{
  const v = j("verify-buildings/out/v04-missing-blocks.json");
  save("newer-parcels.json", {
    source: "2025 assessor roll (DataSF wv5m-vpq2): parcels built 2015 or later with storeys, no footprint record within 25 m at 7dbb362 (QA verify-buildings v04)",
    points: v.missing.map((m: any) => ({ parcel: m.parcel, block: m.block, year: m.yr, stories: m.st, at: ll(m.x, m.z) })),
  }, true);
}

// 2. buried-roof sites (W-05): the worst point and its outward normal per record
{
  const v = j("verify-houses/v01-buried.json");
  save("buried-sites.json", {
    source: "QA verify-houses v01: records whose roof lies under the ground somewhere inside the footprint (7dbb362); worst point and outward normal",
    sites: v.rows.map((r: any) => ({ id: r.id, district: r.district, worst: { at: ll(r.worst.x, r.worst.z), nx: r6(r.worst.nx), nz: r6(r.worst.nz) }, groundOverRoofM: r2(r.maxGroundOverRoofM) })),
  }, true);
}

// 3. street-over-freeway crossings (W-14)
{
  const v = j("verify-play/r3/pc04.json");
  save("grade-crossings.json", {
    source: "QA verify-play pc04: every place a surface street crosses a freeway or ramp (7dbb362); the street's edge and direction at the crossing",
    crossings: v.crossings.map((c: any) => ({ edge: c.edge, street: c.street, over: c.over, at: ll(c.x, c.z), dx: r6(c.dx), dz: r6(c.dz) })),
  });
}

// 4. Rec and Park properties (W-18), simplified (Douglas-Peucker 1.5 m), local metres at 0.1 m
function dp(pts: number[][], tol: number): number[][] {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const st: Array<[number, number]> = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop()!;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i]![0]!, pts[i]![1]!, pts[a]![0]!, pts[a]![1]!, pts[b]![0]!, pts[b]![1]!);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; st.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
{
  const rpd = j("streets/net/rpd-parks.json");
  const props = rpd.map((r: any) => ({
    name: r.property_name,
    type: r.propertytype,
    polygons: r.shape.coordinates.map((poly: any) => poly.map((ring: any) => {
      const loc = ring.map(([lo, la]: number[]) => { const p = toLocal(la!, lo!); return [r1(p.x), r1(p.z)]; });
      return dp(loc, 1.5);
    }).filter((ring: any) => ring.length >= 4)).filter((poly: any) => poly.length > 0),
  })).filter((p: any) => p.polygons.length > 0);
  save("rec-park-properties.json", { source: "DataSF Recreation and Parks properties (gtr9-ntp6), ODC PDDL; simplified to 1.5 m, local metres", properties: props });
}

// 5. named summits (pass check)
{
  const h = j("terrain/c4_hills.json");
  save("summits.json", {
    source: "QA terrain c4: 25 named summits, the 3DEP DEM maximum within 150 m (demMaxM) and the published height",
    // Listed source differences (docs/qa/world-continuity-gate.md, B): published vs DEM differs for a known reason.
    summits: h.map((s: any) => ({ name: s.name, at: ll(s.x, s.z), publishedM: s.publishedM, demMaxM: s.demMaxM })),
  }, true);
}

// 6. 1 m DEM profiles along the hillside-crossing roads (W-31)
{
  const tifs = ["terrain/dem1m/mission-22nd.tif", "terrain/dem1m/potrero-vermont.tif", "terrain/dem1m/russian-hill.tif", "terrain/dem1m/twin-peaks.tif", "verify-terrain/dem1m/forest-hill.tif", "verify-terrain/dem1m/twinpeaksblvd.tif", "verify-terrain/dem1m/vermont.tif"];
  const one = new Elevation(tifs.map((f) => parseGeoTiff(new Uint8Array(readFileSync(QW + f)))));
  const profiles: Record<string, { name: string; dem1m: number[] }> = {};
  for (const id of ["c13216002", "c12770000", "c13186101", "c7806001", "c5491000", "c3403000"]) {
    const e = gw.edges.get(id)!;
    const pts = resample(e.points, 1);
    try {
      profiles[id] = { name: e.name ?? "", dem1m: pts.map(([x, z]) => r2(one.raw(x, z))) };
    } catch (err) {
      console.log(`no 1 m DEM for ${id} ${e.name}: ${(err as Error).message}`);
    }
  }
  save("dem1m-profiles.json", { source: "USGS 3DEP 1 m DEM (public domain), sampled every 1 m (resample(points, 1)) along each edge; fetched by the QA run (terrain/dem1m, verify-terrain/dem1m)", profiles });
}

// 7. inland lakes (W-11): the hydro-flattened lake surfaces as lattice vertex runs
{
  const lakes: Array<[string, number, number, number]> = [];
  for (const a of j("terrain/c1f_lake_areas.json")) {
    const [la, lo] = a.seedAt.split(",").map(Number);
    if (a.areaHa >= 0.3) lakes.push([a.name, la, lo, a.surfaceY]);
  }
  const out = [];
  for (const [name, la, lo, level] of lakes) {
    const p = toLocal(la, lo);
    const g0: [number, number] = [Math.round(p.x / 10), Math.round(p.z / 10)];
    const L0 = latticeAt(gw.world, g0[0], g0[1]);
    if (!L0) continue;
    const seen = new Set<string>([g0.join(",")]);
    const q: Array<[number, number]> = [g0];
    const cells: Array<[number, number]> = [];
    while (q.length && cells.length < 20000) {
      const [gx, gz] = q.pop()!;
      const L = latticeAt(gw.world, gx, gz);
      if (!L || Math.abs(L.y - level) > 0.07) continue;
      cells.push([gx, gz]);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const k = `${gx + dx},${gz + dz}`; if (!seen.has(k)) { seen.add(k); q.push([gx + dx, gz + dz]); } }
    }
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const runs: number[][] = [];
    for (const [gx, gz] of cells) {
      const last = runs[runs.length - 1];
      if (last && last[0] === gz && last[2] === gx - 1) last[2] = gx;
      else runs.push([gz, gx, gx]);
    }
    out.push({ name, seed: [la, lo], levelM: level, vertices: cells.length, runs });
    console.log("lake", name, level, cells.length);
  }
  save("lakes.json", { source: "QA terrain c1f: hydro-flattened lake surfaces of the 3DEP DEM, flood-filled on the 10 m lattice within 7 cm of the lake level at 544f67c; runs are [gz, gx0, gx1] of lattice vertices (x = 10 gx, z = 10 gz)", lakes: out });
}

// 8. start-blocked street starts (W-51) and the critic's seeded 300-edge sample
{
  const c = j("critic/c2-drive-all-surface.json");
  save("start-blocked.json", { source: "QA critic c2 at 54ee728: street drives whose start pose (and every pose up to 20 m in) overlaps a footprint", starts: c.runs.filter((r: any) => r.startBlocked).map((r: any) => [r.id, r.dir]) });
}
console.log("done");
