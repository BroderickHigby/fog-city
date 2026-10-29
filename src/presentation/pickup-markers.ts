// Where a pickup or drop waits, as the renderer draws it: the ring is the sim's own stop rule
// (its centre and radius), the waiting person stands inside it, and the dwell shows as progress.
// Presentation only: reads Runway Run (ext.runway) and the taxi shift (SfTaxiSession), writes nothing.
import type { SimState } from "../sim/contract.ts";
import { activeBody } from "../sim/step.ts";
import { pathPoint, projectOnPath, type RoadGraph } from "../sim/roads.ts";
import { RUNWAY_RULES, isDriving, runwayOf, stopRadiusFor } from "../sim/runway-run/index.ts";
import { taxiView } from "../sim/modes/taxi.ts";
import type { SfTaxiSession } from "../modes/taxi-session.ts";

/** investor and fare: a person waits; demo and dropoff: the ring and beacon only. */
export type PickupKind = "investor" | "demo" | "fare" | "dropoff";

export interface PickupPerson {
  x: number;
  y: number;
  z: number;
  /** The sim's own body for this person (the taxi passenger), drawn by this marker instead of the crowd. */
  agentId: number | null;
  /** Compass heading they face while no car is near (toward the road). */
  rest: number;
}

export interface PickupMarker {
  /** Stable while this stop waits; a new key is a new pickup or drop. */
  key: string;
  kind: PickupKind;
  /** The rule's centre: where the car must stop. */
  x: number;
  /** The sim's ground height there (the renderer settles it on the drawn surface). */
  y: number;
  z: number;
  /** The rule's radius, metres: the ring's outer edge. */
  radiusM: number;
  person: PickupPerson | null;
  /** The car is inside the radius and slow enough: the dwell is counting. */
  inside: boolean;
  /** The dwell so far, 0 .. 1 (1: done, or press Interact for a taxi). */
  progress: number;
}

/** The investor stands this far to the right of the lane's centre: inside a 2.3 m ring, clear of a car in the lane. */
export const INVESTOR_SIDE_M = 1.6;

const laneFrames = new WeakMap<RoadGraph, Map<string, { tx: number; tz: number }>>();

/** The travel direction of the lane nearest (x, z) (unit vector), or null without a lane near. */
export function laneDirectionAt(graph: RoadGraph, x: number, z: number): { tx: number; tz: number } | null {
  let cache = laneFrames.get(graph);
  if (!cache) { cache = new Map(); laneFrames.set(graph, cache); }
  const key = `${x},${z}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let best: { tx: number; tz: number } | null = null, bestD = 6;
  for (const e of graph.edges) {
    if (!e.drivable) continue;
    const mid = pathPoint(e.center, e.center.len / 2);
    if (Math.hypot(mid.x - x, mid.z - z) - e.center.len / 2 - e.widthM > bestD) continue;
    for (const lanes of e.lanePaths) for (const path of lanes) {
      const p = projectOnPath(path, x, z);
      if (p.dist >= bestD) continue;
      const at = pathPoint(path, p.s);
      const len = Math.hypot(at.tx, at.tz) || 1;
      best = { tx: at.tx / len, tz: at.tz / len };
      bestD = p.dist;
    }
  }
  if (best) { if (cache.size > 64) cache.clear(); cache.set(key, best); }
  return best;
}

/** A person beside the lane point (x, z): on the lane's right (+x east, +z south: right of (tx, tz) is (-tz, tx)), facing the lane. */
export function besideLane(graph: RoadGraph | null, x: number, z: number, side: number): { x: number; z: number; rest: number } {
  const dir = graph ? laneDirectionAt(graph, x, z) : null;
  if (!dir) return { x: x + side, z, rest: -Math.PI / 2 };
  const rx = -dir.tz, rz = dir.tx;
  // Facing back toward the lane's centre (a compass bearing of the vector -right).
  return { x: x + rx * side, z: z + rz * side, rest: Math.atan2(-rx, rz) };
}

/** Runway Run's investor or demo for this player, if a run is under way. */
/** The sim's ground height at (x, z); the default reads the player's car height. */
export type GroundHeight = (x: number, z: number) => number;

export function runwayPickups(state: Readonly<SimState>, playerId: string, graph: RoadGraph | null, ground?: GroundHeight): PickupMarker[] {
  const run = runwayOf(state)?.runs[playerId];
  const player = state.players[playerId];
  if (!run || run.phase !== "running" || !run.target || !player) return [];
  const radiusM = stopRadiusFor(state.version);
  const t = run.target;
  const h = (x: number, z: number): number => ground ? ground(x, z) : activeBody(player).y;
  const progress = Math.max(0, Math.min(1, run.hold / RUNWAY_RULES.stopHoldTicks));
  const inside = run.hold > 0 && isDriving(player);
  if (run.carrying) return [{ key: `runway:${playerId}:demo:${t.x},${t.z}`, kind: "demo", x: t.x, y: h(t.x, t.z), z: t.z, radiusM, person: null, inside, progress }];
  const spot = besideLane(graph, t.x, t.z, Math.min(INVESTOR_SIDE_M, radiusM * 0.7));
  return [{ key: `runway:${playerId}:investor:${run.investor}:${t.x},${t.z}`, kind: "investor", x: t.x, y: h(t.x, t.z), z: t.z, radiusM,
    person: { x: spot.x, y: h(spot.x, spot.z), z: spot.z, agentId: null, rest: spot.rest }, inside, progress }];
}

/** The taxi shift's waiting passenger or drop-off. */
export function taxiPickups(session: Readonly<SfTaxiSession> | null): PickupMarker[] {
  if (!session || session.restored) return [];
  const taxi = session.taxi;
  const phase = taxi.phase === "blocked" ? taxi.trip.resumePhase : taxi.phase;
  if (phase !== "pickup" && phase !== "driving") return [];
  const view = taxiView(taxi, session.config);
  const stop = view.target;
  if (!stop) return [];
  const progress = view.stopRequiredTicks > 0 ? Math.max(0, Math.min(1, view.stopTicks / view.stopRequiredTicks)) : 0;
  const inside = view.stopTicks > 0;
  if (phase === "driving") return [{ key: `taxi:${taxi.trip.id}:dropoff`, kind: "dropoff", x: stop.x, y: stop.y, z: stop.z, radiusM: stop.radiusM, person: null, inside, progress }];
  const road = session.catalog.roads.find((r) => r.id === taxi.trip.routeId);
  const curb = road ? session.catalog.curbs.find((c) => c.id === road.pickup) : undefined;
  const body = (session.instance.ext.agents?.list ?? []).find((a) => a.runtimeId === taxi.trip.passengerId && a.kind === "person");
  const at = body ?? curb?.passenger;
  // The curb's heading is the lane's; the passenger looks across it, toward the road (to their left of travel).
  const rest = curb ? curb.heading - Math.PI / 2 : 0;
  return [{ key: `taxi:${taxi.trip.id}:pickup`, kind: "fare", x: stop.x, y: stop.y, z: stop.z, radiusM: stop.radiusM,
    person: at ? { x: at.x, y: at.y, z: at.z, agentId: body ? body.id : null, rest } : null, inside, progress }];
}

/** Every marker this player sees now: the taxi shift's while one runs, else Runway Run's. */
export function pickupMarkers(state: Readonly<SimState>, playerId: string, graph: RoadGraph | null, taxi: Readonly<SfTaxiSession> | null, ground?: GroundHeight): PickupMarker[] {
  return taxi ? taxiPickups(taxi) : runwayPickups(state, playerId, graph, ground);
}

/** The car the player drives (or null on foot): where a boarding person walks. */
export function playerCar(state: Readonly<SimState>, playerId: string): { x: number; y: number; z: number; heading: number; speed: number } | null {
  const p = state.players[playerId];
  if (!p || p.mode !== "vehicle") return null;
  const b = activeBody(p);
  return { x: b.x, y: b.y, z: b.z, heading: b.heading, speed: b.speed };
}
