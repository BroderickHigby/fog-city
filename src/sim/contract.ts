// THE SIM CONTRACT. Every track builds against this file and schemas/.
// A change here changes save files, replays and netcode: make it deliberately,
// bump SIM_VERSION, and say so in the commit message.
//
// Rules (enforced by tests/sim/*):
//  - step() is pure: it never mutates its inputs and returns a new SimState.
//  - SimState is plain JSON (no Map, class, function, undefined, NaN, Infinity).
//  - src/sim imports nothing from three.js, the DOM, the network or the clock.
//  - Transcendentals come from dmath.ts; randomness from rng.ts with state in SimState.
//  - Iterate players with sortedIds(), never Object.keys order.

// v2 (track/sim): CarState gained handling fields (lateral, yawRate, vy, grounded, airTicks,
// grip, pitch, roll, sinceContact, impactSpeed, landingSpeed, personBumps); PlayerState
// gained foot + exitPending; ext.agents holds ambient traffic (src/sim/agents.ts).
// upgradeState() in step.ts lifts a v1 state to v2.
// v3 (qa/sim): FootState gained vy and grounded: the walker has gravity, a fall state, and
// cannot climb a slope steeper than 1:1 over more than a metre. Cars, walkers and agents stand
// on the drawn ground (each lattice cell's two triangles, src/sim/world.ts meshGroundHeight)
// instead of a bilinear blend, roofs within a step of a body's feet are part of it, and
// collision pushes are capped per tick: v2 replays diverge. upgradeState() lifts v1 and v2
// states to v3.
// v4 (qa/sim, world QA W-02/W-03/W-11/W-12/W-13/W-14): bodies stand on the surface surfaceAt
// picks (src/sim/world.ts): the ground, the highest deck at or below them, a tunnel bore's floor
// (under its ceiling), or a roof within a step. Decks have rails and bores have walls, agents
// ride their edge's deck or bore floor, and cars meet barriers round the stairways. No field
// changes; v3 replays on worlds with decks, tunnels or stairs diverge. upgradeState() lifts
// v1, v2 and v3 states to v4.
export const SIM_VERSION = 4;
export const TICK_HZ = 60;
export const DT = 1 / 60;

export type PlayerId = string;
export type RngState = [number, number, number, number];

/** One player's controls for one tick. The sim clamps every field. */
export interface SimInput {
  /** -1 (full reverse) .. 1 (full forward). On foot: -1 back .. 1 forward. */
  throttle: number;
  /** -1 (left) .. 1 (right). On foot: strafe/turn. */
  steer: number;
  /** 0 .. 1 */
  brake: number;
  /** Bitmask of one-shot actions pressed this tick (see Action). */
  actions: number;
}

export const Action = {
  enterExit: 1 << 0,
  fire: 1 << 1,
  scan: 1 << 2,
  horn: 1 << 3,
} as const;

export const NEUTRAL_INPUT: Readonly<SimInput> = Object.freeze({ throttle: 0, steer: 0, brake: 0, actions: 0 });

/** Every player's input for one tick. A missing player is treated as NEUTRAL_INPUT. */
export type InputFrame = Readonly<Record<PlayerId, SimInput>>;

/**
 * Something from outside the deterministic world that the sim must react to: a live AI
 * reply, a server decision, a player joining. Events carry the tick they apply to and are
 * recorded with the input log, so replays and netcode feed them back identically.
 * payload must be plain JSON.
 */
export interface SimEvent {
  tick: number;
  kind: string;
  playerId?: PlayerId;
  payload?: unknown;
}

export interface CarState {
  x: number;
  /** Height of the car's ground contact point (bottom of the wheels), metres. */
  y: number;
  z: number;
  /** Compass bearing in radians, clockwise from north (-z). Renderer: rotation.y = -heading. */
  heading: number;
  /** m/s along heading; negative when reversing. */
  speed: number;
  /** Current front-wheel angle, radians, + = right. */
  steer: number;
  /** Impact events so far (one per collision, not one per tick in contact). */
  hits: number;
  // ---- v2 additions ----
  /** m/s sideways in the car's frame, + = toward the car's right. Nonzero while sliding. */
  lateral: number;
  /** Yaw rate, rad/s, + = clockwise (turning right). */
  yawRate: number;
  /** Vertical velocity, m/s, + = up. */
  vy: number;
  /** Wheels on the ground (within suspension travel). False while airborne. */
  grounded: boolean;
  /** Ticks airborne in the current jump (0 on the ground). */
  airTicks: number;
  /** Tyre grip 0 (full slide) .. 1 (full grip). Drops on brake+steer at speed, recovers. */
  grip: number;
  /** Body pitch, rad, + = nose up (from the ground under the wheels; held in the air). */
  pitch: number;
  /** Body roll, rad, + = right side down. */
  roll: number;
  /** Ticks since the car last touched a building or obstacle; 0 = touching now. Capped at 600. */
  sinceContact: number;
  /** Speed into the surface (m/s) at the most recent counted impact; 0 if none yet. */
  impactSpeed: number;
  /** Downward speed relative to the ground (m/s) at the most recent landing; 0 if none yet. */
  landingSpeed: number;
  /** Bumps into people. People are never hurt (the car just stops); scoring may charge for it. */
  personBumps: number;
}

/** A player on foot. Present only while PlayerState.mode === "foot". */
export interface FootState {
  x: number;
  /** Height of the walker's feet: on the ground (or a roof) while grounded, in the air while falling. */
  y: number;
  z: number;
  /** Compass bearing, radians, clockwise from north (-z). */
  heading: number;
  /** m/s along heading; negative when stepping back. */
  speed: number;
  /** True while sprinting (brake held). */
  sprint: boolean;
  // ---- v3 additions ----
  /** Vertical velocity, m/s, + = up: the ground's rise along the walk while grounded, gravity while falling. */
  vy: number;
  /** Feet on the ground (or a roof). False while falling, after walking off a drop. */
  grounded: boolean;
}

export interface PlayerState {
  id: PlayerId;
  mode: "vehicle" | "foot";
  /** The player's car. While on foot it stays parked where the player left it. */
  car: CarState;
  /** v2: the walker while mode === "foot", else null. */
  foot: FootState | null;
  /** v2: enterExit was pressed above exit speed; the car brakes and the player exits once slow. */
  exitPending: boolean;
}

export interface SimState {
  version: number;
  tick: number;
  seed: number;
  rng: RngState;
  players: Record<PlayerId, PlayerState>;
  /**
   * Extension slots for later systems (robots, missions, scoring, ...). Each owning
   * system adds exactly one key. Values must be plain JSON.
   */
  ext: Record<string, unknown>;
}

export interface Spawn {
  x: number;
  z: number;
  heading: number;
}

export function sortedIds<T>(rec: Readonly<Record<string, T>>): string[] {
  return Object.keys(rec).sort();
}
