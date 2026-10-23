// A compact, deterministic index over the existing city layers. Geometry stays in its
// original files; tile consumers fetch only these IDs, including complete crossing edges.
import { createHash } from "node:crypto";
import type { TileRef } from "./config.ts";
import { DistrictIndex, type District } from "./districts.ts";
import { EdgeIndex, type Fountain, type Hydrant, type Signal, type TransitRoute, type TransitStop } from "./gameplay.ts";
import { clipSegment, r2, type P2 } from "./geom.ts";
import type { RoadGraph } from "./roads.ts";
import type { ShoreLine } from "./boundary.ts";
import type { SidewalkGraph } from "./sidewalks.ts";

export interface GameplayRefill {
  id: string; kind: "hydrant" | "fountain" | "bay";
  x: number; y: number; z: number; radius: number; salt: boolean;
}
export interface GameplayAnchor {
  id: string; kind: "car-wash" | "repair-kiosk" | "garage-candidate" | "activity-candidate";
  x: number; y: number; z: number; roadNodeId: string; districtId: string;
}
export interface GameplayTile {
  id: string; sidewalkNodes: string[]; sidewalkEdges: string[]; refills: string[];
  anchors: string[]; signals: string[]; transitStops: string[]; transitRoutes: string[];
}
export interface GameplayIndex {
  version: 1; world: string; sourceSnapshot: string;
  refills: GameplayRefill[]; anchors: GameplayAnchor[]; tiles: GameplayTile[];
  territories: Array<{ step: string; wave: number; districtIds: string[]; tileIds: string[] }>;
}
export interface GameplayInput {
  world: string; sourceSnapshot: string; tiles: readonly TileRef[]; tileSizeM: number;
  walk: SidewalkGraph; roads: RoadGraph; districts: District[];
  hydrants: readonly Hydrant[]; fountains: readonly Fountain[]; signals: readonly Signal[];
  transit: { routes: TransitRoute[]; stops: TransitStop[] }; shore: readonly ShoreLine[];
  isLand: (x: number, z: number) => boolean;
  heightAt: (x: number, z: number) => number | null;
  roadClearance: (x: number, z: number) => number;
}

const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const idFor = (prefix: string, value: string): string => `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
const finite = (x: number, z: number): boolean => Number.isFinite(x) && Number.isFinite(z);
const unique = (values: string[]): string[] => [...new Set(values)].sort(cmp);

// Analysis Neighborhoods are geometry, not mission activation. Several game districts
// share one polygon (e.g. FiDi/Rincon Hill). These rows never activate content early.
const TERRITORIES: Array<[string, number, string[]]> = [
  ["1", 1, ["financial-district-south-beach"]],
  ["2", 1, ["north-beach", "marina", "potrero-hill"]],
  ["3", 2, ["south-of-market", "mission-bay", "financial-district-south-beach"]],
  ["4", 3, ["russian-hill", "nob-hill", "chinatown", "north-beach"]],
  ["5", 4, ["presidio", "pacific-heights", "presidio-heights", "marina"]],
  ["6", 5, ["hayes-valley", "tenderloin", "western-addition", "japantown", "haight-ashbury"]],
  ["7", 6, ["mission", "castro-upper-market", "noe-valley", "twin-peaks"]],
  ["8", 7, ["golden-gate-park", "inner-richmond", "outer-richmond", "inner-sunset", "sunset-parkside", "lincoln-park", "seacliff", "lone-mountain-usf"]],
  ["9a", 6, ["potrero-hill", "bernal-heights", "bayview-hunters-point"]],
  ["9b", 8, ["excelsior", "glen-park", "lakeshore", "oceanview-merced-ingleside", "outer-mission", "portola", "mclaren-park", "visitacion-valley", "west-of-twin-peaks", "treasure-island"]],
];

export function buildGameplayIndex(input: GameplayInput): GameplayIndex {
  const { tileSizeM: size, walk } = input;
  if (!Number.isFinite(size) || size <= 0) throw new Error("gameplay: invalid tile size");
  const tiles = new Map<string, GameplayTile>();
  for (const t of [...input.tiles].sort((a, b) => cmp(a.id, b.id))) {
    if (tiles.has(t.id)) throw new Error(`gameplay: duplicate tile ${t.id}`);
    tiles.set(t.id, { id: t.id, sidewalkNodes: [], sidewalkEdges: [], refills: [], anchors: [], signals: [], transitStops: [], transitRoutes: [] });
  }
  const tileAt = (x: number, z: number): GameplayTile | undefined => tiles.get(`t${Math.floor(x / size)}_${Math.floor(z / size)}`);
  const nodes = new Map(walk.nodes.map((n) => [n.id, n]));
  if (nodes.size !== walk.nodes.length) throw new Error("gameplay: duplicate sidewalk node");
  for (const n of walk.nodes) {
    if (!finite(n.x, n.z) || !Number.isFinite(n.y)) throw new Error(`gameplay: invalid sidewalk node ${n.id}`);
    tileAt(n.x, n.z)?.sidewalkNodes.push(n.id);
  }
  const indexLine = (points: readonly P2[], visit: (tile: GameplayTile) => void): void => {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      if (!finite(...a) || !finite(...b)) throw new Error("gameplay: invalid line coordinate");
      for (let ix = Math.floor(Math.min(a[0], b[0]) / size); ix <= Math.floor(Math.max(a[0], b[0]) / size); ix++) {
        for (let iz = Math.floor(Math.min(a[1], b[1]) / size); iz <= Math.floor(Math.max(a[1], b[1]) / size); iz++) {
          const t = tiles.get(`t${ix}_${iz}`);
          if (t && clipSegment(a, b, [ix * size, iz * size, (ix + 1) * size, (iz + 1) * size])) visit(t);
        }
      }
    }
  };
  const edgeIds = new Set<string>();
  for (const e of walk.edges) {
    if (edgeIds.has(e.id)) throw new Error(`gameplay: duplicate sidewalk edge ${e.id}`);
    edgeIds.add(e.id);
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (!a || !b) throw new Error(`gameplay: missing sidewalk endpoint ${e.id}`);
    indexLine([[a.x, a.z], ...(e.points ?? []), [b.x, b.z]], (t) => {
      t.sidewalkEdges.push(e.id);
      // An edge can cross a tile without either endpoint being inside it.
      t.sidewalkNodes.push(e.a, e.b);
    });
  }
  for (const s of input.signals) tileAt(s.x, s.z)?.signals.push(s.node);
  for (const s of input.transit.stops) tileAt(s.x, s.z)?.transitStops.push(s.id);
  for (const r of input.transit.routes) for (const path of r.paths) indexLine(path, (t) => t.transitRoutes.push(r.id));

  const refills: GameplayRefill[] = [];
  const safe = (x: number, z: number): boolean => finite(x, z) && !!tileAt(x, z) && input.isLand(x, z) && Number.isFinite(input.heightAt(x, z));
  for (const [kind, points] of [["hydrant", input.hydrants], ["fountain", input.fountains]] as const) {
    for (const p of points) {
      if (!safe(p.x, p.z) || input.roadClearance(p.x, p.z) < 0.5) continue;
      refills.push({ id: p.id, kind, x: p.x, y: r2(input.heightAt(p.x, p.z)!), z: p.z, radius: 3, salt: false });
    }
  }
  // Sample reachable low shore only. Test both sides against the collider ground mask;
  // this handles orientation and avoids placing refill interactions in open water/cliffs.
  const bayCells = new Set<string>();
  for (const line of input.shore) {
    const points = line.closed ? [...line.points, line.points[0]!] : line.points;
    let next = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
      if (length === 0) continue;
      for (; next <= length; next += 100) {
        const x = a[0] + dx * next / length, z = a[1] + dz * next / length;
        let placed = false;
        for (const offset of [2, 4, 8]) {
          for (const side of [-1, 1]) {
            const px = r2(x + side * dz / length * offset), pz = r2(z - side * dx / length * offset);
            const y = input.heightAt(px, pz);
            const cell = `${Math.floor(px / 50)},${Math.floor(pz / 50)}`;
            if (bayCells.has(cell) || !safe(px, pz) || y! > 3.5 || input.roadClearance(px, pz) < 0.5) continue;
            bayCells.add(cell);
            refills.push({ id: idFor("bay", `${px},${pz}`), kind: "bay", x: px, y: r2(y!), z: pz, radius: 3, salt: true });
            placed = true;
            break;
          }
          if (placed) break;
        }
      }
      next -= length;
    }
  }
  refills.sort((a, b) => cmp(a.id, b.id));
  if (new Set(refills.map((r) => r.id)).size !== refills.length) throw new Error("gameplay: duplicate refill ID");
  for (const r of refills) tileAt(r.x, r.z)!.refills.push(r.id);

  const districtIndex = new DistrictIndex(input.districts);
  const roadIndex = new EdgeIndex(input.roads.edges.filter((e) => !e.pedestrian && e.kind !== "freeway" && e.kind !== "ramp"));
  const roadNodes = new Map(input.roads.nodes.map((n) => [n.id, n]));
  const candidates: Array<Omit<GameplayAnchor, "id" | "kind"> & { node: string }> = [];
  for (const n of [...walk.nodes].sort((a, b) => cmp(a.id, b.id))) {
    if (!safe(n.x, n.z) || input.roadClearance(n.x, n.z) < 1) continue;
    const district = districtIndex.at(n.x, n.z);
    const road = roadIndex.nearest(n.x, n.z, 30)?.e;
    if (!district || !road) continue;
    const a = roadNodes.get(road.a), b = roadNodes.get(road.b);
    if (!a || !b) continue;
    const nearest = Math.hypot(n.x - a.x, n.z - a.z) <= Math.hypot(n.x - b.x, n.z - b.z) ? a : b;
    candidates.push({ node: n.id, x: n.x, y: r2(input.heightAt(n.x, n.z)!), z: n.z, roadNodeId: nearest.id, districtId: district.id });
  }
  const anchors: GameplayAnchor[] = [];
  for (const [kind, spacing] of [["garage-candidate", 650], ["repair-kiosk", 900], ["car-wash", 1200], ["activity-candidate", 1200]] as const) {
    const selected: typeof candidates = [];
    for (const c of candidates) {
      if (selected.some((s) => s.districtId === c.districtId && Math.hypot(s.x - c.x, s.z - c.z) < spacing)) continue;
      selected.push(c);
      const { node, ...point } = c;
      anchors.push({ id: idFor(kind, node), kind, ...point });
    }
  }
  anchors.sort((a, b) => cmp(a.id, b.id));
  for (const a of anchors) tileAt(a.x, a.z)!.anchors.push(a.id);
  for (const t of tiles.values()) {
    for (const key of ["sidewalkNodes", "sidewalkEdges", "refills", "anchors", "signals", "transitStops", "transitRoutes"] as const) t[key] = unique(t[key]);
  }
  const districts = new Map(input.districts.map((d) => [d.id, d]));
  const territories = (input.world === "sf" ? TERRITORIES : []).map(([step, wave, ids]) => {
    const districtIds = ids.filter((id) => districts.has(id)).sort(cmp);
    return { step, wave, districtIds, tileIds: unique(districtIds.flatMap((id) => districts.get(id)!.tiles).filter((id) => tiles.has(id))) };
  });
  return { version: 1, world: input.world, sourceSnapshot: input.sourceSnapshot, refills, anchors, tiles: [...tiles.values()], territories };
}
