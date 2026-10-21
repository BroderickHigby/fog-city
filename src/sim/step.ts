import {
  Action,
  NEUTRAL_INPUT,
  SIM_VERSION,
  sortedIds,
  type CarState,
  type FootState,
  type InputFrame,
  type PlayerId,
  type PlayerState,
  type SimEvent,
  type SimInput,
  type SimState,
  type Spawn,
} from "./contract.ts";
import { clamp } from "./dmath.ts";
import { carBox, carCircles, clearCarSpot, makeCar, stepCar } from "./car.ts";
import { FOOT, canEnterCar, exitSpot, stepFoot } from "./foot.ts";
import { AGENTS_EXT_KEY, agentCircles, initialAgents, stepAgents, type AgentsExt, type AgentState } from "./agents.ts";
import { agentDodgeClass, stepDodge } from "./dodge.ts";
import type { Box, Circle } from "./collide.ts";
import { seedRng } from "./rng.ts";
import { meshGroundHeight, type World } from "./world.ts";

function finiteOr0(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export function sanitizeInput(i: Readonly<SimInput>): SimInput {
  return {
    throttle: clamp(finiteOr0(i.throttle), -1, 1),
    steer: clamp(finiteOr0(i.steer), -1, 1),
    brake: clamp(finiteOr0(i.brake), 0, 1),
    actions: (i.actions | 0) >>> 0,
  };
}

/** A new player in a car at the spawn, or at the nearest clear spot to it (clearCarSpot): never overlapping a building, a wall or another car (`others`). */
function spawnPlayer(world: World, id: PlayerId, s: Spawn, others: ReadonlyArray<Readonly<Box>>): PlayerState {
  const p = clearCarSpot(world, s.x, s.z, s.heading, others);
  return {
    id,
    mode: "vehicle",
    car: makeCar(p.x, p.z, s.heading, meshGroundHeight(world, p.x, p.z)),
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
    const others = sortedIds(players).map((pid) => carBox(players[pid]!.car));
    players[id] = spawnPlayer(world, id, { x: spawn.x + n * 4, z: spawn.z, heading: spawn.heading }, others);
  });
  // (ext.dodge appears with the first dive; absent means every counter is 0, dodge.ts dodgeExtOf.)
  const state: SimState = { version: SIM_VERSION, tick: 0, seed, rng: seedRng(seed), players, ext: {} };
  if (!world.roads) return state;
  const pop = initialAgents(world, state);
  return { ...state, rng: pop.rng, ext: { ...state.ext, [AGENTS_EXT_KEY]: pop.ext } };
}

/**
 * Lift a saved state from an older SIM_VERSION to this one, one version at a time. Pure.
 *  - v1 -> v2: cars gain the handling fields (at rest), players gain foot (none) and exitPending.
 *  - v2 -> v3: a walker gains vy 0 and grounded true (standing where it was saved).
 *  - v3 -> v4: cars gain nearMisses 0, walkers and ambient agents dodge null (nobody mid-dive);
 *    ext.dodge stays absent (every counter 0) until the first dive.
 */
export function upgradeState(s: Readonly<SimState>): SimState {
  if (s.version === SIM_VERSION) return s as SimState;
  if (s.version === 1) return upgradeState(upgradeV1(s));
  if (s.version === 2) return upgradeState(upgradeV2(s));
  if (s.version === 3) return upgradeV3(s);
  throw new Error(`cannot upgrade sim state version ${s.version}`);
}

function upgradeV1(s: Readonly<SimState>): SimState {
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
  return { ...s, version: 2, players };
}

function upgradeV2(s: Readonly<SimState>): SimState {
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(s.players)) {
    const p = s.players[id]!;
    // A v2 walker has exactly the v2 fields; it stood on the ground.
    const f = p.foot as Omit<FootState, "vy" | "grounded"> | null;
    // (dodge: null here only to satisfy the v4 type; upgradeV3 sets it again.)
    players[id] = { ...p, foot: f ? { x: f.x, y: f.y, z: f.z, heading: f.heading, speed: f.speed, sprint: f.sprint, vy: 0, grounded: true, dodge: null } : null };
  }
  return { ...s, version: 3, players };
}

function upgradeV3(s: Readonly<SimState>): SimState {
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(s.players)) {
    const p = s.players[id]!;
    // A v3 car and walker have exactly the v3 fields.
    const c = p.car as Omit<CarState, "nearMisses">;
    const f = p.foot as Omit<FootState, "dodge"> | null;
    players[id] = { ...p, car: { ...c, nearMisses: 0 }, foot: f ? { ...f, dodge: null } : null };
  }
  const ext: Record<string, unknown> = { ...s.ext };
  const agents = s.ext[AGENTS_EXT_KEY] as { nextId: number; list: Array<Omit<AgentState, "dodge">> } | undefined;
  if (agents) ext[AGENTS_EXT_KEY] = { ...agents, list: agents.list.map((a) => ({ ...a, dodge: null })) };
  return { ...s, version: 4, players, ext };
}

/** What every body collides with this tick, built from the previous state. */
interface Obstacles {
  /** Every player's car body, by player id. */
  carBoxes: Map<PlayerId, Box>;
  /**
   * Round bodies a player's car must not pass through: robots and other cars. Never people,
   * animals or walkers (v4): they dive out of its way (dodge.ts), so a car is never stopped,
   * slowed or deflected by one.
   */
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
    // People and animals: under the dodge's override (dodge.ts), never a car's obstacle.
    const cls = agentDodgeClass(a);
    const person = cls !== null && cls !== "errandRobot" && cls !== "sidewalkBot";
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
    const car: Circle[] = near.filter((c) => !c.person);
    const walker: Circle[] = [...near];
    for (const other of ids) {
      if (other === id) continue;
      const o = prev.players[other]!;
      car.push(...carCircles(o.car));
      if (o.mode === "foot" && o.foot) {
        // Another player on foot: a body to walkers; to cars, someone who dives out of the way.
        walker.push({ x: o.foot.x, z: o.foot.z, r: FOOT.radius, person: true });
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
    // Diving out of a car's way, or getting up: the dodge moves the walker (dodge.ts).
    if (p.foot.dodge) return p;
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
export function step(world: World, prev: Readonly<SimState>, inputs: InputFrame, events: readonly SimEvent[] = []): SimState {
  const tick = prev.tick + 1;
  const players: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(prev.players)) players[id] = prev.players[id]!;

  for (const e of events) {
    if (e.tick !== tick) throw new Error(`event ${e.kind} is for tick ${e.tick}, stepping to ${tick}`);
    if (e.kind === "player.join" && e.playerId && !players[e.playerId]) {
      const s = (e.payload ?? {}) as Partial<Spawn>;
      const others = sortedIds(players).map((id) => carBox(players[id]!.car));
      players[e.playerId] = spawnPlayer(world, e.playerId, { x: s.x ?? 0, z: s.z ?? 0, heading: s.heading ?? 0 }, others);
    } else if (e.kind === "player.leave" && e.playerId) {
      delete players[e.playerId];
    }
  }

  // Bodies collide with each other as of the previous tick (after joins and leaves), so the
  // order players and agents are processed in cannot change the outcome.
  const before: SimState = { ...prev, players };
  const obs = obstaclesOf(before);
  const next: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(players)) {
    const input = sanitizeInput(inputs[id] ?? NEUTRAL_INPUT);
    next[id] = stepPlayer(world, players[id]!, input, obs);
  }

  const agents = stepAgents(world, before, tick);
  const moved: SimState = agents
    ? { ...prev, tick, players: next, rng: agents.rng, ext: { ...prev.ext, [AGENTS_EXT_KEY]: agents.ext } }
    : { ...prev, tick, players: next };
  // Everybody out of the vehicles' way (dodge.ts), after every vehicle has moved.
  return stepDodge(world, before, moved);
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
