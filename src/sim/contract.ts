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
// v6: optional aim, actions and typed subsystem interfaces.
// v7: bring the reviewed gravity/roof support and no-contact dodge into wave 2.
// Older QA/dodge branches used overlapping 3/4/5 stamps; migration preserves existing
// fields and supplies only missing vertical/dodge fields before advancing to v7.
// v8: composed gameplay admits and retires actors consistently, applies combat motion effects,
// and observes mission outcomes. No saved fields are removed or reset by this upgrade.
// v9 was reserved for the structural world and is never written; it landed as v11.
// v10: wave-3 weather (src/sim/fog): seeded marine layer, winter rain, wet-road traction, rain
// puddles, shelter, the King tide's flooded promenade, rain breaking phone hacks and the
// per-shot wet rule. ext.fog gains its typed shape; an upgraded v8 save keeps every field and
// the fog reducer fills ext.fog on its first tick.
// v11: consume structural world surfaces and collider-pack extensions: deck/bore floors,
// stair barriers and inland water. Saved fields are unchanged; physical replays are versioned.
export const SIM_VERSION = 11;
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
  gear: 1 << 11,
} as const;

/** Shared names for recorded facts and derived gameplay events; payloads stay plain JSON. */
export const SimEventKind = {
  playerJoin: "player.join",
  playerLeave: "player.leave",
  robotMelted: "robot.melted",
  updateInterrupted: "update.interrupted",
  playerDown: "player.down",
  /** A recorded player command (gameplay-contract.ts GameplayCommandEvent): ids and integers only. */
  gameplayCommand: "gameplay.command",
  /**
   * Heat asking the agents runtime for pursuers (gameplay-contract.ts ThreatSpawnRequest). Derived
   * by the heat reducer into ext.heat.events rather than recorded, but named here so emitter and
   * consumer cannot drift apart. Its payload carries ids and integers only (whole metres).
   */
  threatSpawn: "threat.spawn",
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
  /**
   * Optional height of the surface the car should stand on (a deck, a tunnel floor, a roof), as
   * a hint: recovery keeps the car on that level instead of the bare ground under or over it.
   * Absent means the ground. (Additive in v11.)
   */
  y?: number;
}

export function sortedIds<T>(rec: Readonly<Record<string, T>>): string[] {
  return Object.keys(rec).sort();
}
