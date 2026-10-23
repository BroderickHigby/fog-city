// Bot Sweep (docs/design.md, Modes): co-op, 1–4 players, in its own SimState on a bounded arena
// cut from the real city. Moat Labs' beta units hide among ~120 robots; melt every one and the
// Update Relay before the clock runs out. The free-roam state is never read, copied or written
// here: only the settled payouts leave the match (src/sim/modes/settlement.ts applies them).
import { NEUTRAL_INPUT, sortedIds, type InputFrame, type SimEvent, type SimState, type Spawn } from "../contract.ts";
import { step } from "../step.ts";
import type { SimSystem } from "../system-contract.ts";
import { arenaCombatEvents, arenaContains, arenaWorld, constrainArenaMotion, hasArenaRefill, type Arena } from "./arena.ts";
import { createModesSystem, defaultMatchContext } from "./systems.ts";
import { createGameSystems } from "../game-systems.ts";
import { allocateActorIds } from "../identity.ts";
import { groundHeight, type World } from "../world.ts";
import { circleHitsWall, inCorridor, onWater } from "../boundary.ts";
import { planModeRoster } from "../agents/mode-roster.ts";
import { agentsRuntimeOf, type RuntimeSpawn } from "../agents/runtime.ts";
import { protectedAreaAt } from "../../content/places.ts";
import { toLatLon } from "../../geo/project.ts";
import { createMatchSession, modeSessionOf, type MatchPayoutEvent } from "./session.ts";
import { MATCH_RULES } from "./match.ts";
import type { MatchResult } from "./types.ts";

export const BOT_SWEEP_ARENA_RADIUS = 120;
export const BOT_SWEEP_MAX_PLAYERS = 4;

export class ArenaUnavailableError extends Error {
  readonly reason: "refill" | "space" | "location";
  constructor(reason: "refill" | "space" | "location", message: string) { super(message); this.name = "ArenaUnavailableError"; this.reason = reason; }
}

export interface BotSweepConfig {
  /** Stable match id; payout settlement ids are `${id}:${playerId}`. */
  id: string;
  seed: number;
  players: readonly string[];
  /** Arena centre and team spawn: an approved dry point outside every protected area. */
  spawn: Spawn;
  /** Optional shorter clock (ticks), at least one second, never longer than 12 minutes. */
  durationTicks?: number;
}

/** What a Bot Sweep instance keeps beside the match: its admitted roster and arena. */
interface SweepInstance { version: 1; roster: RuntimeSpawn[]; center: { x: number; y: number; z: number }; radius: number }

export interface BotSweepView {
  id: string;
  phase: "active" | "finished";
  remainingTicks: number;
  objectivesRemaining: number;
  relayStanding: boolean;
  lives: number;
  players: Record<string, { score: number; runway: number; down: boolean }>;
  result: MatchResult | null;
  payouts: readonly MatchPayoutEvent[];
}

function sweep(state: Readonly<SimState>): SweepInstance | undefined {
  return (state.ext.modes as unknown as { sweep?: SweepInstance } | undefined)?.sweep;
}
function excluded(x: number, z: number): boolean { const p = toLatLon(x, z); return Boolean(protectedAreaAt([p.lat, p.lon])); }
function dryPoint(world: World, x: number, z: number): boolean {
  return !world.walls || !circleHitsWall(world.walls, x, z, .5) && (!onWater(world.walls.shore, x, z) || inCorridor(world.walls, x, z));
}
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** True when `state` is a Bot Sweep instance (never the free-roam city). */
export function isBotSweep(state: Readonly<SimState>): boolean { return !!sweep(state) && !!modeSessionOf(state); }

/** The arena a Bot Sweep state plays on, for renderers and HUDs. */
export function botSweepArena(state: Readonly<SimState>): Arena | null {
  const local = sweep(state);
  return local ? { center: { ...local.center }, radius: local.radius } : null;
}

/** A new, separate match instance on an arena cut from `world`. Throws ArenaUnavailableError. */
export function createBotSweep(world: World, config: BotSweepConfig): SimState {
  if (!VALID_ID.test(config.id)) throw new Error("Invalid match id");
  const players = [...config.players].sort();
  if (players.length < 1 || players.length > BOT_SWEEP_MAX_PLAYERS || new Set(players).size !== players.length || players.some(id => !VALID_ID.test(id))) throw new Error("Invalid match participants");
  if (excluded(config.spawn.x, config.spawn.z) || !dryPoint(world, config.spawn.x, config.spawn.z)) throw new ArenaUnavailableError("location", "Choose a dry arena outside excluded areas");
  const relayId = `mission:mode-${config.id}:update-relay`;
  const center = { x: config.spawn.x, y: groundHeight(world, config.spawn.x, config.spawn.z), z: config.spawn.z }, radius = BOT_SWEEP_ARENA_RADIUS;
  const arena = { center, radius }, isolated = arenaWorld(world, arena);
  if (!hasArenaRefill(isolated, arena)) throw new ArenaUnavailableError("refill", "This arena needs an accessible water refill");
  let state = createMatchSession(isolated, { id: config.id, mode: "botSweep", seed: config.seed, players, relayId, ...(config.durationTicks !== undefined ? { durationTicks: config.durationTicks } : {}) }, config.spawn);
  const roster = planModeRoster(isolated, state, { id: config.id, mode: "bot-sweep", playerCount: players.length, center, radius,
    contains: (x, z) => arenaContains(arena, x, z, 1) && !excluded(x, z) && dryPoint(isolated, x, z) }, isolated.sidewalks);
  // Missing objectives cannot turn an unbuilt arena into an automatic win.
  if (roster.blocked.length || roster.actors.length !== 121) throw new ArenaUnavailableError("space", "This location has insufficient clear space for the match");
  const reserved = allocateActorIds(state, roster.actors.map(actor => actor.id)); state = reserved.state;
  const actors = roster.actors.map(actor => ({ ...actor, numericId: reserved.ids[actor.id]! }));
  const session = modeSessionOf(state)!;
  const instance: SweepInstance = { version: 1, roster: actors, center, radius };
  const bad = actors.filter(actor => actor.firmware === "bad" && actor.id !== relayId).map(actor => actor.id).sort();
  return { ...state, ext: { ...state.ext, modes: JSON.parse(JSON.stringify({ ...session, match: { ...session.match, remainingBad: bad }, sweep: instance })) } };
}

const matchModes = createModesSystem(context => {
  const observed = defaultMatchContext(context), ids = new Set(sweep(context.state)?.roster.map(actor => actor.id) ?? []);
  return { ...observed, combatEvents: arenaCombatEvents(observed.combatEvents ?? [], ids) };
});
/**
 * Free-roam-only reducers: campaign missions and their staged scenes, side activities, VC heat,
 * and the wallet (financial balances never carry into a match; match runway is the match's own).
 */
const CITY_ONLY = new Set(["missions", "activities", "heat", "economy"]);
/**
 * The game's own composition, with the roster admitted, no ambient services, no campaign, and
 * the arena wall on robots.
 */
const SYSTEMS: readonly SimSystem[] = createGameSystems({ wave: 4,
  agents: context => ({ spawns: sweep(context.state)?.roster ?? [], services: false }),
  modes: [matchModes],
}).filter(system => !CITY_ONLY.has(system.key)).map<SimSystem>(system => system.key !== "robots" || !system.prepare ? system : { ...system, prepare(context) {
  const prepared = system.prepare!(context), local = sweep(context.state); if (!local) return prepared;
  const motions = prepared.motions.map(motion => constrainArenaMotion(context.world, local, motion));
  const robots = agentsRuntimeOf(prepared.state);
  return { ...prepared, motions, state: robots ? { ...prepared.state, ext: { ...prepared.state.ext, robots: { ...robots, proposals: motions } } } : prepared.state };
} });

/**
 * One canonical Bot Sweep tick, identical on the relay and every browser. `world` is the source
 * city; the arena view is derived (and cached) from it. Downed players' controls are ignored; a
 * respawn request re-enters the player through core's ordinary clearance-checked join path.
 */
export function stepBotSweep(world: World, state: Readonly<SimState>, inputs: InputFrame, events: readonly SimEvent[] = []): SimState {
  const local = sweep(state), session = modeSessionOf(state); if (!local || !session) throw new Error("Not a Bot Sweep match");
  const isolated = arenaWorld(world, local);
  const controls: Record<string, InputFrame[string]> = { ...inputs };
  for (const id of sortedIds(session.match.players)) if (session.match.players[id]!.downUntil > state.tick) controls[id] = { ...NEUTRAL_INPUT };
  const respawns: SimEvent[] = session.match.phase !== "active" ? [] : session.match.events.filter(event => event.tick === state.tick && event.kind === "match.respawn-request" && state.players[event.playerId]).flatMap(event => [
    { tick: state.tick + 1, kind: "player.leave", playerId: event.playerId },
    { tick: state.tick + 1, kind: "player.join", playerId: event.playerId, payload: { x: local.center.x, z: local.center.z, heading: 0 } },
  ]);
  return step(isolated, state, controls, [...events, ...respawns], SYSTEMS);
}

/** A HUD-sized summary; never used by the sim. */
export function botSweepView(state: Readonly<SimState>): BotSweepView | null {
  const local = sweep(state), session = modeSessionOf(state); if (!local || !session) return null;
  const match = session.match, players: BotSweepView["players"] = {};
  for (const id of sortedIds(match.players)) { const p = match.players[id]!; players[id] = { score: p.score, runway: p.runway, down: p.downUntil > state.tick }; }
  return { id: match.id, phase: match.phase, remainingTicks: Math.max(0, match.durationTicks - match.elapsedTicks), objectivesRemaining: match.remainingBad.length + (match.relayId ? 1 : 0),
    relayStanding: match.relayId !== "", lives: match.lives, players, result: match.result, payouts: session.payouts };
}

export { MATCH_RULES };
