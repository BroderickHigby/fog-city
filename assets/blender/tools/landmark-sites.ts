// The outside data the landmark models are built on: where each one stands, which collider
// records it replaces (their footprints and heights in the model's own frame), and the sim's
// ground around it. Read from the committed sf world (public/tiles/sf/), written to
// assets/blender/data/landmark-sites.json, which the Blender scripts read (they never open the
// tiles themselves) and tools/landmarks.py turns into content/landmarks.json entries.
//
//   node assets/blender/tools/landmark-sites.ts           # rewrite the JSON
//   node assets/blender/tools/landmark-sites.ts --check   # exit 1 if the JSON is stale
//
// tests/assets/landmarks.test.ts recomputes this from the world and fails when the committed
// file no longer matches (a pipeline regeneration moved a record or the ground): then rerun
// this tool and rebuild the landmark models.
//
// Frames. World: metres from the Ferry Building, +x east, +z south (src/geo/project.ts).
// Model: glTF, +y up, the front faces -z, placed with rotation.y = -heading, so
// model = Ry(heading) * (world - origin) (the same maths as tests/assets/models.test.ts).
// Heights in the file are relative to the sim's ground at the origin, which is where the
// renderer stands the model (src/render/landmarks.ts placeLandmark).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TILE_SIZE_M, toLatLon, toLocal } from "../../../src/geo/project.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SITES_FILE = "assets/blender/data/landmark-sites.json";

interface Heightfield {
  x0: number;
  z0: number;
  cellSizeM: number;
  nx: number;
  nz: number;
  heights: number[];
  water?: Array<0 | 1 | boolean>;
}
interface Record_ {
  id: string;
  footprint: Array<[number, number]>;
  baseY: number;
  topY: number;
  meta: { footY?: number; heightSource?: string; tower?: string; towerOf?: string };
}
interface Collider {
  tileId: string;
  ground: Heightfield;
  buildings: Record_[];
}
interface Edge {
  id: string;
  name?: string;
  widthM: number;
  lanes: number;
  oneway: boolean;
  points: Array<[number, number]>;
}

/** Reads a tile's collider by id ("t-2_0"), or null where the world has no tile (open water). */
export type ReadTile = (id: string) => Collider | null;

export function fileTileReader(world = "sf", root = REPO): ReadTile {
  const cache = new Map<string, Collider | null>();
  return (id) => {
    if (!cache.has(id)) {
      const p = join(root, "public", "tiles", world, `${id}.collider.json`);
      cache.set(id, existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Collider) : null);
    }
    return cache.get(id)!;
  };
}

const tileOf = (x: number, z: number): string => `t${Math.floor(x / TILE_SIZE_M)}_${Math.floor(z / TILE_SIZE_M)}`;

/** The sim's ground (src/sim/world.ts groundHeight on tile-aligned worlds): bilinear, 0 where no tile. */
export function groundAt(read: ReadTile, x: number, z: number): number {
  const c = read(tileOf(x, z));
  if (!c) return 0;
  const g = c.ground;
  const fx = (x - g.x0) / g.cellSizeM;
  const fz = (z - g.z0) / g.cellSizeM;
  const ix = Math.min(Math.floor(fx), g.nx - 2);
  const iz = Math.min(Math.floor(fz), g.nz - 2);
  const tx = fx - ix;
  const tz = fz - iz;
  const h = (i: number, k: number): number => g.heights[k * g.nx + i] ?? 0;
  return (h(ix, iz) * (1 - tx) + h(ix + 1, iz) * tx) * (1 - tz) + (h(ix, iz + 1) * (1 - tx) + h(ix + 1, iz + 1) * tx) * tz;
}

/** True where the nearest lattice sample is flagged water (or there is no tile: open water). */
export function waterAt(read: ReadTile, x: number, z: number): boolean {
  const c = read(tileOf(x, z));
  if (!c) return true;
  const g = c.ground;
  const i = Math.round((z - g.z0) / g.cellSizeM) * g.nx + Math.round((x - g.x0) / g.cellSizeM);
  return Boolean(g.water?.[i]);
}

function findRecord(read: ReadTile, id: string, near: { x: number; z: number }): Record_ {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const c = read(tileOf(near.x + dx * TILE_SIZE_M, near.z + dz * TILE_SIZE_M));
      const r = c?.buildings.find((b) => b.id === id);
      if (r) return r;
    }
  }
  throw new Error(`landmark-sites: record ${id} not found near (${near.x.toFixed(0)}, ${near.z.toFixed(0)})`);
}

function polygonCentroid(ring: ReadonlyArray<readonly [number, number]>): [number, number] {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i]!;
    const [x1, z1] = ring[(i + 1) % ring.length]!;
    const k = x0 * z1 - x1 * z0;
    a += k;
    cx += (x0 + x1) * k;
    cz += (z0 + z1) * k;
  }
  return [cx / (3 * a), cz / (3 * a)];
}

/**
 * The minimum-area rectangle round a ring (rotating calipers over its edges): centre, the
 * compass bearing of its long side (0..180), long and short side lengths.
 */
export function minAreaRect(ring: ReadonlyArray<readonly [number, number]>): { cx: number; cz: number; bearingDeg: number; long: number; short: number } {
  let best = { area: Infinity, cx: 0, cz: 0, bearingDeg: 0, long: 0, short: 0 };
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i]!;
    const [bx, bz] = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of ring) {
      const u = x * ux + z * uz;
      const v = -x * uz + z * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area - 1e-9) {
      const um = (u0 + u1) / 2;
      const vm = (v0 + v1) / 2;
      const cx = um * ux - vm * uz;
      const cz = um * uz + vm * ux;
      const alongU = u1 - u0 >= v1 - v0;
      const [dx, dz] = alongU ? [ux, uz] : [-uz, ux];
      const b = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 180;
      best = { area, cx, cz, bearingDeg: b, long: Math.max(u1 - u0, v1 - v0), short: Math.min(u1 - u0, v1 - v0) };
    }
  }
  return { cx: best.cx, cz: best.cz, bearingDeg: best.bearingDeg, long: best.long, short: best.short };
}

const DEG = Math.PI / 180;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r7 = (v: number): number => Math.round(v * 1e7) / 1e7;
const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/** World (x, z) -> the model frame of a landmark at `o` facing `headingDeg`. */
export function toModelFrame(o: { x: number; z: number }, headingDeg: number, x: number, z: number): [number, number] {
  const h = headingDeg * DEG;
  const dx = x - o.x;
  const dz = z - o.z;
  return [dx * Math.cos(h) + dz * Math.sin(h), -dx * Math.sin(h) + dz * Math.cos(h)];
}

/** The model frame -> world. */
export function fromModelFrame(o: { x: number; z: number }, headingDeg: number, mx: number, mz: number): [number, number] {
  const h = headingDeg * DEG;
  return [o.x + mx * Math.cos(h) - mz * Math.sin(h), o.z + mx * Math.sin(h) + mz * Math.cos(h)];
}

interface SiteRecord {
  id: string;
  footprint: Array<[number, number]>;
  footY: number;
  baseY: number;
  topY: number;
  heightSource: string;
}

export interface Site {
  id: string;
  lat: number;
  lon: number;
  headingDeg: number;
  /** World position of the origin (from lat/lon, as the renderer computes it) and the sim's ground there. */
  x: number;
  z: number;
  groundY: number;
  replacesBuildingIds: string[];
  records: SiteRecord[];
  /** Ground relative to groundY on a square grid in the model frame: values[iz][ix] at (-half + ix*step, -half + iz*step). */
  grid?: { half: number; step: number; values: number[][] };
  /** Ground along the model's -z axis (its "forward"): samples at t = from + i*step metres ahead of the origin. */
  profile?: { from: number; step: number; ground: number[]; water: Array<0 | 1> };
  /**
   * Every road ribbon near the model (roads.json edges, in the model frame): the model keeps
   * its solids off them from the road up to the clearance a car and a walker need, because the
   * sim has no collider for landmark geometry (tests/assets/landmarks.test.ts checks it).
   */
  roads?: SiteRoad[];
  /** Anything else the model script needs, measured here (documented per site). */
  extra?: Record<string, unknown>;
}

export interface SiteRoad {
  id: string;
  name: string;
  widthM: number;
  /** The centreline in the model frame (x, z). */
  points: Array<[number, number]>;
  /** The sim's ground under each point, relative to groundY. */
  ground: number[];
}

export interface SitesDoc {
  $comment: string;
  world: string;
  sites: Site[];
}

function site(read: ReadTile, id: string, at: { x: number; z: number }, headingDeg: number, replaces: string[]): Site {
  const ll = toLatLon(at.x, at.z);
  const lat = r7(ll.lat);
  const lon = r7(ll.lon);
  const p = toLocal(lat, lon);
  const g = groundAt(read, p.x, p.z);
  const h = r2(norm360(headingDeg));
  const records = replaces.map((rid) => {
    const r = findRecord(read, rid, p);
    return {
      id: r.id,
      footprint: r.footprint.map(([x, z]) => toModelFrame(p, h, x, z).map(r2) as [number, number]),
      footY: r2((r.meta.footY ?? r.baseY) - g),
      baseY: r2(r.baseY - g),
      topY: r2(r.topY - g),
      heightSource: r.meta.heightSource ?? "",
    };
  });
  return { id, lat, lon, headingDeg: h, x: r2(p.x), z: r2(p.z), groundY: r2(g), replacesBuildingIds: [...replaces].sort(), records };
}

function addGrid(read: ReadTile, s: Site, half: number, step: number): void {
  const p = toLocal(s.lat, s.lon);
  const n = Math.round((2 * half) / step) + 1;
  const values: number[][] = [];
  for (let iz = 0; iz < n; iz++) {
    const row: number[] = [];
    for (let ix = 0; ix < n; ix++) {
      const [x, z] = fromModelFrame(p, s.headingDeg, -half + ix * step, -half + iz * step);
      row.push(r2(groundAt(read, x, z) - s.groundY));
    }
    values.push(row);
  }
  s.grid = { half, step, values };
}

function addProfile(read: ReadTile, s: Site, from: number, to: number, step: number): void {
  const p = toLocal(s.lat, s.lon);
  const ground: number[] = [];
  const water: Array<0 | 1> = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    const [x, z] = fromModelFrame(p, s.headingDeg, 0, -t);
    ground.push(r2(groundAt(read, x, z) - s.groundY));
    water.push(waterAt(read, x, z) ? 1 : 0);
  }
  s.profile = { from, step, ground, water };
}

function probeRecords(id: string): string[] {
  const report = JSON.parse(readFileSync(join(REPO, "public", "tiles", "sf", "report.json"), "utf8")) as { probes: Array<{ id: string; buildings: string[] }> };
  const p = report.probes.find((q) => q.id === id);
  if (!p) throw new Error(`landmark-sites: report.json has no probe ${id}`);
  return [...p.buildings].sort();
}

function centroidOf(read: ReadTile, rid: string, near: { x: number; z: number }): { x: number; z: number; ring: Array<[number, number]> } {
  const r = findRecord(read, rid, near);
  const [x, z] = polygonCentroid(r.footprint);
  return { x, z, ring: r.footprint };
}

let ROADS: Edge[] | null = null;
function roads(): Edge[] {
  ROADS ??= (JSON.parse(readFileSync(join(REPO, "public", "tiles", "sf", "roads.json"), "utf8")) as { edges: Edge[] }).edges;
  return ROADS;
}

/**
 * The road ribbons whose drawn width reaches into the model-frame window [x0, x1] x [z0, z1]:
 * each edge's centreline resampled every ROAD_STEP_M (so the ground follows the hills between
 * its vertices) and cut to the window, one piece per stretch inside it, in roads.json order.
 */
const ROAD_STEP_M = 4;
function addRoads(read: ReadTile, s: Site, x0: number, x1: number, z0: number, z1: number): void {
  const p = toLocal(s.lat, s.lon);
  const out: SiteRoad[] = [];
  for (const e of roads()) {
    const m = e.widthM / 2 + ROAD_STEP_M;
    // world samples along the edge, every vertex kept
    const samples: Array<[number, number]> = [];
    for (let i = 0; i + 1 < e.points.length; i++) {
      const [ax, az] = e.points[i]!;
      const [bx, bz] = e.points[i + 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / ROAD_STEP_M));
      for (let k = 0; k < n; k++) samples.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
    samples.push(e.points[e.points.length - 1]!);
    let run: Array<[number, number]> = [];
    const flush = (): void => {
      if (run.length >= 2) {
        out.push({
          id: e.id,
          name: e.name ?? "",
          widthM: e.widthM,
          points: run.map(([x, z]) => toModelFrame(p, s.headingDeg, x, z).map(r2) as [number, number]),
          ground: run.map(([x, z]) => r2(groundAt(read, x, z) - s.groundY)),
        });
      }
      run = [];
    };
    let last: [number, number] | null = null;
    for (const w of samples) {
      const [x, z] = toModelFrame(p, s.headingDeg, w[0], w[1]);
      const inside = x >= x0 - m && x <= x1 + m && z >= z0 - m && z <= z1 + m;
      if (inside) {
        if (run.length === 0 && last) run.push(last); // the sample before, so the piece starts outside
        run.push(w);
      } else if (run.length > 0) {
        run.push(w);
        flush();
      }
      last = w;
    }
    flush();
  }
  s.roads = out;
}

/** Distance along a ray from (x, z) in unit direction (ux, uz) to the first footprint wall, up to max. */
function rayToWall(read: ReadTile, x: number, z: number, ux: number, uz: number, max: number): number {
  let best = max;
  const seen = new Set<string>();
  for (let s = 0; s <= max; s += TILE_SIZE_M / 2) {
    const id = tileOf(x + ux * s, z + uz * s);
    if (seen.has(id)) continue;
    seen.add(id);
    for (const b of read(id)?.buildings ?? []) {
      const f = b.footprint;
      for (let i = 0; i < f.length; i++) {
        const [ax, az] = f[i]!;
        const [bx, bz] = f[(i + 1) % f.length]!;
        const ex = bx - ax;
        const ez = bz - az;
        const den = ux * ez - uz * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((ax - x) * ez - (az - z) * ex) / den;
        const u = ((ax - x) * uz - (az - z) * ux) / den;
        if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
      }
    }
  }
  return best;
}

export function buildSites(read: ReadTile): SitesDoc {
  const sites: Site[] = [];

  // Sutro Tower. The six probe records are the LiDAR's plan view of the lattice's upper
  // structure (three thin crossarm beams, overridden to 3 m plinths) and the equipment
  // buildings. The crossarm beams fix the tower: one arm runs west to x -35.4 m of the probe
  // and the other two meet a north-south line 40.1 m east of that, which puts the centre of a
  // 45.7 m base triangle (circumradius 26.4 m, published) 26.7 m east of the west tip. So the
  // origin is that centre and the legs stand at bearings 270, 30 and 150 (heading 0: model
  // axes are world axes). The model draws every replaced record where the sim has it.
  {
    const probe = toLocal(37.7552, -122.4528);
    const ids = probeRecords("sutro-tower");
    const arms = findRecord(read, "201006.0009087", probe).footprint;
    const west = Math.min(...arms.map(([x]) => x));
    // The north-south beam's two tips (more than 25 m from the probe): its centre line.
    const tips = arms.filter(([, z]) => Math.abs(z - probe.z) > 25);
    const east = tips.reduce((a, [x]) => a + x, 0) / tips.length;
    const zs = arms.map(([, z]) => z);
    const cx = west + (east - west) * (2 / 3);
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const s = site(read, "sutro-tower", { x: cx, z: cz }, 0, ids);
    addGrid(read, s, 46, 2);
    addRoads(read, s, -46, 46, -46, 46);
    s.extra = { armWestTipM: r2(west - cx), armEastLineM: r2(east - cx) };
    sites.push(s);
  }

  // 600 Montgomery St (the pyramid tower). Origin at the tower record's centre (the LiDAR's
  // shaft), heading so the model's axes run along the square base (the podium record's sides).
  {
    const probe = toLocal(37.79518, -122.40278);
    const ids = probeRecords("600-montgomery");
    const t = centroidOf(read, "201006.0000687-tower", probe);
    const rect = minAreaRect(findRecord(read, "201006.0000687", probe).footprint);
    const heading = ((rect.bearingDeg + 45) % 90) - 45;
    const s = site(read, "600-montgomery", t, heading, ids);
    s.extra = { baseLongM: r2(rect.long), baseShortM: r2(rect.short), baseCentre: toModelFrame(toLocal(s.lat, s.lon), s.headingDeg, rect.cx, rect.cz).map(r2) };
    sites.push(s);
  }

  // Coit Tower: the column at the tower record's centre; the base building is its podium record.
  {
    const probe = toLocal(37.80243, -122.40585);
    const ids = probeRecords("coit-tower");
    const t = centroidOf(read, "201006.0006230-tower", probe);
    const rect = minAreaRect(t.ring);
    const s = site(read, "coit-tower", t, ((rect.bearingDeg + 45) % 90) - 45, ids);
    addGrid(read, s, 24, 2);
    sites.push(s);
  }

  // City Hall: the dome over the tower record's centre; the front (-z) faces east, onto the
  // Civic Center plaza, so the long (north-south) side of the podium runs along model x.
  {
    const probe = toLocal(37.77927, -122.41924);
    const ids = probeRecords("city-hall");
    const t = centroidOf(read, "201006.0000041-tower", probe);
    const rect = minAreaRect(findRecord(read, "201006.0000041", probe).footprint);
    const s = site(read, "city-hall", t, rect.bearingDeg + 270, ids);
    s.extra = { podiumLongM: r2(rect.long), podiumShortM: r2(rect.short) };
    sites.push(s);
  }

  // Palace of Fine Arts: the rotunda record's centroid; the front faces away from the
  // exhibition hall (record 201006.0000031), across the lagoon.
  {
    const probe = toLocal(37.80286, -122.44844);
    const ids = probeRecords("palace-of-fine-arts");
    const rot = centroidOf(read, "201006.0000986", probe);
    const hall = centroidOf(read, "201006.0000031", probe);
    const b = (Math.atan2(rot.x - hall.x, -(rot.z - hall.z)) * 180) / Math.PI;
    sites.push(site(read, "palace-of-fine-arts", rot, b, ids));
  }

  // Grace Cathedral: the body record's long axis; the twin-tower front is the end away from
  // the crossing (the tower record is the crossing's fleche), and faces -z.
  {
    const probe = toLocal(37.79186, -122.41322);
    const ids = probeRecords("grace-cathedral");
    const body = findRecord(read, "201006.0000550", probe);
    const rect = minAreaRect(body.footprint);
    const cross = centroidOf(read, "201006.0000550-tower", probe);
    const ux = Math.sin(rect.bearingDeg * DEG);
    const uz = -Math.cos(rect.bearingDeg * DEG);
    const along = (cross.x - rect.cx) * ux + (cross.z - rect.cz) * uz;
    const heading = along < 0 ? rect.bearingDeg : rect.bearingDeg + 180;
    const s = site(read, "grace-cathedral", { x: rect.cx, z: rect.cz }, heading, ids);
    s.extra = { bodyLongM: r2(rect.long), bodyShortM: r2(rect.short), crossing: toModelFrame(toLocal(s.lat, s.lon), s.headingDeg, cross.x, cross.z).map(r2) };
    sites.push(s);
  }

  // Mission Dolores (the basilica, as the probe has it): origin at the body record's centroid,
  // the front (-z) facing Dolores St to the east along the body's long axis. The old adobe
  // chapel south of it is a separate record the probe does not list, so it is not replaced.
  {
    const probe = toLocal(37.7643, -122.4269);
    const ids = probeRecords("mission-dolores");
    const body = centroidOf(read, "201006.0001563", probe);
    const rect = minAreaRect(body.ring);
    const east = Math.abs(((rect.bearingDeg - 90 + 540) % 360) - 180) < 90 ? rect.bearingDeg : rect.bearingDeg + 180;
    sites.push(site(read, "mission-dolores", body, east, ids));
  }

  // The Conservatory of Flowers: origin at the dome (the tower record's centroid), the front
  // facing south over the lawn: the side the wings' end pavilions project toward.
  {
    const probe = toLocal(37.7726, -122.4603);
    const ids = probeRecords("conservatory-of-flowers");
    const dome = centroidOf(read, "201006.0001537-tower", probe);
    const rect = minAreaRect(findRecord(read, "201006.0001537", probe).footprint);
    const south = Math.abs(((rect.bearingDeg + 90 - 180 + 540) % 360) - 180) < 90 ? rect.bearingDeg + 90 : rect.bearingDeg + 270;
    sites.push(site(read, "conservatory-of-flowers", dome, south, ids));
  }

  // Dragon Gate: it straddles Grant Ave just north of Bush St, its portals facing south
  // (Wikipedia; 37.7907, -122.4056 lies in Bush St itself). Origin on Grant's centreline at
  // the Bush St building line, centred between the building faces on either side; the gate
  // spans them. Grant here is one-way, 7.8 m (edge c6389000).
  {
    const grant = roads().find((e) => e.id === "c6389000");
    if (!grant) throw new Error("landmark-sites: Grant Ave edge c6389000 is missing");
    const [a, b] = [grant.points[0]!, grant.points[grant.points.length - 1]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / len; // northward along Grant
    const uz = (b[1] - a[1]) / len;
    // The building line: walk north from the junction until both sides have a wall within 8 m.
    let t = 0;
    let left = 0;
    let right = 0;
    for (t = 0; t < 40; t += 0.25) {
      const x = a[0] + ux * t;
      const z = a[1] + uz * t;
      left = rayToWall(read, x, z, uz, -ux, 12); // west side (left when facing north)
      right = rayToWall(read, x, z, -uz, ux, 12);
      if (left < 8 && right < 8) break;
    }
    const x0 = a[0] + ux * t;
    const z0 = a[1] + uz * t;
    const mid = (right - left) / 2; // shift toward the east (+right) by this much
    const cx = x0 - uz * mid;
    const cz = z0 + ux * mid;
    const heading = (Math.atan2(-ux, uz) * 180) / Math.PI; // facing south, down Grant
    const s = site(read, "dragon-gate", { x: cx, z: cz }, heading, []);
    const c = toLocal(s.lat, s.lon);
    const centreline = toModelFrame(c, s.headingDeg, x0, z0);
    s.extra = {
      spanM: r2(left + right),
      roadWidthM: grant.widthM,
      centrelineX: r2(centreline[0]),
      edge: grant.id,
    };
    addRoads(read, s, -12, 12, -12, 12);
    sites.push(s);
  }

  // Sutro Baths ruins: no footprint record. The DEM shows the old baths' basin as a flat
  // shelf at about 5 m, some 55 m wide and 95 m long north to south, below the bluff; the
  // origin is its middle, heading 0.
  {
    const p = toLocal(37.7804, -122.5137);
    const s = site(read, "sutro-baths", { x: p.x - 5, z: p.z + 40 }, 0, []);
    addGrid(read, s, 75, 2.5);
    sites.push(s);
  }

  // The Golden Gate Bridge. No street data runs onto it: Hwy 101 ends at the shore north of
  // Fort Point (the end of edges c19205000 and c19256000). The bridge's published centre,
  // 37.8197, -122.4786 (mid main span), lies 937 m from there at bearing 354.4: that is the
  // axis. With the published spans (side 343 m, main 1,280 m) the south tower stands 297 m
  // out from the road's end; the origin is its centre, at sea level, facing north.
  {
    const edges = roads();
    const nb = edges.find((e) => e.id === "c19205000");
    const sb = edges.find((e) => e.id === "c19256000");
    if (!nb || !sb) throw new Error("landmark-sites: Hwy 101 edges c19205000/c19256000 are missing");
    const e1 = nb.points[nb.points.length - 1]!;
    const e2 = sb.points[0]!;
    const ex = (e1[0] + e2[0]) / 2;
    const ez = (e1[1] + e2[1]) / 2;
    const mid = toLocal(37.8197, -122.4786);
    const bearing = (Math.atan2(mid.x - ex, -(mid.z - ez)) * 180) / Math.PI;
    const toMid = Math.hypot(mid.x - ex, mid.z - ez);
    const tower = toMid - 640;
    const s = site(read, "golden-gate-bridge", { x: ex + Math.sin(bearing * DEG) * tower, z: ez - Math.cos(bearing * DEG) * tower }, bearing, []);
    addProfile(read, s, -1000, 2000, 10);
    addRoads(read, s, -80, 80, -1700, 900);
    s.extra = { roadEndT: r2(-tower), midSpanT: 640 };
    sites.push(s);
  }

  // The Bay Bridge west span. I-80 crosses on one straight edge (c14248000, Rincon Hill to
  // Yerba Buena Island, 2,811 m). The DEM marks the piers as land along that line: towers at
  // 1,025, 1,785 and 2,495 m and the centre anchorage at 1,380-1,420 m; the fourth tower is a
  // main span (704 m, published) west of the first. Origin: mid eastern main span, sea level.
  {
    const e = roads().find((q) => q.id === "c14248000");
    if (!e) throw new Error("landmark-sites: I-80 edge c14248000 is missing");
    const [a, b] = [e.points[0]!, e.points[e.points.length - 1]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bearing = (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI;
    const at = 2140;
    const s = site(read, "bay-bridge-west", { x: a[0] + ((b[0] - a[0]) * at) / len, z: a[1] + ((b[1] - a[1]) * at) / len }, bearing, []);
    addProfile(read, s, -2300, 800, 10);
    addRoads(read, s, -80, 80, -800, 2350);
    s.extra = { edge: e.id, edgeStartT: -at, edgeEndT: r2(len - at) };
    sites.push(s);
  }

  return {
    $comment:
      "Generated by assets/blender/tools/landmark-sites.ts from public/tiles/sf (do not edit). Model frame: glTF, +y up, front -z, model = Ry(headingDeg) * (world - origin); heights relative to the sim's ground at the origin (groundY).",
    world: "sf",
    sites,
  };
}

/** JSON with one [x, z] pair per line and grid rows on one line each. */
export function formatSites(doc: SitesDoc): string {
  let text = JSON.stringify(doc, null, 2);
  text = text.replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, "[$1, $2]");
  text = text.replace(/\[\s+((?:-?[\d.e+-]+,\s+)+-?[\d.e+-]+)\s+\]/g, (_m, body: string) => `[${body.replace(/,\s+/g, ", ")}]`);
  return text + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = formatSites(buildSites(fileTileReader()));
  const out = join(REPO, SITES_FILE);
  if (process.argv.includes("--check")) {
    const old = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (old !== text) {
      console.error(`${SITES_FILE} is stale: run node assets/blender/tools/landmark-sites.ts`);
      process.exit(1);
    }
    console.log(`${SITES_FILE} is up to date`);
  } else {
    writeFileSync(out, text);
    console.log(`[fc] wrote ${SITES_FILE} (${(text.length / 1024).toFixed(0)} KiB)`);
  }
}
