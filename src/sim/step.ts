import {
  Action,
  NEUTRAL_INPUT,
  SIM_VERSION,
  sortedIds,
  type CarState,
  type InputFrame,
  type PlayerId,
  type PlayerState,
  type SimEvent,
  type SimInput,
  type SimState,
  type Spawn,
} from "./contract.ts";
import { clamp, HALF_PI, TAU, wrapAngle } from "./dmath.ts";
import { carBox, carCircles, makeCar, stepCar } from "./car.ts";
import { FOOT, canEnterCar, exitSpot, stepFoot } from "./foot.ts";
import { AGENTS_EXT_KEY, agentCircles, initialAgents, stepAgents, type AgentsExt } from "./agents.ts";
import type { Box, Circle } from "./collide.ts";
import { seedRng } from "./rng.ts";
import { groundHeight, type World } from "./world.ts";
import { runSystems, SYSTEMS } from "./systems.ts";
import type { SimSystem } from "./system-contract.ts";

function finiteOr0(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export function sanitizeInput(i: Readonly<SimInput>): SimInput {
  const input: SimInput = {
    throttle: clamp(finiteOr0(i.throttle), -1, 1),
    steer: clamp(finiteOr0(i.steer), -1, 1),
    brake: clamp(finiteOr0(i.brake), 0, 1),
    actions: (i.actions | 0) >>> 0,
  };
  // Missing/non-finite aim stays absent so pre-wave-2 input logs keep body-heading aim.
  if (Number.isFinite(i.aimYaw)) input.aimYaw = wrapAngle(i.aimYaw! % TAU);
  if (Number.isFinite(i.aimPitch)) input.aimPitch = clamp(i.aimPitch!, -HALF_PI, HALF_PI);
  return input;
}

function spawnPlayer(world: World, id: PlayerId, s: Spawn): PlayerState {
  return {
    id,
    mode: "vehicle",
    car: makeCar(s.x, s.z, s.heading, groundHeight(world, s.x, s.z)),
    foot: null,
    exitPending: false,
  };
}

/**
 * A new world state. When the world has roads, ext.agents starts with the ambient population
 * around the players (src/sim/agents.ts), drawn from the seeded RNG.
 */
export function createInitialState(world: World, seed: number, playerIds: readonly PlayerId[], spawn: Spawn): SimState {
  const players: Record<PlayerId, PlayerState> = {};
  [...playerIds].sort().forEach((id, n) => {
    // Side by side so multiplayer spawns do not overlap.
    players[id] = spawnPlayer(world, id, { x: spawn.x + n * 4, z: spawn.z, heading: spawn.heading });
  });
  const state: SimState = { version: SIM_VERSION, tick: 0, seed, rng: seedRng(seed), players, ext: {} };
  if (!world.roads) return state;
  const pop = initialAgents(world, state);
  return { ...state, rng: pop.rng, ext: { ...state.ext, [AGENTS_EXT_KEY]: pop.ext } };
}

/** Lift a saved state from an older SIM_VERSION to this one. Pure. */
export function upgradeState(s: Readonly<SimState>): SimState {
  if (s.version === SIM_VERSION) return s as SimState;
  if (s.version === 2) return { ...s, version: SIM_VERSION };
  if (s.version !== 1) throw new Error(`cannot upgrade sim state version ${s.version}`);
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(s.players)) {
    const p = s.players[id]!;
    const c = p.car;
    players[id] = {
      id: p.id,
      mode: "vehicle",
      car: { ...makeCar(c.x, c.z, c.heading, c.y), speed: c.speed, steer: c.steer, hits: c.hits },
      foot: null,
      exitPending: false,
    };
  }
  return { ...s, version: SIM_VERSION, players };
}

/** What every body collides with this tick, built from the previous state. */
interface Obstacles {
  /** Every player's car body, by player id. */
  carBoxes: Map<PlayerId, Box>;
  /** Round bodies a player's car must not pass through: agents, other cars, other walkers. */
  forCar: Map<PlayerId, Circle[]>;
  /** Round bodies a player's walker must not pass through: agents and other walkers. */
  forWalker: Map<PlayerId, Circle[]>;
}

/** Agents farther than this from a player's body cannot touch it this tick. */
const NEAR_AGENT_M = 40;

function obstaclesOf(prev: Readonly<SimState>): Obstacles {
  const agents = (prev.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
  const agentRound: Circle[] = [];
  for (const a of agents) {
    const person = a.kind === "person";
    for (const c of agentCircles(a)) agentRound.push({ x: c.x, z: c.z, r: c.r, person });
  }
  const ids = sortedIds(prev.players);
  const carBoxes = new Map<PlayerId, Box>();
  const forCar = new Map<PlayerId, Circle[]>();
  const forWalker = new Map<PlayerId, Circle[]>();
  for (const id of ids) carBoxes.set(id, carBox(prev.players[id]!.car));
  for (const id of ids) {
    const p = prev.players[id]!;
    const bx = p.mode === "foot" && p.foot ? p.foot.x : p.car.x;
    const bz = p.mode === "foot" && p.foot ? p.foot.z : p.car.z;
    const near = agentRound.filter((c) => (c.x - bx) * (c.x - bx) + (c.z - bz) * (c.z - bz) < NEAR_AGENT_M * NEAR_AGENT_M);
    const car: Circle[] = [...near];
    const walker: Circle[] = [...near];
    for (const other of ids) {
      if (other === id) continue;
      const o = prev.players[other]!;
      car.push(...carCircles(o.car));
      if (o.mode === "foot" && o.foot) {
        // Another player on foot: a person to cars (never hurt), a body to walkers.
        const w = { x: o.foot.x, z: o.foot.z, r: FOOT.radius, person: true };
        car.push(w);
        walker.push(w);
      }
    }
    forCar.set(id, car);
    forWalker.set(id, walker);
  }
  return { carBoxes, forCar, forWalker };
}

function stepPlayer(world: World, p: Readonly<PlayerState>, input: SimInput, obs: Obstacles): PlayerState {
  const pressed = (input.actions & Action.enterExit) !== 0;
  const allCars = [...obs.carBoxes.values()];
  if (p.mode === "foot" && p.foot) {
    if (pressed && canEnterCar(world, p.car, p.foot.x, p.foot.z)) {
      return { ...p, mode: "vehicle", foot: null, exitPending: false };
    }
    const foot = stepFoot(world, p.foot, input, allCars, obs.forWalker.get(p.id) ?? []);
    return { ...p, foot };
  }

  const exitPending = pressed ? !p.exitPending : p.exitPending;
  const canExit = (c: Readonly<CarState>): boolean =>
    c.grounded &&
    (c.speed < 0 ? -c.speed : c.speed) < FOOT.exitSpeed &&
    (c.lateral < 0 ? -c.lateral : c.lateral) < FOOT.exitSpeed;
  const getOut = (c: Readonly<CarState>): PlayerState => {
    // The car stays parked exactly where it stopped.
    const parked: CarState = { ...c, speed: 0, lateral: 0, yawRate: 0, vy: 0 };
    const boxes: Box[] = [];
    for (const [id, b] of obs.carBoxes) boxes.push(id === p.id ? carBox(parked) : b);
    const foot = exitSpot(world, parked, boxes, obs.forWalker.get(p.id) ?? []);
    // No room to get out (walls or bodies on every side): stay in, stopped, free to drive on.
    if (!foot) return { ...p, car: parked, exitPending: false };
    return { ...p, mode: "foot", car: parked, foot, exitPending: false };
  };
  if (exitPending && canExit(p.car)) return getOut(p.car);
  // While an exit is pending the car brakes to a stop by itself, then the player gets out.
  const drive: SimInput = exitPending ? { throttle: 0, steer: 0, brake: 1, actions: input.actions } : input;
  const car = stepCar(world, p.car, drive, obs.forCar.get(p.id) ?? []);
  if (exitPending && canExit(car)) return getOut(car);
  return { ...p, car, exitPending };
}

/**
 * Advance the world by one fixed tick (DT). Pure: returns a new state.
 * `events` must all carry tick === prev.tick + 1.
 */
export function step(world: World, prev: Readonly<SimState>, inputs: InputFrame, events: readonly SimEvent[] = [], systems: readonly SimSystem[] = SYSTEMS): SimState {
  const tick = prev.tick + 1;
  // The outer clock and recorded membership events keep advancing during the AGI pause.
  // Combat owns its timer-holding reducer; every other simulation system stays frozen.
  const paused = (prev.ext.combat?.pauseUntil ?? 0) > prev.tick;
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(prev.players)) players[id] = prev.players[id]!;

  for (const e of events) {
    if (e.tick !== tick) throw new Error(`event ${e.kind} is for tick ${e.tick}, stepping to ${tick}`);
    if (e.kind === "player.join" && e.playerId && !players[e.playerId]) {
      const s = (e.payload ?? {}) as Partial<Spawn>;
      players[e.playerId] = spawnPlayer(world, e.playerId, { x: s.x ?? 0, z: s.z ?? 0, heading: s.heading ?? 0 });
    } else if (e.kind === "player.leave" && e.playerId) {
      delete players[e.playerId];
    }
  }

  // Bodies collide with each other as of the previous tick (after joins and leaves), so the
  // order players and agents are processed in cannot change the outcome.
  const before: SimState = { ...prev, players };
  const obs = obstaclesOf(before);
  const next: Record<PlayerId, PlayerState> = {};
  const sanitized: Record<PlayerId, SimInput> = {};
  for (const id of sortedIds(players)) {
    const input = sanitizeInput(inputs[id] ?? NEUTRAL_INPUT);
    sanitized[id] = input;
    next[id] = paused ? players[id]! : stepPlayer(world, players[id]!, input, obs);
  }

  const agents = paused ? undefined : stepAgents(world, before, tick);
  const moved = agents
    ? { ...prev, tick, players: next, rng: agents.rng, ext: { ...prev.ext, [AGENTS_EXT_KEY]: agents.ext } }
    : { ...prev, tick, players: next };
  return runSystems({ world, previous: before, state: moved, inputs: sanitized, events }, paused ? systems.filter(system => system.key === "combat") : systems);
}

/** The body a player controls right now: the walker on foot, else the car. For cameras, HUDs and AI. */
export interface ActiveBody {
  mode: "vehicle" | "foot";
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
}

export function activeBody(p: Readonly<PlayerState>): ActiveBody {
  if (p.mode === "foot" && p.foot) {
    const f = p.foot;
    return { mode: "foot", x: f.x, y: f.y, z: f.z, heading: f.heading, speed: f.speed };
  }
  const c = p.car;
  return { mode: "vehicle", x: c.x, y: c.y, z: c.z, heading: c.heading, speed: c.speed };
}
