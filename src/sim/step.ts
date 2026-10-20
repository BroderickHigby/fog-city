import {
  NEUTRAL_INPUT,
  SIM_VERSION,
  sortedIds,
  type InputFrame,
  type PlayerId,
  type PlayerState,
  type SimEvent,
  type SimInput,
  type SimState,
  type Spawn,
} from "./contract.ts";
import { clamp } from "./dmath.ts";
import { makeCar, stepCar } from "./car.ts";
import { seedRng } from "./rng.ts";
import { groundHeight, type World } from "./world.ts";

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

function spawnPlayer(world: World, id: PlayerId, s: Spawn): PlayerState {
  return { id, mode: "vehicle", car: makeCar(s.x, s.z, s.heading, groundHeight(world, s.x, s.z)) };
}

export function createInitialState(world: World, seed: number, playerIds: readonly PlayerId[], spawn: Spawn): SimState {
  const players: Record<PlayerId, PlayerState> = {};
  [...playerIds].sort().forEach((id, n) => {
    // Side by side so multiplayer spawns do not overlap.
    players[id] = spawnPlayer(world, id, { x: spawn.x + n * 4, z: spawn.z, heading: spawn.heading });
  });
  return { version: SIM_VERSION, tick: 0, seed, rng: seedRng(seed), players, ext: {} };
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
      players[e.playerId] = spawnPlayer(world, e.playerId, { x: s.x ?? 0, z: s.z ?? 0, heading: s.heading ?? 0 });
    } else if (e.kind === "player.leave" && e.playerId) {
      delete players[e.playerId];
    }
  }

  const next: Record<PlayerId, PlayerState> = {};
  for (const id of sortedIds(players)) {
    const p = players[id]!;
    const input = sanitizeInput(inputs[id] ?? NEUTRAL_INPUT);
    next[id] = p.mode === "vehicle" ? { ...p, car: stepCar(world, p.car, input) } : p;
  }
  return { ...prev, tick, players: next };
}
