// Bot Sweep (docs/design.md, Modes): co-op, 1–4 players, in its own SimState on a bounded arena
// cut from the real city. Moat Labs' beta units hide among ~120 robots; melt every one and the
// Update Relay before the clock runs out. The free-roam state is never read, copied or written
// here: only the settled payouts leave the match (src/sim/modes/settlement.ts applies them).
import { Action, NEUTRAL_INPUT, sortedIds, type InputFrame, type SimEvent, type SimState, type Spawn } from "../contract.ts";
import { activeBody, step } from "../step.ts";
import { contextFromState } from "../combat/adapter.ts";
import { agentsCombatOptions } from "../agents/systems.ts";
import { createRivalBotState, planRivalBotInputs, type BotObservation, type RivalBotState } from "../bots/controller.ts";
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
import type { MatchCarrySource } from "./carry.ts";
import { MATCH_RULES } from "./match.ts";
import type { MatchResult } from "./types.ts";

export const BOT_SWEEP_ARENA_RADIUS = 120;
export const BOT_SWEEP_MAX_PLAYERS = 4;
/** No robot is placed this close to the team spawn, so every player starts able to move. */
export const TEAM_SPAWN_CLEAR_M = 25;
const DISTRACTED_ACTIONS = Action.fire | Action.scan | Action.watch | Action.altFire;

export class ArenaUnavailableError extends Error {
  readonly reason: "refill" | "space" | "location";
  constructor(reason: "refill" | "space" | "location", message: string) { super(message); this.name = "ArenaUnavailableError"; this.reason = reason; }
}

export type ArenaModeId = "botSweep" | "cleanStreets";
export interface BotSweepConfig {
  /** Bot Sweep (co-op, default) or Clean Streets (two teams racing for the most points). */
  mode?: ArenaModeId;
  /** Stable match id; payout settlement ids are `${id}:${playerId}`. */
  id: string;
  seed: number;
  players: readonly string[];
  /** Arena centre and team spawn: an approved dry point outside every protected area. */
  spawn: Spawn;
  /** Optional shorter clock (ticks), at least one second, never longer than 12 minutes. */
  durationTicks?: number;
  /**
   * Bot players (`bot-1`…), so a team is never short of players; humans + bots ≤ 4. In Clean
   * Streets people alternate teams by seat and each bot joins the smaller team.
   */
  bots?: number;
}

/** Bot teammates' ids: never a relay seat id (`p1`…). */
export function botIds(count: number): string[] { return Array.from({ length: count }, (_, i) => `bot-${i + 1}`); }
export const isBotId = (id: string): boolean => /^bot-[1-9]$/.test(id);

/** What a Bot Sweep instance keeps beside the match: its admitted roster and arena. */
interface SweepInstance { version: 1; roster: RuntimeSpawn[]; center: { x: number; y: number; z: number }; radius: number; bots?: RivalBotState }

export interface BotSweepView {
  id: string;
  mode: ArenaModeId;
  /** Clean Streets: each team's points (team 0, team 1); Bot Sweep: one shared total. */
  teamScores: number[];
  phase: "active" | "finished";
  remainingTicks: number;
  objectivesRemaining: number;
  relayStanding: boolean;
  lives: number;
  players: Record<string, { score: number; runway: number; down: boolean; team: number; distracted: boolean; flowers: number }>;
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
export function createBotSweep(world: World, config: BotSweepConfig,carrySource?:MatchCarrySource): SimState {
  if (!VALID_ID.test(config.id)) throw new Error("Invalid match id");
  const bots = config.bots ?? 0;
  if (!Number.isSafeInteger(bots) || bots < 0 || bots >= BOT_SWEEP_MAX_PLAYERS || config.players.some(isBotId)) throw new Error("Invalid bot teammates");
  const players = [...config.players, ...botIds(bots)].sort();
  if (config.players.length < 1 || players.length > BOT_SWEEP_MAX_PLAYERS || new Set(players).size !== players.length || players.some(id => !VALID_ID.test(id))) throw new Error("Invalid match participants");
  if (excluded(config.spawn.x, config.spawn.z) || !dryPoint(world, config.spawn.x, config.spawn.z)) throw new ArenaUnavailableError("location", "Choose a dry arena outside excluded areas");
  const mode = config.mode ?? "botSweep";
  if (mode !== "botSweep" && mode !== "cleanStreets") throw new Error("Invalid arena mode");
  const sweepMode = mode === "botSweep";
  const relayId = sweepMode ? `mission:mode-${config.id}:update-relay` : "";
  const teams: Record<string, number> = {};
  if (!sweepMode) {
    [...config.players].sort().forEach((id, i) => { teams[id] = i % 2; });
    for (const id of botIds(bots)) { const zero = sortedIds(teams).filter(t => teams[t] === 0).length, one = sortedIds(teams).length - zero; teams[id] = zero <= one ? 0 : 1; }
  }
  const center = { x: config.spawn.x, y: groundHeight(world, config.spawn.x, config.spawn.z), z: config.spawn.z }, radius = BOT_SWEEP_ARENA_RADIUS;
  const arena = { center, radius }, isolated = arenaWorld(world, arena);
  if (!hasArenaRefill(isolated, arena)) throw new ArenaUnavailableError("refill", "This arena needs an accessible water refill");
  let state = createMatchSession(isolated, { id: config.id, mode, seed: config.seed, players, ...(sweepMode ? { relayId } : { teams }), ...(config.durationTicks !== undefined ? { durationTicks: config.durationTicks } : {}) }, config.spawn,{},carrySource);
  const roster = planModeRoster(isolated, state, { id: config.id, mode: sweepMode ? "bot-sweep" : "clean-streets", playerCount: players.length, center, radius,
    contains: (x, z) => arenaContains(arena, x, z, 1) && (x - center.x) * (x - center.x) + (z - center.z) * (z - center.z) >= TEAM_SPAWN_CLEAR_M * TEAM_SPAWN_CLEAR_M && !excluded(x, z) && dryPoint(isolated, x, z) }, isolated.sidewalks);
  // Missing objectives cannot turn an unbuilt arena into an automatic win.
  if (roster.blocked.length || roster.actors.length !== (sweepMode ? 121 : 120)) throw new ArenaUnavailableError("space", "This location has insufficient clear space for the match");
  const reserved = allocateActorIds(state, roster.actors.map(actor => actor.id)); state = reserved.state;
  const actors = roster.actors.map(actor => ({ ...actor, numericId: reserved.ids[actor.id]! }));
  const session = modeSessionOf(state)!;
  const instance: SweepInstance = { version: 1, roster: actors, center, radius, ...(bots ? { bots: createRivalBotState(Object.fromEntries(botIds(bots).map(id => [id, "hunter" as const]))) } : {}) };
  const bad = actors.filter(actor => actor.firmware === "bad" && (!sweepMode || actor.id !== relayId)).map(actor => actor.id).sort();
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
  combat:context=>{
    if(context.state.version<=20)return {};
    const match=modeSessionOf(context.state)?.match;
    if(!match)return {mode:"bot-sweep"};
    const rivalPlayerIds=Object.fromEntries(sortedIds(match.players).map(id=>[id,sortedIds(match.players).filter(other=>other!==id&&match.players[other]!.team!==match.players[id]!.team)]));
    return {mode:match.mode==="cleanStreets"?"clean-streets":"bot-sweep",rivalPlayerIds};
  },
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
  // Core owns paused membership/timers. Do not advance outside-core bot planning or RNG.
  if(state.version>=27&&(state.ext.combat?.pauseUntil??0)>state.tick)return step(isolated,state,inputs,events,SYSTEMS);
  const controls: Record<string, InputFrame[string]> = { ...inputs };
  const limitControls = (): void => {
    for (const id of sortedIds(session.match.players)) {
      const p = session.match.players[id]!;
      if (p.downUntil > state.tick) controls[id] = { ...NEUTRAL_INPUT };
      // Apply after input generation: flowers affect human and bot controls equally.
      else if ((p.distractedUntil ?? 0) > state.tick && controls[id]) controls[id] = { ...controls[id]!, actions: controls[id]!.actions & ~DISTRACTED_ACTIONS };
    }
  };
  const respawns: SimEvent[] = session.match.phase !== "active" ? [] : session.match.events.filter(event => event.tick === state.tick && event.kind === "match.respawn-request" && state.players[event.playerId]).flatMap(event => [
    { tick: state.tick + 1, kind: "player.leave", playerId: event.playerId },
    { tick: state.tick + 1, kind: "player.join", playerId: event.playerId, payload: { x: local.center.x, z: local.center.z, heading: 0 } },
  ]);
  if (!local.bots || session.match.phase !== "active") {
    limitControls();
    return step(isolated, state, controls, [...events, ...respawns], SYSTEMS);
  }
  // Bot teammates see only what a player could (visible bodies, completed scans; never firmware)
  // and play through the same controls and recorded commands as people. Deterministic: their
  // memory lives in the match state.
  const combat = contextFromState(isolated, state, { ...agentsCombatOptions(state), wave: 4 }), runtime = agentsRuntimeOf(state);
  const observations: BotObservation[] = sortedIds(local.bots.bots).filter(id => state.players[id]).map(id => {
    const body = activeBody(state.players[id]!);
    const near = (a: { x: number; z: number }) => (a.x - body.x) * (a.x - body.x) + (a.z - body.z) * (a.z - body.z);
    const actors = combat.actors.filter(actor => actor.playerId !== id && near(actor) <= 40 * 40)
      .sort((a, b) => near(a) - near(b) || (a.id < b.id ? -1 : 1)).slice(0, 256)
      .map(actor => ({ id: actor.id, kind: actor.kind, x: actor.x, y: actor.y, z: actor.z, visible: true, height: actor.height,
        operational: actor.kind === "player" || state.ext.combat?.targets[actor.id]?.phase === undefined || state.ext.combat.targets[actor.id]!.phase === "active",
        suspicion: runtime?.actors[actor.id]?.behavior === "attack" ? 1 : 0, rival: false }));
    const refills = [...(isolated.gameplay?.refills ?? [])].sort((a, b) => near(a) - near(b) || (a.id < b.id ? -1 : 1)).slice(0, 64);
    return { playerId: id, actors, refills, objective: local.center, paused: session.match.players[id]!.downUntil > state.tick };
  });
  const plan = planRivalBotInputs(isolated, state, local.bots, observations);
  const commanded = plan.commands.map(command => { const { playerId, ...payload } = command; return { tick: state.tick + 1, kind: "gameplay.command", playerId, payload }; });
  for (const id of sortedIds(local.bots.bots)) {
    if (!state.players[id] || session.match.players[id]!.downUntil > state.tick) continue;
    const player = state.players[id]!;
    // Bots sweep on foot: out of the car first.
    controls[id] = player.mode === "vehicle" ? { ...NEUTRAL_INPUT, actions: Math.abs(player.car.speed) < .1 ? Action.enterExit : 0, brake: 1 } : plan.inputs[id] ?? { ...NEUTRAL_INPUT };
  }
  limitControls();
  const next = step(isolated, state, controls, [...events, ...commanded, ...respawns], SYSTEMS);
  const modes = next.ext.modes as unknown as Record<string, unknown>;
  return { ...next, ext: { ...next.ext, modes: JSON.parse(JSON.stringify({ ...modes, sweep: { ...local, bots: plan.state } })) } };
}

/** A HUD-sized summary; never used by the sim. */
export function botSweepView(state: Readonly<SimState>): BotSweepView | null {
  const local = sweep(state), session = modeSessionOf(state); if (!local || !session) return null;
  const match = session.match, players: BotSweepView["players"] = {};
  const teamScores = match.mode === "cleanStreets" ? [0, 0] : [0];
  for (const id of sortedIds(match.players)) {
    const p = match.players[id]!;
    players[id] = { score: p.score, runway: p.runway, down: p.downUntil > state.tick, team: p.team, distracted: (p.distractedUntil ?? 0) > state.tick, flowers: p.flowers ?? 0 };
    teamScores[match.mode === "cleanStreets" ? p.team : 0]! += p.score;
  }
  return { id: match.id, mode: match.mode === "cleanStreets" ? "cleanStreets" : "botSweep", teamScores, phase: match.phase, remainingTicks: Math.max(0, match.durationTicks - match.elapsedTicks), objectivesRemaining: match.remainingBad.length + (match.relayId ? 1 : 0),
    relayStanding: match.relayId !== "", lives: match.lives, players, result: match.result, payouts: session.payouts };
}

export { MATCH_RULES };
