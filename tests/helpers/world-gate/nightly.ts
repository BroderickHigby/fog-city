// The gate's nightly sweeps (docs/qa/world-continuity-gate.md, rule 5): every street driven, every
// freeway, every path walked, every wall rammed, the whole shore's water side, the determinism of
// step() from the pack and from the JSON colliders.

import { buildWorld, createInitialState, hashState, step, type BoundaryFile, type RoadsFile, type SimState, type World } from "../../../src/sim/index.ts";
import { loadWorldFiles } from "../../helpers.ts";
import { colliderJsonTiles, districtOf, drivePath, ll, r2, resample, walkPath, type GameWorld, type RoadEdge } from "../world.ts";
import { ramWalls, rammingStarts, wallLaunch } from "./edge.ts";
import { driveEdge } from "./play.ts";
import { Measured } from "./measured.ts";

const isFwy = (e: RoadEdge): boolean => e.gradeSeparated === true || e.kind === "freeway" || e.kind === "ramp";

/** Every surface street edge in each allowed direction at min(posted, 20) m/s (the critic's c2, about 9 minutes). */
export function measureStreetsAll(gw: GameWorld): Measured {
  const m = new Measured("streets-all", "nightly");
  const world = gw.world;
  const outcomes: Record<string, boolean> = {};
  let mainStuck = 0;
  let mainStartBlocked = 0;
  let airborne = 0;
  const perDistrict = new Map<string, [number, number]>();
  const firstStuck: string[] = [];
  const edges = (gw.roads.edges as RoadEdge[]).filter((e) => !e.pedestrian && !isFwy(e)).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const e of edges) {
    const mid = e.points[Math.floor(e.points.length / 2)]!;
    const d = districtOf(gw, mid[0]!, mid[1]!);
    const mainland = d !== "Treasure Island";
    for (const dir of e.oneway ? ([1] as const) : ([1, -1] as const)) {
      const r = driveEdge(world, e, dir);
      if (r.r === null && !r.startBlocked) continue;
      outcomes[r.key] = r.ok;
      const c = perDistrict.get(d) ?? [0, 0];
      c[0]++;
      if (r.ok) c[1]++;
      perDistrict.set(d, c);
      if (r.startBlocked) {
        if (mainland) mainStartBlocked++;
        continue;
      }
      if (!r.ok && mainland) {
        mainStuck++;
        if (firstStuck.length < 20) firstStuck.push(`${r.key} ${e.name} at ${r.r?.stuckAt ? ll(r.r.stuckAt[0], r.r.stuckAt[1]) : "?"}`);
      }
      if (r.r && r.r.maxAirS >= 0.5) airborne++;
    }
  }
  m.runSet("streets-all/runs", outcomes);
  m.metric({ id: "N.streets.mainlandStuck", target: 0, better: "lower", unit: "runs", defects: ["W-01"], desc: "mainland street runs (every surface edge, each allowed direction, at the posted speed up to 20 m/s) that stop before the end" }, mainStuck, firstStuck);
  m.metric({ id: "N.streets.mainlandStartBlocked", target: 0, better: "lower", unit: "runs", defects: ["W-01", "W-51"], desc: "mainland street runs whose start (and every start up to 20 m in) overlaps a footprint" }, mainStartBlocked);
  m.metric({ id: "N.streets.airborneRuns", target: 0, better: "lower", unit: "runs", defects: ["W-14"], desc: "street runs airborne for 0.5 s or more at the posted speed (no real SF crest is listed yet)" }, airborne);
  let minShare = 1;
  let minAt = "";
  for (const [d, [n, ok]] of perDistrict) if (d !== "(none)" && n >= 20 && ok / n < minShare) {
    minShare = ok / n;
    minAt = d;
  }
  m.metric({ id: "N.streets.districtMinReachedShare", target: 0.995, better: "higher", unit: "share of runs", defects: ["W-01"], desc: "the lowest share, over districts, of street runs that reach their end" }, Math.floor(minShare * 1000) / 1000, minAt);
  return m;
}

/** Every freeway and ramp edge at 25 m/s. */
export function measureFreewaysAll(gw: GameWorld): Measured {
  const m = new Measured("freeways-all", "nightly");
  const world = gw.world;
  let air = 0;
  let hard = 0;
  let stuck = 0;
  const outcomes: Record<string, boolean> = {};
  const worst: string[] = [];
  for (const e of (gw.roads.edges as RoadEdge[]).filter(isFwy).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const pts = resample(e.points, 1);
    if (pts.length < 12) continue;
    for (const dir of e.oneway ? ([1] as const) : ([1, -1] as const)) {
      const path = dir > 0 ? pts : [...pts].reverse();
      const r = drivePath(world, path, { vmax: 25, startSpeed: 20 });
      const key = `${e.id}:${dir > 0 ? "+" : "-"}`;
      outcomes[key] = r.reached;
      if (!r.reached) stuck++;
      if (r.maxAirS > 0.3) air++;
      if (r.maxLandMps > 3) hard++;
      if ((!r.reached || r.maxAirS > 0.3) && worst.length < 20) worst.push(`${key} ${e.name}: ${r.reached ? "reached" : "stopped"}, airborne ${r2(r.maxAirS)} s, landing ${r2(r.maxLandMps)} m/s`);
    }
  }
  m.runSet("freeways-all/runs", outcomes);
  m.metric({ id: "N.freeways.airborneRuns", target: 0, better: "lower", unit: "runs", defects: ["W-03"], desc: "freeway and ramp runs at 25 m/s airborne for more than 0.3 s (draped viaducts launching the car)" }, air, worst);
  m.metric({ id: "N.freeways.hardLandings", target: 0, better: "lower", unit: "runs", defects: ["W-03"], desc: "freeway and ramp runs with a landing harder than 3 m/s" }, hard);
  m.metric({ id: "N.freeways.stuckRuns", target: 0, better: "lower", unit: "runs", defects: ["W-03", "W-07"], desc: "freeway and ramp runs that stop before the end (buildings on the freeway, sea walls)" }, stuck);
  return m;
}

/** Every pedestrian edge walked both ways. */
export function measurePathsAll(gw: GameWorld): Measured {
  const m = new Measured("paths-all", "nightly");
  const outcomes: Record<string, boolean> = {};
  const fails: string[] = [];
  for (const e of (gw.roads.edges as RoadEdge[]).filter((q) => q.pedestrian).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const pts = resample(e.points, 0.5);
    if (pts.length < 6) continue;
    for (const dir of [1, -1] as const) {
      const r = walkPath(gw.world, dir > 0 ? pts : [...pts].reverse());
      const key = `${e.id}:${dir > 0 ? "+" : "-"}`;
      outcomes[key] = r.reached;
      if (!r.reached) fails.push(`${key} ${e.name ?? ""}`);
    }
  }
  m.runSet("paths-all/walks", outcomes);
  m.metric({ id: "N.paths.walksBlocked", target: 0, better: "lower", unit: "walks", defects: ["W-39"], desc: "walks along every pedestrian edge (stairways, paths), both ways, with stepFoot, that do not reach the end" }, fails.length, fails.slice(0, 30));
  return m;
}

/** Every wall rammed every 100 m, and the whole shore's water side driven at the wall every 50 m. */
export function measureWallsAll(gw: GameWorld): Measured {
  const m = new Measured("walls-all", "nightly");
  const starts = rammingStarts(gw, 100);
  const r = ramWalls(gw, starts);
  m.metric({ id: "N.walls.escapes", target: 0, better: "lower", unit: "ram tests", defects: ["W-08"], desc: `ram tests from all ${starts.length} dry wall starts every 100 m (car at 30 m/s at 0/+-30/+-60 deg, sprinting walker at 0/+-45 deg) that cross a real wall or leave the built tiles` }, r.escapes.length, { tests: r.tests, first: r.escapes.slice(0, 10) });
  m.lap("ram");
  const l = wallLaunch(gw, 50, Infinity);
  m.metric({ id: "N.walls.launches", target: 0, better: "lower", unit: "runs", defects: ["W-06"], desc: "cars driven at the shore wall from 2.5 and 6 m out on the water at 5/15/30 m/s, every 50 m of shore, that rise over 1 m or jump more than speed*DT + 0.5 m in a tick" }, l.launches.length, { runs: l.runs, first: l.launches.slice(0, 10) });
  m.metric({ id: "N.walls.maxRiseM", target: 1, better: "lower", unit: "m", defects: ["W-06"], desc: "the highest any of those cars rose above the ground" }, r2(l.maxRiseM));
  return m;
}

/**
 * 60 s of step() with traffic: twice from the collider pack and once from the per-tile JSON
 * colliders, hashed every 600 ticks. It builds its own worlds, one at a time (the pack world is
 * dropped before the JSON world is built), not the worker's cached gameWorld(), so the suite
 * peaks near one whole-city world (rule 5: per-PR world tests stay under 2 GB).
 */
export function measureDeterminism(name = "sf"): Measured {
  const m = new Measured("determinism", "pr");
  const run = (world: World, spawn: GameWorld["manifest"]["spawn"]): string[] => {
    let s: SimState = createInitialState(world, 20261021, ["p1", "p2"], spawn);
    const out: string[] = [];
    for (let t = 1; t <= 3600; t++) {
      const k = Math.floor(t / 120) % 4;
      s = step(world, s, { p1: { throttle: k === 3 ? -0.5 : 1, steer: k === 1 ? 0.6 : k === 2 ? -0.6 : 0, brake: 0, actions: 0 }, p2: { throttle: 0.8, steer: t % 600 < 300 ? 0.3 : -0.3, brake: 0, actions: 0 } });
      if (t % 600 === 0) out.push(hashState(s));
    }
    return out;
  };
  // The pack world, as the game boots it, in its own scope: nothing of it outlives the two runs.
  const fromPack = (): { a: string[]; b: string[]; manifest: GameWorld["manifest"]; roads: RoadsFile; boundary: BoundaryFile } => {
    const files = loadWorldFiles(name, false);
    if (!files.roads || !files.boundary) throw new Error(`${name}: determinism needs the road graph and the boundary`);
    const world = buildWorld(files.tiles, files.roads as unknown as RoadsFile, files.boundary);
    const manifest = files.manifest as GameWorld["manifest"];
    return { a: run(world, manifest.spawn), b: run(world, manifest.spawn), manifest, roads: files.roads as unknown as RoadsFile, boundary: files.boundary };
  };
  const { a, b, manifest, roads, boundary } = fromPack();
  m.lap("pack");
  const json = buildWorld(colliderJsonTiles({ name, manifest }), roads, boundary);
  const c = run(json, manifest.spawn);
  m.lap("json");
  const diff = a.filter((h, i) => h !== b[i] || h !== c[i]).length + Math.abs(a.length - b.length) + Math.abs(a.length - c.length);
  m.metric({ id: "F.determinism.hashMismatches", target: 0, better: "lower", unit: "checkpoints", defects: [], desc: "60 s of step() with two players and traffic, twice from the collider pack and once from the per-tile JSON colliders: 600-tick state hashes that differ" }, diff, { pack: a, json: c });
  return m;
}
