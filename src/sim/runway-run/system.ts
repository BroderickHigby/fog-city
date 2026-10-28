// Runway Run: a single-player mode inside the free-roam city. You are a founder, your runway (a
// countdown) is the clock, and investors wait on the street. Stop beside one and they get in;
// drive them to a demo and stop, and they write a check that buys more runway. Run out and the
// company shuts down.
//
// State: ext.runway holds one run per player (RunwayExt). It is INERT unless a run was started:
// with no ext.runway and no start event this system returns the state it was given, adds no key,
// and so changes no golden. A run starts, quits and clears only through recorded events
// (RUNWAY_START_EVENT, RUNWAY_QUIT_EVENT, RUNWAY_CLEAR_EVENT, like MODE_END_EVENT in
// modes/systems.ts), so a replay reproduces it. Randomness is the run's own sfc32 state, seeded
// from the sim seed and the start tick; state.rng is never touched.
//
// Reads (never writes): the player's body (activeBody), CarState.nearMisses and personBumps, and
// ext.impacts. A crash in a stolen civilian car is read from the impacts log; its near misses and
// person bumps are not counted for the player (dodge.ts credits only the player's own car).
// Payout into the city economy is not wired: XP and cash stay out of v1.

import { sortedIds, TICK_HZ, type PlayerId, type PlayerState, type RngState, type SimState } from "../contract.ts";
import { hash32, nextU32, seedRng } from "../rng.ts";
import { impactsOf } from "../impacts.ts";
import { activeBody } from "../step.ts";
import type { SimSystem, SimSystemContext } from "../system-contract.ts";
import type { World } from "../world.ts";
import { RUNWAY_INVESTORS } from "../../content/runwayInvestors.ts";
import { RUNWAY_RULES, addHype, addedTicks, checkDollars, decayHype, speedFactor } from "./rules.ts";
import { networkAt, pickPoint, type RunwayPoint } from "./targets.ts";

/** A recorded command: `playerId` starts a run (or a fresh one after a finished run). No payload. */
export const RUNWAY_START_EVENT = "runway.start";
/** A recorded command: `playerId` ends the running run now (the results stay). No payload. */
export const RUNWAY_QUIT_EVENT = "runway.quit";
/** A recorded command: `playerId` leaves a finished run's results (the run is removed). No payload. */
export const RUNWAY_CLEAR_EVENT = "runway.clear";
export const RUNWAY_EXT_KEY = "runway";

export type RunwayNoteKind = "pickup" | "check" | "downRound" | "scandal" | "over";

/** One thing worth a toast. `investor` indexes RUNWAY_INVESTORS; `amount` is dollars, `seconds` the runway change. */
export interface RunwayNote { id: number; tick: number; kind: RunwayNoteKind; investor: number; amount: number; seconds: number }

export interface RunwayRun {
  phase: "running" | "over";
  startTick: number;
  /** The tick the run ended (0 while it runs). */
  endTick: number;
  /** Runway left, ticks. */
  runwayTicks: number;
  /** Total raised, whole dollars. */
  raised: number;
  closed: number;
  /** The biggest check, dollars. */
  best: number;
  /** 1 .. 3. */
  hype: number;
  rng: RngState;
  /** The investor on the street or in the car (index into RUNWAY_INVESTORS). */
  investor: number;
  carrying: boolean;
  /** Where to go now: the investor, or the demo while carrying. Null once the run is over. */
  target: RunwayPoint | null;
  /** The connected street network targets are drawn from (targets.ts). */
  network: number;
  /** Where the investor got in (the trip's distance is measured from here). */
  pickedAt: RunwayPoint | null;
  tripStart: number;
  /** Hard crashes on this trip. */
  downRounds: number;
  /** Ticks the car has held still inside the target's radius. */
  hold: number;
  nearSeen: number;
  bumpSeen: number;
  impactSeen: number;
  lastDownTick: number;
  nextNote: number;
  /** The last few notes, oldest first. */
  notes: RunwayNote[];
}

export interface RunwayExt { version: 1; runs: Record<PlayerId, RunwayRun> }

const MAX_NOTES = 8;

export function runwayOf(state: Readonly<SimState>): RunwayExt | undefined {
  return state.ext[RUNWAY_EXT_KEY] as RunwayExt | undefined;
}

/** Is this player at the wheel of a car (their own, a stolen civilian car, or a commandeered robotaxi)? */
export function isDriving(p: Readonly<PlayerState>): boolean {
  return p.mode === "vehicle" && (!p.ride || p.ride.manual === true);
}

function dist(a: Readonly<RunwayPoint>, b: Readonly<RunwayPoint>): number {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));
}

function note(run: RunwayRun, tick: number, kind: RunwayNoteKind, amount: number, seconds: number): void {
  run.notes = [...run.notes, { id: run.nextNote++, tick, kind, investor: run.investor, amount, seconds }].slice(-MAX_NOTES);
}

/** A fresh run for a player at the wheel, or null (no street to place an investor on). */
function startRun(world: World, state: Readonly<SimState>, id: PlayerId): RunwayRun | null {
  const p = state.players[id];
  if (!p || !isDriving(p) || !world.roads) return null;
  const body = activeBody(p);
  let rng = seedRng(hash32(state.seed, state.tick, ...[...id].map((c) => c.charCodeAt(0))));
  const network = networkAt(world.roads, body.x, body.z);
  if (network < 0) return null;
  const pick = pickPoint(world.roads, body, RUNWAY_RULES.pickupMinM, RUNWAY_RULES.pickupMaxM, network, rng);
  if (!pick) return null;
  let roll: number;
  [roll, rng] = nextU32(pick.rng);
  const events = impactsOf(state)?.events ?? [];
  return {
    phase: "running", startTick: state.tick, endTick: 0, runwayTicks: RUNWAY_RULES.startS * TICK_HZ,
    raised: 0, closed: 0, best: 0, hype: 1, rng, investor: roll % RUNWAY_INVESTORS.length, carrying: false,
    target: pick.point, network, pickedAt: null, tripStart: 0, downRounds: 0, hold: 0,
    nearSeen: p.car.nearMisses, bumpSeen: p.car.personBumps,
    impactSeen: events.length ? events[events.length - 1]!.id : 0, lastDownTick: -TICK_HZ,
    nextNote: 1, notes: [],
  };
}

function finish(run: RunwayRun, tick: number): RunwayRun {
  const done: RunwayRun = { ...run, phase: "over", endTick: tick, runwayTicks: Math.max(0, run.runwayTicks), carrying: false, target: null, hold: 0 };
  note(done, tick, "over", done.raised, 0);
  return done;
}

/** The next investor, from the player's spot (a different one from the last). */
function nextInvestor(world: World, run: RunwayRun, from: Readonly<RunwayPoint>): RunwayRun | null {
  const pick = pickPoint(world.roads!, from, RUNWAY_RULES.pickupMinM, RUNWAY_RULES.pickupMaxM, run.network, run.rng);
  if (!pick) return null;
  const [roll, rng] = nextU32(pick.rng);
  return { ...run, rng, target: pick.point, carrying: false, pickedAt: null, downRounds: 0, hold: 0,
    investor: (run.investor + 1 + roll % (RUNWAY_INVESTORS.length - 1)) % RUNWAY_INVESTORS.length };
}

/** One tick of a running run. */
function stepRun(world: World, state: Readonly<SimState>, id: PlayerId, before: RunwayRun): RunwayRun {
  const tick = state.tick;
  const p = state.players[id];
  if (!p || !world.roads) return finish(before, tick);
  let run: RunwayRun = { ...before, notes: before.notes, runwayTicks: before.runwayTicks - 1, hype: decayHype(before.hype) };
  const car = p.car;
  const nearMisses = Math.max(0, car.nearMisses - run.nearSeen);
  const bumps = Math.max(0, car.personBumps - run.bumpSeen);
  run.nearSeen = car.nearMisses;
  run.bumpSeen = car.personBumps;
  if (run.carrying && nearMisses > 0) run.hype = addHype(run.hype, nearMisses);

  // Hard crashes: the player's car, or the civilian car they drive, in the impacts log.
  const mine = new Set([`p:${id}`]);
  if (p.ride?.manual) mine.add(`a:${p.ride.agentId}`);
  for (const e of impactsOf(state)?.events ?? []) {
    if (e.id <= run.impactSeen) continue;
    run.impactSeen = e.id;
    if (!run.carrying || e.kind === "car-robot" || e.kind === "taxi-robot" || !(mine.has(e.a) || mine.has(e.b))) continue;
    if (e.dv <= RUNWAY_RULES.downRoundDv || tick - run.lastDownTick < RUNWAY_RULES.downRoundGapTicks) continue;
    run.downRounds++;
    run.hype = 1;
    run.lastDownTick = tick;
    note(run, tick, "downRound", 0, 0);
  }

  // Scandal: a person hit with an investor aboard. They leave; a new one waits.
  if (run.carrying && bumps > 0) {
    note(run, tick, "scandal", 0, -RUNWAY_RULES.scandalS);
    run.runwayTicks -= RUNWAY_RULES.scandalS * TICK_HZ;
    const next = run.runwayTicks > 0 ? nextInvestor(world, run, activeBody(p)) : null;
    run = next ?? run;
  }

  // Stop beside the target: close, slow, and held for half a second, at the wheel.
  const body = activeBody(p);
  if (run.runwayTicks > 0 && run.target && isDriving(p)) {
    const inside = dist(body, run.target) <= RUNWAY_RULES.stopRadiusM && Math.abs(body.speed) < RUNWAY_RULES.stopSpeedMps;
    run.hold = inside ? run.hold + 1 : 0;
    if (run.hold >= RUNWAY_RULES.stopHoldTicks) {
      if (!run.carrying) {
        const demo = pickPoint(world.roads, run.target, RUNWAY_RULES.dropMinM, RUNWAY_RULES.dropMaxM, run.network, run.rng);
        if (demo) {
          note(run, tick, "pickup", 0, 0);
          run = { ...run, rng: demo.rng, carrying: true, pickedAt: run.target, tripStart: tick, downRounds: 0, hold: 0, target: demo.point };
        }
      } else {
        const trip = dist(run.pickedAt!, run.target);
        const speed = speedFactor(trip, tick - run.tripStart);
        const dollars = checkDollars(trip, speed, run.hype, run.downRounds);
        const added = addedTicks(trip, speed);
        note(run, tick, "check", dollars, Math.round(added / TICK_HZ));
        run = { ...run, raised: run.raised + dollars, closed: run.closed + 1, best: Math.max(run.best, dollars), runwayTicks: run.runwayTicks + added };
        run = nextInvestor(world, run, body) ?? run;
      }
    }
  } else if (run.hold !== 0) run.hold = 0;

  return run.runwayTicks <= 0 ? finish(run, tick) : run;
}

export function createRunwaySystem(): SimSystem {
  return { key: "runway", step(context: SimSystemContext): SimState {
    const { state, world } = context;
    const commands = context.events.filter((e) => e.tick === state.tick && e.playerId !== undefined
      && (e.kind === RUNWAY_START_EVENT || e.kind === RUNWAY_QUIT_EVENT || e.kind === RUNWAY_CLEAR_EVENT));
    const ext = runwayOf(state);
    // Inert: no run and no command means no change and no key.
    if (!ext && commands.length === 0) return state;
    const runs: Record<PlayerId, RunwayRun> = { ...ext?.runs };
    let changed = false;
    for (const e of commands) {
      const id = e.playerId!;
      const run = runs[id];
      if (e.kind === RUNWAY_START_EVENT && (!run || run.phase === "over")) {
        const fresh = startRun(world, state, id);
        if (fresh) { runs[id] = fresh; changed = true; }
      } else if (e.kind === RUNWAY_QUIT_EVENT && run?.phase === "running") {
        runs[id] = finish(run, state.tick);
        changed = true;
      } else if (e.kind === RUNWAY_CLEAR_EVENT && run?.phase === "over") {
        delete runs[id];
        changed = true;
      }
    }
    for (const id of sortedIds(runs)) {
      const run = runs[id]!;
      // (A run started or ended by a command this tick already counted it.)
      if (run.phase !== "running" || run.startTick === state.tick || commands.some((e) => e.playerId === id && e.kind === RUNWAY_QUIT_EVENT)) continue;
      runs[id] = stepRun(world, state, id, run);
      changed = true;
    }
    if (!changed) return state;
    const rest = { ...state.ext };
    delete rest[RUNWAY_EXT_KEY];
    return { ...state, ext: sortedIds(runs).length ? { ...rest, [RUNWAY_EXT_KEY]: { version: 1, runs } } : rest };
  } };
}

/** Inert until a run starts; registered in createGameSystems (game-systems.ts). */
export const systems: readonly SimSystem[] = Object.freeze([createRunwaySystem()]);
