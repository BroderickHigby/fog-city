// How dodging bodies move (the dodge stream, 2026-10-23: "people jump out of the way in too weird
// of a way ... they like fly"). A soak's onTick hook (dodge-soak.ts) feeds every step to a
// DodgeMotion, which measures every person, child and player on foot while they dodge: their
// horizontal speed and acceleration over each tick (an override that puts a body somewhere at once
// counts as the whole distance in one tick), their lift off the ground (the dodge's own hop, and
// independently their height above the surface under them), and the override's leaps. It keeps a
// short trace of the first few dodges for the evidence in docs/shots/dodge-stream/.

import {
  AGENT_SPEC,
  DT,
  agentDodgeClass,
  agentsOf,
  dodgeExtOf,
  surfaceHeight,
  type DodgeState,
  type SimState,
  type World,
} from "../../src/sim/index.ts";

export interface TracePoint {
  tick: number;
  x: number;
  y: number;
  z: number;
  /** Horizontal speed over the tick to here, m/s. */
  speed: number;
  /** Height above the surface under the body, metres. */
  lift: number;
  phase: string;
  leap: boolean;
}

export interface MotionSummary {
  /** Body-ticks measured while dodging. */
  samples: number;
  /** Dodges started (the sim's count) and override leaps. */
  dives: number;
  overrides: number;
  /** Peak and 99th-percentile horizontal speed while dodging, m/s (every tick, override jumps included). */
  peakSpeed: number;
  p99Speed: number;
  /** Peak horizontal speed outside the override's jumps, m/s. */
  peakDiveSpeed: number;
  /** Peak horizontal acceleration while dodging (change of the per-tick velocity), m/s^2, override jumps excluded. */
  peakAccel: number;
  p99Accel: number;
  /** Peak lift above the surface while dodging, metres (independent), and the dodge's own peak hop. */
  peakLift: number;
  peakHop: number;
  /** Longest override jump in one tick, metres. */
  maxLeapM: number;
  /** A few dodges, tick by tick. */
  traces: Array<{ body: string; points: TracePoint[] }>;
}

interface Track {
  vx: number;
  vz: number;
  trace: TracePoint[] | null;
}

const TRACE_BODIES = 6;
const TRACE_TICKS = 150;

export class DodgeMotion {
  private readonly world: World;
  private readonly speeds: number[] = [];
  private readonly accels: number[] = [];
  private peakDive = 0;
  private peakLift = 0;
  private peakHop = 0;
  private maxLeap = 0;
  private readonly tracks = new Map<string, Track>();
  private readonly traces: Array<{ body: string; points: TracePoint[] }> = [];
  private dives = 0;
  private overrides = 0;
  private dives0: number | null = null;
  private overrides0 = 0;

  constructor(world: World) {
    this.world = world;
  }

  /** One step: `before` the state it started from, `after` the state it made. */
  tick(before: SimState, after: SimState): void {
    const ext = dodgeExtOf(after);
    if (this.dives0 === null) {
      const e0 = dodgeExtOf(before);
      this.dives0 = e0.dives;
      this.overrides0 = e0.overrides;
    }
    this.dives = ext.dives - this.dives0;
    this.overrides = ext.overrides - this.overrides0;
    const prev = new Map<string, { x: number; z: number; dodge: DodgeState | null }>();
    for (const a of agentsOf(before)) prev.set(`a${a.id}`, { x: a.x, z: a.z, dodge: a.dodge });
    for (const id of Object.keys(before.players).sort()) {
      const f = before.players[id]!.foot;
      if (f) prev.set(id, { x: f.x, z: f.z, dodge: f.dodge });
    }
    const seen = new Set<string>();
    const bodies: Array<{ key: string; x: number; y: number; z: number; dodge: DodgeState | null }> = [];
    for (const a of agentsOf(after)) {
      if (AGENT_SPEC[a.kind].road) continue;
      const cls = agentDodgeClass(a);
      if (cls !== "person" && cls !== "care") continue;
      bodies.push({ key: `a${a.id}`, x: a.x, y: a.y, z: a.z, dodge: a.dodge });
    }
    for (const id of Object.keys(after.players).sort()) {
      const f = after.players[id]!.foot;
      if (f && f.grounded) bodies.push({ key: id, x: f.x, y: f.y, z: f.z, dodge: f.dodge });
    }
    for (const b of bodies) {
      seen.add(b.key);
      const p = prev.get(b.key);
      if (!p) continue;
      const dodging = b.dodge !== null || p.dodge !== null;
      let tr = this.tracks.get(b.key);
      if (!dodging) {
        if (tr) this.tracks.delete(b.key);
        continue;
      }
      const vx = (b.x - p.x) / DT;
      const vz = (b.z - p.z) / DT;
      const speed = Math.hypot(vx, vz);
      const jump = b.dodge !== null && b.dodge.leap && b.dodge.t === 0;
      if (jump) this.maxLeap = Math.max(this.maxLeap, speed * DT);
      this.speeds.push(speed);
      if (!jump) this.peakDive = Math.max(this.peakDive, speed);
      if (tr && !jump) this.accels.push(Math.hypot(vx - tr.vx, vz - tr.vz) / DT);
      const lift = b.y - surfaceHeight(this.world, b.x, b.z, b.y - (b.dodge?.hop ?? 0));
      this.peakLift = Math.max(this.peakLift, lift);
      this.peakHop = Math.max(this.peakHop, b.dodge?.hop ?? 0);
      if (!tr) {
        tr = { vx: 0, vz: 0, trace: this.traces.length < TRACE_BODIES ? [] : null };
        if (tr.trace) this.traces.push({ body: b.key, points: tr.trace });
        this.tracks.set(b.key, tr);
      }
      tr.vx = vx;
      tr.vz = vz;
      if (tr.trace && tr.trace.length < TRACE_TICKS) {
        tr.trace.push({ tick: after.tick, x: r3(b.x), y: r3(b.y), z: r3(b.z), speed: r3(speed), lift: r3(lift), phase: b.dodge?.phase ?? "done", leap: b.dodge?.leap ?? false });
      }
    }
    for (const k of [...this.tracks.keys()]) if (!seen.has(k)) this.tracks.delete(k);
  }

  summary(): MotionSummary {
    return {
      samples: this.speeds.length,
      dives: this.dives,
      overrides: this.overrides,
      peakSpeed: r3(max(this.speeds)),
      p99Speed: r3(pct(this.speeds, 0.99)),
      peakDiveSpeed: r3(this.peakDive),
      peakAccel: r3(max(this.accels)),
      p99Accel: r3(pct(this.accels, 0.99)),
      peakLift: r3(this.peakLift),
      peakHop: r3(this.peakHop),
      maxLeapM: r3(this.maxLeap),
      traces: this.traces,
    };
  }
}

function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function max(xs: readonly number[]): number {
  let m = 0;
  for (const x of xs) if (x > m) m = x;
  return m;
}

function pct(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}
