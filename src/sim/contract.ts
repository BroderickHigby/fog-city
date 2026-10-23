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
// v4 (feature/dodge, the owner's Crazy Taxi rule, 2026-10-21): nobody is ever run over. People,
// animals, robots and players on foot dive out of a vehicle's predicted path (src/sim/dodge.ts),
// and a clearance override places anyone still beside a moving vehicle outside it; cars never
// collide with people. CarState gained nearMisses; FootState gained dodge (a DodgeState or
// null); every ambient agent gained dodge too (src/sim/agents.ts AgentState), and ext.dodge
// holds the counters. v3 replays diverge (cars no longer stop at people). upgradeState() lifts
// v1, v2 and v3 states to v4.
// v6 added shared wave-2 interfaces. v7 combines their saved states with the
// published gravity/dodge schema and fills absent dodge fields without resetting gameplay.
export const SIM_VERSION = 7;
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
  /** Optional compass bearing in radians; absent in legacy logs (use body heading). */
  aimYaw?: number;
  /** Optional pitch in radians, positive upwards; absent uses the weapon's default. */
  aimPitch?: number;
}

export const Action = {
  enterExit: 1 << 0,
  fire: 1 << 1,
  scan: 1 << 2,
  horn: 1 << 3,
  gadget: 1 << 4,
  cone: 1 << 5,
  interact: 1 << 6,
  streak: 1 << 7,
  emote: 1 << 8,
  watch: 1 << 9,
  altFire: 1 << 10,
} as const;

/** Shared names for recorded facts and derived gameplay events; payloads stay plain JSON. */
export const SimEventKind = {
  playerJoin: "player.join",
  playerLeave: "player.leave",
  robotMelted: "robot.melted",
  updateInterrupted: "update.interrupted",
  playerDown: "player.down",
} as const;
export type KnownSimEventKind = typeof SimEventKind[keyof typeof SimEventKind];

/** The known subset; SimEvent also accepts future recorded event names. */
export type KnownSimEvent = SimEvent & { kind: KnownSimEventKind };

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
  /**
   * Contacts with people. Since v4 cars never collide with people (they dive out of the way,
   * and the clearance override places anyone still beside a moving car outside it), so this
   * counts a person found inside the car's body before the override moved them: it stays 0.
   */
  personBumps: number;
  // ---- v4 additions ----
  /** People, animals and robots that dived (or were leapt) out of this car's way: for scoring and barks. */
  nearMisses: number;
}

/**
 * v4: a body getting out of a vehicle's way (src/sim/dodge.ts): a dive to a clear spot, then a
 * moment to recover. While it lasts the body ignores its own controls (a player) or its path (an
 * agent), and its y includes the hop.
 */
export interface DodgeState {
  /** "dive": in the air, from (sx, sz) to (tx, tz); "recover": landed, getting up. */
  phase: "dive" | "recover";
  sx: number;
  sz: number;
  tx: number;
  tz: number;
  /** Ticks into this phase, and the phase's length in ticks. */
  t: number;
  dur: number;
  /** Peak height of the hop, metres. */
  peak: number;
  /** Height above the ground now, metres (0 while recovering). */
  hop: number;
  /**
   * The clearance override put it at (tx, tz) at once: a superhuman leap (renderers draw it as
   * a big hop over the arc). Otherwise it moves from (sx, sz) to (tx, tz) over the dive.
   */
  leap: boolean;
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
  // ---- v4 additions ----
  /** Diving out of a car's way (or getting up after it), else null. */
  dodge: DodgeState | null;
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
  ext: import("./extensions.ts").SimExtensions;
}

export interface Spawn {
  x: number;
  z: number;
  heading: number;
}

export function sortedIds<T>(rec: Readonly<Record<string, T>>): string[] {
  return Object.keys(rec).sort();
}
