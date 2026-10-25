// Street incidents (v11 city life): the Ambient Director (src/sim/activities/system.ts) picks a
// card for a player and emits `director.stage`; this module stages it for real, a short walk from
// the player: the card's robots (a bad Footman next to good ones, a Trundle squatting on a
// crosswalk, two empty robotaxis nose to nose in one lane), placed clear of every body and of
// protected areas, as significant runtime actors the brains, combat and bounties already handle.
// Each staged incident is listed (AgentsRuntimeState.incidents) so the map can show it.
//
// Pure: placement reads only the previous state and the world; ids come from the core allocator.

import type { DirectorCard } from "../../content/directorCards.ts";
import type { MissionActor } from "../../content/missions.ts";
import { BOT_TELLS } from "../../content/botTells.ts";
import type { SimState } from "../contract.ts";
import { datan2, dcos, dsin } from "../dmath.ts";
import { pathPoint, projectOnPath } from "../roads.ts";
import { ROBOTAXI_BODY } from "../agents.ts";
import { nearestDrivableLane } from "../vehicles/follower.ts";
import { circleBlocked, groundHeight, type World } from "../world.ts";
import { lanePath } from "../roads.ts";
import { planMissionActors, type ActorBlueprint } from "./mission-actors.ts";
import { serviceBlockersOf, serviceEntryClear, type ServiceBlocker } from "./service-runtime.ts";
import type { SidewalkGraph } from "./navigation.ts";
import type { RuntimeSpawn } from "./runtime.ts";

/** A staged incident, for the map and for its own clean-up. */
export interface Incident {
  id: string;
  cardId: string;
  playerId: string;
  tick: number;
  x: number;
  z: number;
  /** Runtime actor ids of its robots (bad ones first). */
  actorIds: string[];
  /** The bad ones: the bounty targets. */
  targetIds: string[];
}

/** One `director.stage` request: which card, for whom. */
export interface StageRequest { playerId: string; cardId: string; tick: number }

/** The director's stage requests in the state's activity events (emitted on the previous tick). */
export function stageRequests(state: Readonly<SimState>): StageRequest[] {
  const events = (state.ext.activities as { events?: unknown } | undefined)?.events;
  if (!Array.isArray(events)) return [];
  const out: StageRequest[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { kind?: unknown; playerId?: unknown; targetId?: unknown; tick?: unknown };
    if (e.kind === "director.stage" && typeof e.playerId === "string" && typeof e.targetId === "string" && typeof e.tick === "number") out.push({ playerId: e.playerId, cardId: e.targetId, tick: e.tick });
  }
  return out.sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
}

function hashText(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

const STAGEABLE = new Set(["badRobot", "goodRobot", "rogueTaxi", "goodTaxi"]);
const distance = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));

/**
 * Where to stage a card for a player at `body`: a sidewalk node (a crosswalk's middle for a card
 * that wants one) between `range` metres of them, preferring ahead of them and the middle of the
 * range, ties broken by a hash of the request. Never inside a protected area when the card has a
 * bad robot (`allowed`). Null when the graph has nothing in range.
 */
export function incidentPlace(graph: SidewalkGraph, card: DirectorCard, body: { x: number; z: number; heading: number }, range: readonly [number, number], key: string, allowed: (x: number, z: number) => boolean): { x: number; z: number } | null {
  const hx = dsin(body.heading), hz = -dcos(body.heading);
  const crosswalk = card.when.near.includes("crosswalk");
  const points: Array<{ x: number; z: number; id: string }> = [];
  if (crosswalk) {
    for (const e of graph.edges) {
      if (e.kind !== "crosswalk") continue;
      const m = pathPoint(e.path, e.path.len / 2);
      points.push({ x: m.x, z: m.z, id: e.id });
    }
  } else for (const n of graph.nodes) points.push({ x: n.x, z: n.z, id: n.id });
  const mid = (range[0] + range[1]) / 2;
  let best: { x: number; z: number } | null = null, score = Infinity;
  for (const p of points) {
    const d = distance(p, body);
    if (d < range[0] || d > range[1] || !allowed(p.x, p.z)) continue;
    const ahead = ((p.x - body.x) * hx + (p.z - body.z) * hz) / Math.max(d, 1e-6);
    const s = Math.abs(d - mid) + (ahead < 0.2 ? 40 : 0) + (hashText(`${key}:${p.id}`) % 1000) / 100;
    if (s < score) { score = s; best = { x: p.x, z: p.z }; }
  }
  return best;
}

/**
 * Two empty robotaxis nose to nose in one lane near `place`: the nearest drivable lane, one
 * facing along it and one facing back at it 1 m apart, both clear. Null when they do not fit.
 */
function standoff(world: World, sim: Readonly<SimState>, place: { x: number; z: number }, aliases: readonly [string, string], reserved: readonly ServiceBlocker[]): Array<{ alias: string; x: number; z: number; heading: number }> | null {
  const g = world.roads;
  if (!g) return null;
  const lane = nearestDrivableLane(g, place);
  if (!lane || lane.distance > 30) return null;
  const path = lanePath(g.edges[lane.edge]!, lane.dir, 0);
  const gap = 2 * ROBOTAXI_BODY.halfLength + 1;
  const others = serviceBlockersOf(sim, reserved);
  for (const shift of [0, 6, -6, 12, -12]) {
    const s = projectOnPath(path, place.x, place.z).s + shift;
    if (s < ROBOTAXI_BODY.halfLength + 2 || s + gap > path.len - ROBOTAXI_BODY.halfLength - 2) continue;
    const a = pathPoint(path, s), b = pathPoint(path, s + gap);
    const ha = datan2(a.tx, -a.tz), hb = datan2(-b.tx, b.tz);
    const first = { x: a.x, z: a.z, heading: ha }, second = { x: b.x, z: b.z, heading: hb };
    if (!serviceEntryClear(world, first, others, ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth, ROBOTAXI_BODY.height)) continue;
    const withFirst: ServiceBlocker[] = [...others, { ...first, halfLength: ROBOTAXI_BODY.halfLength, halfWidth: ROBOTAXI_BODY.halfWidth }];
    if (!serviceEntryClear(world, second, withFirst, ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth, ROBOTAXI_BODY.height)) continue;
    return [{ alias: aliases[0], ...first }, { alias: aliases[1], ...second }];
  }
  return null;
}

/**
 * The robots of `card` staged at `place` for player `playerId` (incident number `n`): runtime
 * actor blueprints `incident:<n>:<actor id>`, significant (they never quietly despawn while near
 * anyone), stationary where the card parks them (taxis, a squatting Trundle). Empty when nothing
 * fits.
 */
export function planIncident(world: World, sim: Readonly<SimState>, card: DirectorCard, n: number, playerId: string, place: { x: number; z: number }, graph: SidewalkGraph | undefined,
  allowed: (x: number, z: number) => boolean, reserved: readonly Pick<RuntimeSpawn, "x" | "z" | "radius">[]): ActorBlueprint[] {
  const actors = card.actors.filter((a) => STAGEABLE.has(a.kind));
  if (!actors.length) return [];
  const id = (alias: string) => `incident:${n}:${alias}`;
  const parked = new Set(card.beats.filter((b) => b.do === "parkAcross" || b.do === "stall" || b.do === "stuck").map((b) => b.actor ?? ""));
  const reservedBodies: ServiceBlocker[] = reserved.map((r) => ({ x: r.x, z: r.z, radius: r.radius }));
  const taxis = actors.filter((a) => a.kind === "rogueTaxi" || a.kind === "goodTaxi");
  if (taxis.length === 2 && actors.length === 2) {
    const pair = standoff(world, sim, place, [taxis[0]!.id, taxis[1]!.id], reservedBodies);
    if (!pair || !pair.every((p) => allowed(p.x, p.z))) return [];
    return pair.map((p) => ({ id: id(p.alias), ownerId: playerId, model: "robotaxi" as const, archetype: "rogueTaxi", level: 1, firmware: "bad" as const, x: p.x, y: groundHeight(world, p.x, p.z), z: p.z, heading: p.heading,
      radius: 1.1, height: ROBOTAXI_BODY.height, halfLength: ROBOTAXI_BODY.halfLength, halfWidth: ROBOTAXI_BODY.halfWidth, significant: true, posted: true }));
  }
  if (actors.length === 1 && parked.has(actors[0]!.id) && card.when.near.includes("crosswalk")) {
    // Squatting on the crosswalk itself: exactly at the place, or not at all.
    const a = actors[0]!, profile = BOT_TELLS.archetypes.find((x) => x.id === a.archetype);
    const trundle = profile?.model === "sidewalk-bot", radius = trundle ? 0.35 : 0.4;
    const clear = allowed(place.x, place.z) && !circleBlocked(world, place.x, place.z, radius) && serviceBlockersOf(sim, reservedBodies).every((b) => b.halfLength !== undefined
      ? distance(b, place) > b.halfLength + radius + 1
      : distance(b, place) > (b.radius ?? 0.4) + radius + 0.5);
    if (!clear) return [];
    return [{ id: id(a.id), ownerId: playerId, model: trundle ? "trundle" : "footman", ...(a.archetype ? { archetype: a.archetype } : {}), ...(a.level ? { level: a.level } : {}), firmware: a.kind === "badRobot" ? "bad" : "good",
      x: place.x, y: groundHeight(world, place.x, place.z), z: place.z, heading: 0, radius, height: trundle ? 0.7 : 1.8, significant: true, posted: true }];
  }
  const definitions: Record<string, MissionActor> = {};
  for (const a of actors) definitions[a.id] = { kind: a.kind as MissionActor["kind"], ...(a.archetype ? { archetype: a.archetype } : {}), ...(a.level ? { level: a.level } : {}), ...(parked.has(a.id) ? { posted: true } : {}) };
  const plan = planMissionActors(world, sim, { missionId: `incident-${n}`, stepId: "staged", actorIds: actors.map((a) => a.id), definitions, place: { x: place.x, y: groundHeight(world, place.x, place.z), z: place.z }, radius: 24 },
    graph, allowed, reservedBodies);
  if (plan.blocked.length) return [];
  return plan.actors.map((a) => {
    const alias = a.id.slice(`mission:incident-${n}:`.length);
    return { ...a, id: id(alias), ownerId: playerId, ...(parked.has(alias) ? { posted: true } : {}) };
  });
}
