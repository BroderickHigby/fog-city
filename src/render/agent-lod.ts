// The pure half of the agent renderer (agent-layer.ts draws; this decides). No three.js, so
// tests/render/agent-lod.test.ts runs it without WebGL.
//
// Tiers (documented rule):
//  - near: the NEAR_CAP agents nearest the camera within NEAR_RANGE_M get the full model,
//    animated (wheels roll and steer, Footman (errand-robot) limbs swing, people walk). An
//    agent already near keeps its place until
//    it is NEAR_HYSTERESIS_M farther than that (no flicker at the boundary). Agents more than
//    BEHIND_M behind the camera are never near: a full model nobody can see is wasted.
//  - mid: every other agent within MID_RANGE_M is drawn as a simplified copy of its model
//    (vertex-clustered, rest pose, lights kept).
//  - far: beyond that, to FAR_RANGE_M, a hand-built box proxy of ~100 triangles with the
//    model's colours and lights. Beyond FAR_RANGE_M (deep in the fog) nothing is drawn.
// Both tiers are instanced (one InstancedMesh per part), so the draw-call cost does not grow
// with the number of agents.

import type { AgentKind, AgentMode, AgentState } from "../sim/agents.ts";
import { AGENT_SPEC, LOD_STRIDE, NEAR_RANGE_M as SIM_NEAR_RANGE_M } from "../sim/agents.ts";
import { DT } from "../sim/contract.ts";

export const NEAR_RANGE_M = 60;
export const NEAR_CAP = 16;
export const NEAR_HYSTERESIS_M = 6;
export const MID_RANGE_M = 140;
export const FAR_RANGE_M = 450;
/** Agents farther than this behind the camera plane are not given a full model. */
export const BEHIND_M = 12;
/** A move longer than this between two ticks is a jump (respawn, turnaround): not interpolated. */
export const JUMP_M = 12;

export interface AgentPose {
  x: number;
  y: number;
  z: number;
  /** Compass bearing, radians clockwise from north. */
  heading: number;
  pitch: number;
  speed: number;
}

function wrapPi(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r > Math.PI) r -= t;
  else if (r < -Math.PI) r += t;
  return r;
}

/**
 * The pose between two ticks: `a` is the agent in the previous state (null when it has just
 * spawned), `b` in the current one, alpha 0..1 the fraction of a tick elapsed since `b`'s tick.
 */
export function interpolateAgent(
  a: Readonly<Pick<AgentState, "x" | "y" | "z" | "heading" | "pitch" | "speed">> | null,
  b: Readonly<Pick<AgentState, "x" | "y" | "z" | "heading" | "pitch" | "speed">>,
  alpha: number,
  out: AgentPose,
): AgentPose {
  const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  if (!a || (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z) > JUMP_M * JUMP_M) {
    out.x = b.x;
    out.y = b.y;
    out.z = b.z;
    out.heading = b.heading;
    out.pitch = b.pitch;
    out.speed = b.speed;
    return out;
  }
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.heading = a.heading + wrapPi(b.heading - a.heading) * t;
  out.pitch = a.pitch + (b.pitch - a.pitch) * t;
  out.speed = a.speed + (b.speed - a.speed) * t;
  return out;
}

// ---------------------------------------------------------------- far agents' stride

type PoseLike = Readonly<Pick<AgentState, "x" | "y" | "z" | "heading" | "pitch" | "speed">>;

/**
 * The sim step an agent is being drawn across. The sim (src/sim/agents.ts, documented rule)
 * steps an agent farther than its NEAR_RANGE_M (200 m) from every player only on ticks where
 * (tick + id) % LOD_STRIDE === 0, by LOD_STRIDE ticks' worth, so interpolating prev -> curr
 * per tick holds it still for three ticks and then jumps (15 Hz stop-go in long views and the
 * fly camera). Instead each agent keeps its last step, from where it was to where it landed,
 * the tick it landed and how many ticks it covers, and is drawn across that whole window:
 * one tick for a near agent (exactly prev -> curr), LOD_STRIDE ticks for a far one, ending
 * where its next step starts. The price is LOD_STRIDE - 1 ticks (50 ms) of lag, only on
 * agents more than 200 m from every player.
 */
export interface StepWindow {
  from: PoseLike | null;
  to: PoseLike;
  /** The tick the step landed on (curr.tick when it was seen). */
  tick: number;
  /** Ticks the step covers: 1, or LOD_STRIDE for a far agent's step. */
  stride: number;
  /** The last tick this agent was seen (for pruning). */
  seen: number;
}

/** Whether the sim steps an agent at (x, z) on the far stride: beyond its near range of every player body. */
export function onFarStride(bodies: readonly Readonly<{ x: number; z: number }>[], x: number, z: number): boolean {
  if (bodies.length === 0) return false; // no players: the sim freezes every agent
  const r2 = SIM_NEAR_RANGE_M * SIM_NEAR_RANGE_M;
  for (const b of bodies) if ((b.x - x) * (b.x - x) + (b.z - z) * (b.z - z) <= r2) return false;
  return true;
}

function samePose(a: PoseLike, b: PoseLike): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.heading === b.heading;
}

/**
 * Update an agent's window for a new tick: `a` is the agent in the previous state (null when
 * new), `b` in the current one at `tick`, `far` = onFarStride() for `a` and the previous
 * state's player bodies (what the sim decides with). Mutates and returns `w` (or a new one).
 */
export function trackStep(w: StepWindow | undefined, a: PoseLike | null, b: PoseLike, id: number, tick: number, far: boolean): StepWindow {
  const out = w ?? { from: null, to: b, tick, stride: 1, seen: tick };
  out.seen = tick;
  if (a && far) {
    if ((tick + id) % LOD_STRIDE === 0) {
      out.from = a;
      out.to = b;
      out.tick = tick;
      out.stride = LOD_STRIDE;
      return out;
    }
    // Between its steps a far agent does not move: keep gliding across the last step.
    if (w && samePose(b, w.to) && tick > w.tick) return out;
  }
  out.from = a;
  out.to = b;
  out.tick = tick;
  out.stride = 1;
  return out;
}

/** How far across its window an agent is drawn: alpha (0..1 past `tick`) for a one-tick window. */
export function windowAlpha(w: Readonly<StepWindow>, tick: number, alpha: number): number {
  const t = (tick - w.tick + alpha) / w.stride;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export interface TierOptions {
  nearRange: number;
  nearCap: number;
  hysteresis: number;
  midRange: number;
  farRange: number;
  behind: number;
}

export const DEFAULT_TIERS: Readonly<TierOptions> = Object.freeze({
  nearRange: NEAR_RANGE_M,
  nearCap: NEAR_CAP,
  hysteresis: NEAR_HYSTERESIS_M,
  midRange: MID_RANGE_M,
  farRange: FAR_RANGE_M,
  behind: BEHIND_M,
});

export const TIER_HIDDEN = 0;
export const TIER_FAR = 1;
export const TIER_MID = 2;
export const TIER_NEAR = 3;
export type Tier = typeof TIER_HIDDEN | typeof TIER_FAR | typeof TIER_MID | typeof TIER_NEAR;

/** Where the camera is and which way it looks (horizontal unit vector, compass frame). */
export interface Viewer {
  x: number;
  z: number;
  fx: number;
  fz: number;
}

/**
 * Assign each agent a tier. `xs`/`zs`/`ids` describe `n` agents; `wasNear` holds the ids that
 * were near last frame. Writes tiers[i] and returns the number of near agents. Pure apart from
 * the output arrays and `scratch` (reused index storage, at least n long).
 */
export function selectTiers(
  n: number,
  ids: ArrayLike<number>,
  xs: ArrayLike<number>,
  zs: ArrayLike<number>,
  viewer: Readonly<Viewer>,
  wasNear: ReadonlySet<number>,
  opts: Readonly<TierOptions>,
  tiers: Uint8Array,
  scratch: { idx: Int32Array; key: Float64Array },
): number {
  const far2 = opts.farRange * opts.farRange;
  const mid2 = opts.midRange * opts.midRange;
  let candidates = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - viewer.x;
    const dz = zs[i]! - viewer.z;
    const d2 = dx * dx + dz * dz;
    tiers[i] = d2 <= mid2 ? TIER_MID : d2 <= far2 ? TIER_FAR : TIER_HIDDEN;
    const d = Math.sqrt(d2);
    const eff = wasNear.has(ids[i]!) ? d - opts.hysteresis : d;
    if (eff > opts.nearRange) continue;
    const ahead = dx * viewer.fx + dz * viewer.fz;
    if (ahead < -opts.behind) continue;
    scratch.idx[candidates] = i;
    scratch.key[i] = eff;
    candidates++;
  }
  // Nearest first (ties by id), keep nearCap. candidates is small (tens): insertion sort.
  const idx = scratch.idx;
  for (let a = 1; a < candidates; a++) {
    const v = idx[a]!;
    const kv = scratch.key[v]!;
    let b = a - 1;
    while (b >= 0) {
      const u = idx[b]!;
      const ku = scratch.key[u]!;
      if (ku < kv || (ku === kv && ids[u]! < ids[v]!)) break;
      idx[b + 1] = u;
      b--;
    }
    idx[b + 1] = v;
  }
  const near = Math.min(candidates, opts.nearCap);
  for (let k = 0; k < near; k++) tiers[idx[k]!] = TIER_NEAR;
  return near;
}

/**
 * The most agents a tier draws in one frame: near is capped at `nearCap`; mid and far must be
 * able to hold every agent the sim can have (`maxAgents`), since any of them can be there.
 */
export function tierCapacity(tier: Tier, opts: Readonly<Pick<TierOptions, "nearCap">>, maxAgents: number): number {
  if (tier === TIER_HIDDEN) return 0;
  return tier === TIER_NEAR ? Math.min(opts.nearCap, maxAgents) : maxAgents;
}

/**
 * Instances one part's InstancedMesh holds: `perAgent` instances (a person's two arms, say)
 * for each of `agents`, never more than `limit`. AgentLayer allocates every part with this,
 * from tierCapacity(), and a full mesh refuses further instances for the frame.
 */
export function instanceBudget(agents: number, perAgent: number, limit = Infinity): number {
  return Math.max(0, Math.min(Math.floor(agents) * Math.floor(perAgent), limit));
}

// ---------------------------------------------------------------- animation

/** Wheel angle after rolling `distance` metres (README: rotation.x -= distance / radius), kept in [-pi, pi]. */
export function rollWheel(angle: number, distance: number, radius: number): number {
  return wrapPi(angle - distance / Math.max(radius, 1e-3));
}

/** Front-wheel angle (+ = right) that explains a yaw rate at a speed (bicycle model), clamped. */
export function steerFromYaw(yawRate: number, speed: number, wheelbase: number, max = 0.6): number {
  const v = Math.abs(speed);
  if (v < 0.5) return 0;
  const s = Math.atan((wheelbase * yawRate) / v) * Math.sign(speed);
  return s > max ? max : s < -max ? -max : s;
}

/** Walk cycle: phase advances one full cycle (two steps) per `strideM` * 2 metres. */
export function advanceGait(phase: number, distance: number, strideM: number): number {
  return (phase + (Math.abs(distance) / (2 * strideM)) * Math.PI * 2) % (Math.PI * 2);
}

/** Limb swing amplitude for a walking speed: 0 standing, 1 at `cruise` or faster. */
export function gaitAmount(speed: number, cruise: number): number {
  const a = Math.abs(speed) / Math.max(cruise, 1e-3);
  return a > 1 ? 1 : a;
}

/** Mode cues: brake lights (wait or yield, or slowing hard) and a hazard/status flash (honk). */
export interface AgentCue {
  brake: number;
  flash: number;
  /** Combat presentation (render-only, runtime-actors.ts): rust 0..1 and wetness 0..1, set by the caller; agentCue leaves them alone. */
  rust?: number;
  wet?: number;
  /** Render time (s) until which slowing keeps the brake lights on; carried per agent between frames. */
  brakeUntil: number;
}

/** Hazards blink at this rate, Hz. */
export const FLASH_HZ = 1.6;
/** Slowing harder than this reads as braking, m/s^2. */
export const BRAKE_DECEL = 2.4;
/** Once slowing lights them, the brake lights stay on at least this long, seconds. */
export const BRAKE_HOLD_S = 0.35;

/**
 * Deceleration between two ticks, m/s^2 (0 when not slowing), from the speed change over the
 * distance covered: (v0^2 - v1^2) / 2d. Measured over distance rather than per tick, it reads
 * the same for an agent the sim steps every tick and for a far one it steps only every
 * LOD_STRIDE ticks by LOD_STRIDE * DT (whose speed changes in one jump, then holds). The
 * distance is never taken as less than one tick at the mean speed, so a stop is finite.
 */
export function slowingRate(prevSpeed: number, speed: number, distance: number): number {
  const v0 = Math.abs(prevSpeed);
  const v1 = Math.abs(speed);
  if (!(v0 > v1)) return 0;
  const d = Math.max(Math.abs(distance), ((v0 + v1) / 2) * DT);
  return (v0 * v0 - v1 * v1) / (2 * d);
}

/**
 * The cue for one agent this frame. `distance` is how far it moved between the two ticks,
 * `timeS` the render clock and `brakeUntil` the hold carried from earlier frames (out.brakeUntil
 * is the new one). Brake lights: wait or yield, or slowing harder than BRAKE_DECEL, then held
 * BRAKE_HOLD_S, so an agent stepped every few ticks does not flash them. Hazards: honk.
 */
export function agentCue(
  kind: AgentKind,
  mode: AgentMode,
  prevSpeed: number,
  speed: number,
  distance: number,
  timeS: number,
  brakeUntil: number,
  out: AgentCue,
): AgentCue {
  out.brake = 0;
  out.flash = 0;
  out.brakeUntil = brakeUntil;
  if (!AGENT_SPEC[kind].road) return out;
  if (slowingRate(prevSpeed, speed, distance) > BRAKE_DECEL) out.brakeUntil = Math.max(brakeUntil, timeS + BRAKE_HOLD_S);
  if (mode === "wait" || mode === "yield" || timeS < out.brakeUntil) out.brake = 1;
  if (mode === "honk") out.flash = (timeS * FLASH_HZ) % 1 < 0.5 ? 1 : 0;
  return out;
}

/**
 * Uniform scale for a kind's model so it matches AGENT_SPEC: road vehicles take the spec body
 * length exactly (bumper to bumper); walkers keep their designed size unless their footprint
 * is more than 20% larger than the spec body, in which case they shrink to fit.
 */
export function agentModelScale(kind: AgentKind, size: { length: number; width: number }): number {
  const spec = AGENT_SPEC[kind];
  const L = spec.halfLength * 2;
  const W = spec.halfWidth * 2;
  if (!(size.length > 0) || !(size.width > 0)) return 1;
  if (spec.road) return L / size.length;
  const over = Math.max(size.length / L, size.width / W);
  return over > 1.2 ? 1.2 / over : 1;
}
