// The US-101 section of Lombard St, Van Ness Ave to Richardson Ave, built from the game's own
// road graph (DataSF streets) and signal list (DataSF / SFMTA traffic signals).
// Direction 0 runs westbound (toward the Golden Gate Bridge), direction 1 eastbound.

export interface RoadsFile {
  nodes: readonly { id: string; x: number; z: number; y?: number }[];
  edges: readonly { a: string; b: string; name: string; lanes?: number; speedLimitMps?: number }[];
}
export interface SignalsFile { signals: readonly { node: string }[] }

export interface CorridorPoint { x: number; y: number; z: number }

export interface CorridorIntersection {
  node: string;
  street: string;
  /** Distance from the east end (Van Ness Ave) along the westbound path, metres. */
  s: number;
  x: number; y: number; z: number;
  /** Lanes on the cross street (from the road graph), at least 1. */
  crossLanes: number;
}

export interface Corridor {
  name: string;
  /** Points east to west (westbound order) with their distance along. */
  points: readonly (CorridorPoint & { s: number })[];
  length: number;
  lanesPerDirection: number;
  speedLimitMps: number;
  /** Signalised intersections, east to west. */
  signals: readonly CorridorIntersection[];
}

export const LOMBARD_EAST_NODE = "n26696000"; // Lombard St & Van Ness Ave
export const LOMBARD_WEST_NODE = "n27000000"; // Lombard St & Richardson Ave (US-101 turns to the Presidio)

function crossName(roads: RoadsFile, node: string, main: string): { name: string; lanes: number } {
  let name = "", lanes = 0;
  for (const e of roads.edges) {
    if ((e.a !== node && e.b !== node) || e.name.startsWith(main)) continue;
    if (!name || e.name < name) name = e.name;
    lanes = Math.max(lanes, e.lanes ?? 1);
  }
  return { name, lanes: Math.max(1, lanes) };
}

/** Build the corridor between two nodes of the named street. Throws if the road graph lacks it. */
export function buildCorridor(roads: RoadsFile, signals: SignalsFile, street = "Lombard St", east = LOMBARD_EAST_NODE, west = LOMBARD_WEST_NODE): Corridor {
  const nodes = new Map(roads.nodes.map((n) => [n.id, n]));
  const ends = [nodes.get(east), nodes.get(west)];
  if (!ends[0] || !ends[1]) throw new Error(`corridor ends ${east}/${west} are not in the road graph`);
  const onStreet = new Set<string>();
  let lanes = 1, speed = 11.2;
  for (const e of roads.edges) {
    if (!e.name.startsWith(street)) continue;
    onStreet.add(e.a); onStreet.add(e.b);
  }
  // Lombard runs close to east-west here: order its nodes by x between the two ends.
  const x0 = ends[1].x, x1 = ends[0].x;
  const chain = [...onStreet].map((id) => nodes.get(id)!).filter((n) => n && n.x >= x0 - 0.01 && n.x <= x1 + 0.01)
    .sort((p, q) => q.x - p.x || p.id.localeCompare(q.id));
  const inChain = new Set(chain.map((n) => n.id));
  for (const e of roads.edges) {
    if (e.name.startsWith(street) && inChain.has(e.a) && inChain.has(e.b)) {
      lanes = Math.max(lanes, e.lanes ?? 1);
      speed = e.speedLimitMps ?? speed;
    }
  }
  let s = 0;
  const points = chain.map((n, i) => {
    if (i > 0) { const p = chain[i - 1]!; s += Math.hypot(n.x - p.x, n.z - p.z); }
    return { x: n.x, y: n.y ?? 0, z: n.z, s };
  });
  const signalled = new Set(signals.signals.map((g) => g.node));
  const sigs: CorridorIntersection[] = [];
  chain.forEach((n, i) => {
    if (!signalled.has(n.id)) return;
    const c = crossName(roads, n.id, street);
    sigs.push({ node: n.id, street: c.name, s: points[i]!.s, x: n.x, y: n.y ?? 0, z: n.z, crossLanes: c.lanes });
  });
  return { name: `US-101 on ${street}`, points, length: s, lanesPerDirection: lanes, speedLimitMps: speed, signals: sigs };
}

/** Position and compass heading (radians, clockwise from north) at distance s along the westbound path. */
export function pointAt(c: Corridor, s: number): { x: number; y: number; z: number; heading: number } {
  const pts = c.points;
  const t = Math.max(0, Math.min(c.length, s));
  let i = 1;
  while (i < pts.length - 1 && pts[i]!.s < t) i++;
  const a = pts[i - 1]!, b = pts[i]!;
  const span = Math.max(1e-6, b.s - a.s), f = (t - a.s) / span;
  const dx = b.x - a.x, dz = b.z - a.z;
  return { x: a.x + dx * f, y: a.y + (b.y - a.y) * f, z: a.z + dz * f, heading: Math.atan2(dx, -dz) };
}
