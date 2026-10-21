// One scripted multiplayer run of the sim, written once and executed twice: in Node (the
// Playwright test process imports this file) and inside a browser engine (sim-lab.html
// imports the same file through Vite). Identical checkpoint hashes prove the sim is
// engine-independent: same world + same seed + same inputs + same events => same state.
//
// Rules for this file, because it must behave identically on every engine:
//  - import only from src/sim (no node:, no DOM, no three.js);
//  - generate inputs with exact integer arithmetic (xorshift32): never Math.random, Date,
//    or Math.sin/cos/exp (their last bits are implementation-defined);
//  - iterate players with sortedIds().

import {
  Action,
  buildWorld,
  canonicalJson,
  createInitialState,
  datan,
  datan2,
  dcos,
  dsin,
  dtan,
  hashState,
  sortedIds,
  step,
  wrapAngle,
  type InputFrame,
  type PlayerId,
  type SimEvent,
  type SimInput,
  type SimState,
  type Spawn,
  type BoundaryFile,
  type RoadsFile,
  type TileCollider,
  type World,
} from "../../src/sim/index.ts";

/**
 * buildWorld(tiles, roads, boundary): the road graph runs ambient traffic, the boundary walls
 * stop cars at the world's edge and shore. Node and the browser both build their world through this.
 */
export function makeWorld(tiles: readonly TileCollider[], roads: unknown, boundary: unknown = null): World {
  return buildWorld(tiles, (roads ?? null) as RoadsFile | null, (boundary ?? null) as BoundaryFile | null);
}

export interface ScenarioOptions {
  /** Ticks to run (60 per simulated second). */
  ticks: number;
  /** Record hashState every this many ticks. */
  checkpointEvery: number;
  seed: number;
  /** The world's spawn (manifest.spawn). */
  spawn: Spawn;
}

export interface ScenarioStats {
  /** Collision events summed over every player (increments of CarState.hits). */
  hits: number;
  /** Highest |speed| any player's car reached, m/s. */
  maxSpeed: number;
  /** Sum of |heading change| over every player and tick, radians: proof the cars steered. */
  turned: number;
  /** Player-ticks spent on foot (sim v2 on-foot play; 0 on a sim without it). */
  footTicks: number;
  /** Player-ticks simulated. */
  playerTicks: number;
  /** Every player id that existed at some tick. */
  playersSeen: string[];
  /** Ambient agents in the final state (sim v2 traffic; 0 without roads). */
  agents: number;
}

export interface ScenarioResult {
  ticks: number;
  /** `${tick}:${hashState}` every checkpointEvery ticks. */
  checkpoints: string[];
  finalHash: string;
  /** canonicalJson of the final state: compared whole, so a divergence cannot hide in a hash collision. */
  finalJson: string;
  stats: ScenarioStats;
}

// ---- exact-integer input generation ------------------------------------------------------

function xorshift32(s: number): number {
  let x = s | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** FNV-1a over a string's UTF-16 code units: a stable per-player seed. */
function seedOf(text: string, salt: number): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 1;
}

const THROTTLE = [1, 1, 0.75, 0.5, 0.25, 0, -0.5, -1] as const;
const STEER = [-1, -0.5, -0.25, 0, 0, 0.25, 0.5, 1] as const;
const BRAKE = [0, 0, 0, 0, 0, 0, 0.5, 1] as const;

interface Driver {
  rng: number;
  /** Ticks left in the current segment. */
  left: number;
  input: SimInput;
  /** One-shot action bits for the first tick of the segment. */
  oneShot: number;
  segments: number;
}

function newDriver(id: PlayerId, seed: number): Driver {
  return { rng: seedOf(id, seed), left: 0, input: { throttle: 0, steer: 0, brake: 0, actions: 0 }, oneShot: 0, segments: 0 };
}

/** The next tick's input from a driver: piecewise-constant segments of 15..119 ticks. */
function drive(d: Driver, unruly: boolean): SimInput {
  if (d.left <= 0) {
    d.rng = xorshift32(d.rng);
    const r = d.rng;
    d.segments++;
    d.left = 15 + (r % 105);
    let throttle: number = THROTTLE[(r >>> 8) & 7]!;
    let steer: number = STEER[(r >>> 11) & 7]!;
    const brake: number = BRAKE[(r >>> 14) & 7]!;
    if (unruly && d.segments % 5 === 0) {
      // Out-of-range and non-finite controls: the sim must clamp them the same way everywhere.
      throttle = d.segments % 10 === 0 ? Number.NaN : 2.5;
      steer = -3;
    }
    d.input = { throttle, steer, brake, actions: 0 };
    const a = (r >>> 17) & 15;
    d.oneShot =
      a === 0 ? Action.enterExit : a === 1 ? Action.fire : a === 2 ? Action.horn : a === 3 ? Action.scan | Action.fire : 0;
  }
  d.left--;
  const actions = d.oneShot;
  d.oneShot = 0;
  return { ...d.input, actions };
}

/**
 * p1's opening: a straight full-throttle run along the spawn heading (in the dev world this
 * hits the wall 60 m north), a reversing turn, a stop, a hop out and back (on foot when the
 * sim supports it), then random driving like everyone else.
 */
function p1Script(t: number): SimInput | null {
  if (t < 420) return { throttle: 1, steer: 0, brake: 0, actions: 0 };
  if (t < 520) return { throttle: -1, steer: 0.5, brake: 0, actions: 0 };
  if (t < 560) return { throttle: 0, steer: 0, brake: 1, actions: 0 };
  if (t === 560) return { throttle: 0, steer: 0, brake: 0, actions: Action.enterExit };
  if (t < 640) return { throttle: 1, steer: 0.25, brake: 0, actions: 0 };
  if (t < 700) return { throttle: -1, steer: -0.25, brake: 0, actions: 0 };
  if (t === 700) return { throttle: 0, steer: 0, brake: 0, actions: Action.enterExit };
  return null;
}

/** A spot `m` metres behind the spawn along its heading and `side` metres to its right. */
function behind(spawn: Spawn, m: number, side: number): { x: number; z: number; heading: number } {
  return {
    x: spawn.x - dsin(spawn.heading) * m + dcos(spawn.heading) * side,
    z: spawn.z + dcos(spawn.heading) * m + dsin(spawn.heading) * side,
    heading: spawn.heading,
  };
}

/**
 * Outside facts, as a server would inject them: joins and leaves on fixed ticks of the
 * session (`rel`, 1-based), stamped with the absolute tick `tick` they apply to.
 */
function eventsFor(rel: number, tick: number, spawn: Spawn): SimEvent[] {
  switch (rel) {
    case 120:
      return [{ tick, kind: "player.join", playerId: "p4", payload: behind(spawn, 14, -3) }];
    case 1500:
      return [{ tick, kind: "player.leave", playerId: "p2" }];
    case 2100:
      return [{ tick, kind: "player.join", playerId: "p2", payload: behind(spawn, 24, 3) }];
    case 2700:
      return [
        { tick, kind: "player.join", playerId: "p5", payload: behind(spawn, 8, 6) },
        { tick, kind: "player.leave", playerId: "p4" },
      ];
    default:
      return [];
  }
}

function agentCount(s: SimState): number {
  const list = (s.ext["agents"] as { list?: unknown[] } | undefined)?.list;
  return Array.isArray(list) ? list.length : 0;
}

/** Run the scenario on `world`. Pure apart from its own locals: same arguments, same result. */
export function runScenario(world: World, opts: ScenarioOptions): ScenarioResult {
  let state = createInitialState(world, opts.seed, ["p1", "p2", "p3"], opts.spawn);
  const drivers = new Map<PlayerId, Driver>();
  const checkpoints: string[] = [];
  const seen = new Set<string>(sortedIds(state.players));
  const stats: ScenarioStats = { hits: 0, maxSpeed: 0, turned: 0, footTicks: 0, playerTicks: 0, playersSeen: [], agents: 0 };

  for (let t = 0; t < opts.ticks; t++) {
    const frame: Record<PlayerId, SimInput> = {};
    for (const id of sortedIds(state.players)) {
      let d = drivers.get(id);
      if (!d) drivers.set(id, (d = newDriver(id, opts.seed)));
      const scripted = id === "p1" ? p1Script(t) : null;
      frame[id] = scripted ?? drive(d, id === "p3");
    }
    const prev = state;
    state = step(world, prev, frame, eventsFor(t + 1, prev.tick + 1, opts.spawn));

    for (const id of sortedIds(state.players)) {
      seen.add(id);
      const p = state.players[id]!;
      const before = prev.players[id];
      stats.playerTicks++;
      if (p.mode === "foot") stats.footTicks++;
      const speed = p.car.speed < 0 ? -p.car.speed : p.car.speed;
      if (speed > stats.maxSpeed) stats.maxSpeed = speed;
      if (before) {
        if (p.car.hits > before.car.hits) stats.hits += p.car.hits - before.car.hits;
        const dh = wrapAngle(p.car.heading - before.car.heading);
        stats.turned += dh < 0 ? -dh : dh;
      }
    }
    if ((t + 1) % opts.checkpointEvery === 0) checkpoints.push(`${state.tick}:${hashState(state)}`);
  }
  stats.playersSeen = [...seen].sort();
  stats.agents = agentCount(state);
  return { ticks: opts.ticks, checkpoints, finalHash: hashState(state), finalJson: canonicalJson(state), stats };
}

/** One recorded stretch of a session: an input frame per tick and the events during it (absolute ticks). */
export interface RecordedChunk {
  frames: InputFrame[];
  events: SimEvent[];
}

/**
 * The same scripted session as runScenario, recorded rather than run, for a game that is
 * already going: it starts at tick `startTick` with players `ids` (the running game has only
 * p1), so p2 and p3 join on the first tick, and then the same drivers, p1 script, join/leave
 * schedule and junk input follow, timed from the start. Inputs depend only on the session
 * tick and on who is present, never on the sim state, so the recording is exact.
 * Returned in chunks of `chunkTicks`.
 */
export function recordSession(
  ids: readonly PlayerId[],
  startTick: number,
  opts: { ticks: number; seed: number; spawn: Spawn },
  chunkTicks: number,
): RecordedChunk[] {
  const present = new Set(ids);
  const drivers = new Map<PlayerId, Driver>();
  const chunks: RecordedChunk[] = [];
  let chunk: RecordedChunk = { frames: [], events: [] };
  for (let t = 0; t < opts.ticks; t++) {
    const tick = startTick + t + 1;
    // Inputs for whoever is present before this tick's events, as runScenario does.
    const frame: Record<PlayerId, SimInput> = {};
    for (const id of [...present].sort()) {
      let d = drivers.get(id);
      if (!d) drivers.set(id, (d = newDriver(id, opts.seed)));
      const scripted = id === "p1" ? p1Script(t) : null;
      frame[id] = scripted ?? drive(d, id === "p3");
    }
    const events = eventsFor(t + 1, tick, opts.spawn);
    if (t === 0) {
      if (!present.has("p2")) events.unshift({ tick, kind: "player.join", playerId: "p2", payload: behind(opts.spawn, 10, 4) });
      if (!present.has("p3")) events.unshift({ tick, kind: "player.join", playerId: "p3", payload: behind(opts.spawn, 18, -4) });
    }
    for (const e of events) {
      if (e.kind === "player.join" && e.playerId) present.add(e.playerId);
      else if (e.kind === "player.leave" && e.playerId) present.delete(e.playerId);
    }
    chunk.frames.push(frame);
    chunk.events.push(...events);
    if (chunk.frames.length === chunkTicks || t === opts.ticks - 1) {
      chunks.push(chunk);
      chunk = { frames: [], events: [] };
    }
  }
  return chunks;
}

/**
 * FNV-1a over the exact bit patterns of the sim's deterministic maths (dmath.ts, Math.sqrt)
 * across a sweep of inputs, one digest per function. If the scenario ever diverges between
 * engines, this names the function that differs.
 */
export function dmathDigest(n = 20000): Record<string, string> {
  const buf = new Float64Array(1);
  const words = new Uint32Array(buf.buffer);
  const fns: Record<string, (x: number, i: number) => number> = {
    dsin: (x) => dsin(x),
    dcos: (x) => dcos(x),
    dtan: (x) => dtan(x * 0.2),
    datan: (x) => datan(x),
    datan2: (x, i) => datan2(x, (i % 97) - 48),
    wrapAngle: (x) => wrapAngle(x * 3),
    sqrt: (x) => Math.sqrt(x < 0 ? -x : x),
  };
  const out: Record<string, string> = {};
  for (const name of Object.keys(fns).sort()) {
    const f = fns[name]!;
    let h = 0x811c9dc5;
    for (let i = 0; i < n; i++) {
      // (i - n/2) * k is one correctly rounded IEEE multiply: identical on every engine.
      buf[0] = f((i - n / 2) * 0.00731, i);
      h = Math.imul(h ^ words[0]!, 0x01000193);
      h = Math.imul(h ^ words[1]!, 0x01000193);
    }
    out[name] = (h >>> 0).toString(16).padStart(8, "0");
  }
  // Number -> text in canonical JSON is specified exactly by ECMAScript; check the awkward cases.
  out["hashState"] = hashState({ a: [0.1 + 0.2, 1e21, 5e-324, 123456789.12345679, -1.5e-7, 2 ** 53 + 2], b: "naïve ✓" });
  return out;
}
