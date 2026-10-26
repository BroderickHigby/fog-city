// Robotaxi rides (v12): walk up to an empty, stopped robotaxi and press F to hop in the back.
// The taxi stays an ambient agent (agents.ts) under every robotaxi rule (berths, yielding,
// the dodge); its rider only lends it a goal and asks it to stop. The rider's own car stays
// parked and solid where it was left. PlayerState.ride mirrors the taxi's pose so cameras,
// HUDs, missions and AI place the player in the taxi. step.ts boards and lets riders out.
//
// docs/design.md, "Robotaxis and riders": a robotaxi with anyone aboard never turns rogue,
// never reaches rust 0.3 and never seizes: when water reaches it, it pulls over and the rider
// steps out first (combat/effects.ts marks it `occupied`; step.ts lets the rider out on its
// pull-over). Rogue robotaxis are always empty: nobody boards one.

import { isCivilianTraffic } from "./civilian-traffic.ts";
import { sortedIds, type PlayerRide, type PlayerState, type SimState } from "./contract.ts";
import { AGENTS_EXT_KEY, ROBOTAXI_BODY, type AgentState, type AgentsExt } from "./agents.ts";
import { dcos, dsin } from "./dmath.ts";
import { FOOT } from "./foot.ts";
import { segmentBlocked, type World } from "./world.ts";

export const RIDE = {
  /** Board from within this distance of the taxi's body, metres (as for the player's own car). */
  boardRange: FOOT.enterRange,
  /** Only a taxi slower than this (m/s) can be boarded: nobody jumps into a moving car. */
  boardSpeed: 1.5,
  /** Within this distance of the goal the taxi stops and the rider gets out, metres. */
  arrive: 25,
  /** The rider steps out once the taxi is slower than this, m/s. */
  exitSpeed: 0.05,
  /** F on foot with no taxi in reach hails the nearest empty one within this distance, metres. */
  hailRange: 20,
  /** A hailed taxi waits this many ticks (10 s) for its passenger. */
  hailTicks: 600,
} as const;

/** The event a rider's destination arrives as (recorded with its tick; payload { x, z }). */
export const RIDE_DESTINATION_EVENT = "ride.destination";

/** The body other systems should place a player at: the taxi while riding, else the walker or car. */
export function playerPose(p: Readonly<PlayerState>): { x: number; y: number; z: number; heading: number; speed: number } {
  if (p.ride) return p.ride;
  return p.mode === "foot" && p.foot ? p.foot : p.car;
}

/** Every ridden taxi's ride, by agent id (riders in player-id order; one rider per taxi). */
export function ridesByAgent(state: Readonly<SimState>): Map<number, Readonly<PlayerRide> & { playerId: string }> {
  const out = new Map<number, Readonly<PlayerRide> & { playerId: string }>();
  for (const id of sortedIds(state.players)) {
    const ride = state.players[id]!.ride;
    if (ride && !out.has(ride.agentId)) out.set(ride.agentId, { ...ride, playerId: id });
  }
  return out;
}

/** Distance from (x, z) to a robotaxi's body rectangle (0 inside). */
export function distanceToTaxi(a: Readonly<Pick<AgentState, "x" | "z" | "heading" | "halfLength" | "halfWidth">>, x: number, z: number): number {
  const fx = dsin(a.heading);
  const fz = -dcos(a.heading);
  const ox = x - a.x;
  const oz = z - a.z;
  const l = ox * -fz + oz * fx;
  const f = ox * fx + oz * fz;
  const dl = Math.max(0, (l < 0 ? -l : l) - (a.halfWidth ?? ROBOTAXI_BODY.halfWidth));
  const df = Math.max(0, (f < 0 ? -f : f) - (a.halfLength ?? ROBOTAXI_BODY.halfLength));
  return Math.sqrt(dl * dl + df * df);
}

interface RuntimeRow { legacyId?: number | null; firmware?: string; retired?: boolean }

/**
 * Is this robotaxi bad (a rogue), disabled or rusting? Read from the agents runtime and combat:
 * nobody boards a rogue, a pulled-over or a disabled taxi.
 */
function unfit(state: Readonly<SimState>, a: Readonly<AgentState>): boolean {
  const target = state.ext.combat?.targets[`agent:${a.id}`];
  if (target && (target.phase !== "active" || target.pullOverTick > state.tick || target.rust >= 0.3)) return true;
  const runtime = state.ext.robots as { actors?: Record<string, RuntimeRow> } | undefined;
  const actors = runtime?.actors;
  if (!actors) return false;
  for (const key of Object.keys(actors).sort()) {
    const row = actors[key]!;
    if (row.legacyId === a.id && !row.retired && row.firmware === "bad") return true;
  }
  return false;
}

/**
 * The robotaxi a walker at (x, z) can hop into, or null: an ambient robotaxi (not a runtime
 * proxy or a service vehicle), empty, stopped or nearly, fit, within RIDE.boardRange of its body
 * with no building in between. The nearest wins (then the lowest id).
 */
export function boardableTaxi(world: World, state: Readonly<SimState>, x: number, z: number): AgentState | null {
  const list = (state.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
  const ridden = ridesByAgent(state);
  let best: AgentState | null = null;
  let bestD = Infinity;
  for (const a of list) {
    if (isCivilianTraffic(a) || a.kind !== "robotaxi" || a.runtimeId !== undefined || a.vehicle !== undefined || a.dodge !== null) continue;
    if (ridden.has(a.id) || Math.abs(a.speed) > RIDE.boardSpeed) continue;
    const d = distanceToTaxi(a, x, z);
    if (d > RIDE.boardRange || d >= bestD) continue;
    if (segmentBlocked(world, x, z, a.x, a.z) || unfit(state, a)) continue;
    best = a;
    bestD = d;
  }
  return best;
}

/** Every hailed taxi's waiting deadline, by agent id, as of `state` (expired hails left out). */
export function hailsByAgent(state: Readonly<SimState>): Map<number, number> {
  const out = new Map<number, number>();
  for (const id of sortedIds(state.players)) {
    const hail = state.players[id]!.hail;
    if (hail && hail.untilTick > state.tick && !out.has(hail.agentId)) out.set(hail.agentId, hail.untilTick);
  }
  return out;
}

/**
 * The robotaxi a walker at (x, z) can hail (F with none in reach): an ambient robotaxi, empty,
 * fit, within RIDE.hailRange with nothing in between, not already hailed by someone else; the
 * nearest (then the lowest id). Moving is fine: it pulls up.
 */
export function hailableTaxi(world: World, state: Readonly<SimState>, x: number, z: number, self: string): AgentState | null {
  const list = (state.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
  const ridden = ridesByAgent(state);
  const hailed = hailsByAgent(state);
  let best: AgentState | null = null;
  let bestD = Infinity;
  for (const a of list) {
    if (isCivilianTraffic(a) || a.kind !== "robotaxi" || a.runtimeId !== undefined || a.vehicle !== undefined || a.dodge !== null || ridden.has(a.id)) continue;
    const mine = state.players[self]?.hail?.agentId === a.id;
    if (hailed.has(a.id) && !mine) continue;
    const d = Math.sqrt((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z));
    if (d > RIDE.hailRange || d >= bestD) continue;
    if (segmentBlocked(world, x, z, a.x, a.z) || unfit(state, a)) continue;
    best = a;
    bestD = d;
  }
  return best;
}

/** A destination payload as whole metres, or null when it is not a finite point. */
export function destinationOf(payload: unknown): { x: number; z: number } | null {
  const p = payload as { x?: unknown; z?: unknown } | null | undefined;
  if (!p || typeof p.x !== "number" || typeof p.z !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  return { x: Math.round(p.x), z: Math.round(p.z) };
}

/** Has the taxi reached the rider's goal? */
export function arrived(ride: Readonly<Pick<PlayerRide, "goal">>, x: number, z: number): boolean {
  const g = ride.goal;
  if (!g) return false;
  return (g.x - x) * (g.x - x) + (g.z - z) * (g.z - z) <= RIDE.arrive * RIDE.arrive;
}
