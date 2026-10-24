// Which one-shot sounds a frame asks for, read from the sim state the renderer already draws.
// Pure and read-only: sounds follow the sim, never the other way round.

import type { CombatState } from "../sim/combat-contract.ts";

export type EffectSound = "splash" | "melt-fizz" | "rust-creak" | "moat-jingle";

export interface EffectCue {
  sound: EffectSound;
  /** 0..1 before the effects bus: distance attenuation. */
  gain: number;
  /** -1 (left) .. 1 (right) relative to the listener's heading. */
  pan: number;
}

export interface Listener {
  x: number;
  z: number;
  /** Compass bearing, radians clockwise from north (-z). */
  heading: number;
}

/** The fields of a runtime actor the jingle reads. */
export interface HummingActor {
  id: string;
  x: number;
  z: number;
  retired: boolean;
  tellIds: readonly string[];
  hiddenTellId: string | null;
}

/** Splashes heard at full level within this, fading to nothing at SPLASH_RANGE_M. */
export const SPLASH_NEAR_M = 6;
export const SPLASH_RANGE_M = 60;
/** At most this many splashes start per second (the README's "a few per second"). */
export const SPLASH_PER_S = 4;
/** content/bot-tells.json humJingle: every 25 s, within 15 m. */
export const JINGLE_TELL = "humJingle";
export const JINGLE_RANGE_M = 15;
export const JINGLE_INTERVAL_MS = 25_000;
/** Robot sounds carry a long way (they are the game's main feedback). */
export const ROBOT_RANGE_M = 120;

/** Linear fade from 1 at `near` to 0 at `far`. */
export function distanceGain(d: number, near: number, far: number): number {
  if (!(d >= 0)) return 0;
  if (d <= near) return 1;
  if (d >= far) return 0;
  return 1 - (d - near) / (far - near);
}

/** Pan of a point around a listener facing `heading` (+x east, +z south). */
export function panOf(listener: Listener, x: number, z: number): number {
  const dx = x - listener.x, dz = z - listener.z, d = Math.hypot(dx, dz);
  if (d < 1e-6) return 0;
  // Right-hand vector of a compass heading: (cos h, sin h) in (x, z).
  const right = (dx * Math.cos(listener.heading) + dz * Math.sin(listener.heading)) / d;
  return Math.max(-1, Math.min(1, right)) * 0.8;
}

/** Tracks what was already heard, so each event sounds once and splashes stay rate-limited. */
export class EffectCueTracker {
  private lastEventId = 0;
  private readonly waterProjectiles = new Map<number, { x: number; z: number }>();
  private readonly slumped = new Set<string>();
  private readonly humAt = new Map<string, number>();
  private splashTimes: number[] = [];

  /** Forget everything (a save restore): the next state's events are not replayed. */
  reset(state?: CombatState): void {
    this.lastEventId = state?.events.reduce((m, e) => Math.max(m, e.id), 0) ?? 0;
    this.waterProjectiles.clear();
    this.slumped.clear();
    this.humAt.clear();
    this.splashTimes = [];
  }

  /**
   * Cues for this frame. `muted` (paused) consumes events without sounding them, so nothing
   * plays late when the game resumes.
   */
  update(state: CombatState | undefined, listener: Listener, actors: readonly HummingActor[], nowMs: number, muted: boolean): EffectCue[] {
    const cues: EffectCue[] = [];
    if (!state) return cues;
    const at = (x: number, z: number, near: number, far: number): { gain: number; pan: number } =>
      ({ gain: distanceGain(Math.hypot(x - listener.x, z - listener.z), near, far), pan: panOf(listener, x, z) });
    const targetPos = (id: string): { x: number; z: number } | undefined => actors.find((a) => a.id === id);
    for (const event of state.events) {
      if (event.id <= this.lastEventId) continue;
      this.lastEventId = event.id;
      if (muted) continue;
      if (event.kind === "projectile.ended") {
        const p = this.waterProjectiles.get(event.amount);
        this.waterProjectiles.delete(event.amount);
        if (!p || event.detail === "range") continue;
        this.splashTimes = this.splashTimes.filter((t) => nowMs - t < 1000);
        if (this.splashTimes.length >= SPLASH_PER_S) continue;
        const where = at(p.x, p.z, SPLASH_NEAR_M, SPLASH_RANGE_M);
        if (where.gain <= 0) continue;
        this.splashTimes.push(nowMs);
        cues.push({ sound: "splash", ...where });
      } else if (event.kind === "robot.slumping" || event.kind === "robot.heap") {
        // The fizz runs from the slump into the heap: one per robot.
        if (event.kind === "robot.heap" && this.slumped.has(event.targetId)) continue;
        this.slumped.add(event.targetId);
        const pos = targetPos(event.targetId);
        cues.push({ sound: "melt-fizz", ...(pos ? at(pos.x, pos.z, 10, ROBOT_RANGE_M) : { gain: 1, pan: 0 }) });
      } else if (event.kind === "robot.seized") {
        const pos = targetPos(event.targetId);
        cues.push({ sound: "rust-creak", ...(pos ? at(pos.x, pos.z, 10, ROBOT_RANGE_M) : { gain: 1, pan: 0 }) });
      }
    }
    // Remember where each water projectile is; its end event names it by id (event.amount).
    for (const p of state.projectiles) if (p.kind === "water") this.waterProjectiles.set(p.id, { x: p.x, z: p.z });
    if (this.waterProjectiles.size > 512) for (const id of [...this.waterProjectiles.keys()].slice(0, 256)) this.waterProjectiles.delete(id);
    // Bad robots showing the jingle tell hum it when the player is near (tell, subtlety 3).
    for (const actor of actors) {
      if (actor.retired || !actor.tellIds.includes(JINGLE_TELL) || actor.hiddenTellId === JINGLE_TELL) continue;
      const phase = state.targets[actor.id]?.phase;
      if (phase && phase !== "active") continue;
      const d = Math.hypot(actor.x - listener.x, actor.z - listener.z);
      if (d > JINGLE_RANGE_M) continue;
      const last = this.humAt.get(actor.id);
      if (last !== undefined && nowMs - last < JINGLE_INTERVAL_MS) continue;
      // First sighting waits a beat (a few seconds, varied per robot) so a crowd does not hum in unison.
      if (last === undefined) {
        let h = 0;
        for (let i = 0; i < actor.id.length; i++) h = (h * 31 + actor.id.charCodeAt(i)) >>> 0;
        this.humAt.set(actor.id, nowMs - JINGLE_INTERVAL_MS + 2000 + (h % 6000));
        continue;
      }
      this.humAt.set(actor.id, nowMs);
      if (!muted) cues.push({ sound: "moat-jingle", gain: 0.55 * distanceGain(d, 3, JINGLE_RANGE_M), pan: panOf(listener, actor.x, actor.z) });
    }
    return cues;
  }
}
