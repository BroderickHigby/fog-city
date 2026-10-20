// The agent renderer's pure parts: interpolation between ticks, tier (LOD) selection and
// instance budgets, the animation helpers, mode cues, model scale, and the far-proxy simplifier.
import { describe, expect, it } from "vitest";
import {
  BRAKE_DECEL,
  BRAKE_HOLD_S,
  DEFAULT_TIERS,
  FLASH_HZ,
  JUMP_M,
  TIER_FAR,
  TIER_HIDDEN,
  TIER_MID,
  TIER_NEAR,
  advanceGait,
  agentCue,
  agentModelScale,
  gaitAmount,
  instanceBudget,
  interpolateAgent,
  rollWheel,
  selectTiers,
  slowingRate,
  steerFromYaw,
  tierCapacity,
  type AgentCue,
  type AgentPose,
  type Viewer,
} from "../../src/render/agent-lod.ts";
import { clusterSimplify } from "../../src/render/simplify.ts";
import { AGENT_SPEC, LOD_STRIDE, MAX_AGENTS } from "../../src/sim/agents.ts";
import { DT } from "../../src/sim/contract.ts";

const pose = (): AgentPose => ({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, speed: 0 });
const at = (x: number, z: number, heading = 0, speed = 10) => ({ x, y: 1, z, heading, pitch: 0.02, speed });

describe("interpolateAgent", () => {
  it("blends position, height, pitch and speed linearly between two ticks", () => {
    const p = interpolateAgent(at(0, 0, 0, 10), { x: 1, y: 3, z: -2, heading: 0, pitch: 0.1, speed: 12 }, 0.25, pose());
    expect(p.x).toBeCloseTo(0.25, 12);
    expect(p.y).toBeCloseTo(1.5, 12);
    expect(p.z).toBeCloseTo(-0.5, 12);
    expect(p.pitch).toBeCloseTo(0.02 + 0.08 * 0.25, 12);
    expect(p.speed).toBeCloseTo(10.5, 12);
  });

  it("turns the short way across north", () => {
    const p = interpolateAgent(at(0, 0, Math.PI * 2 - 0.1), at(0, 0, 0.1), 0.5, pose());
    expect(Math.cos(p.heading)).toBeCloseTo(1, 9);
    expect(Math.sin(p.heading)).toBeCloseTo(0, 9);
  });

  it("uses the current tick for a new agent (null previous) and for a jump", () => {
    const b = at(5, 5, 1);
    expect(interpolateAgent(null, b, 0.3, pose())).toMatchObject({ x: 5, z: 5, heading: 1 });
    expect(interpolateAgent(at(5 + JUMP_M + 1, 5), b, 0.3, pose())).toMatchObject({ x: 5, z: 5 });
  });

  it("clamps alpha to the two ticks", () => {
    expect(interpolateAgent(at(0, 0), at(2, 0), 7, pose()).x).toBe(2);
    expect(interpolateAgent(at(0, 0), at(2, 0), -1, pose()).x).toBe(0);
  });
});

describe("selectTiers", () => {
  const viewer: Viewer = { x: 0, z: 0, fx: 0, fz: -1 }; // looking north
  function run(points: Array<[number, number]>, wasNear: Set<number> = new Set(), opts = DEFAULT_TIERS) {
    const n = points.length;
    const ids = Int32Array.from(points.map((_, i) => i + 1));
    const xs = Float64Array.from(points.map((p) => p[0]));
    const zs = Float64Array.from(points.map((p) => p[1]));
    const tiers = new Uint8Array(n);
    const near = selectTiers(n, ids, xs, zs, viewer, wasNear, opts, tiers, { idx: new Int32Array(n), key: new Float64Array(n) });
    return { near, tiers: [...tiers] };
  }

  it("gives the full model to agents within range, proxies farther out, nothing beyond the far range", () => {
    const r = run([
      [0, -10],
      [0, -100],
      [0, -300],
      [0, -600],
    ]);
    expect(r.tiers).toEqual([TIER_NEAR, TIER_MID, TIER_FAR, TIER_HIDDEN]);
    expect(r.near).toBe(1);
  });

  it("caps the near tier at the nearest NEAR_CAP agents (ties by id)", () => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 40; i++) pts.push([0, -(5 + i)]);
    pts.push([3, -5]); // same distance band as the first, later id
    const r = run(pts);
    expect(r.near).toBe(DEFAULT_TIERS.nearCap);
    const nearIdx = r.tiers.map((t, i) => (t === TIER_NEAR ? i : -1)).filter((i) => i >= 0);
    expect(nearIdx).toEqual([0, 1, 2, 3, 4, 40, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].sort((a, b) => a - b));
    // Everyone else in range still gets a proxy.
    expect(r.tiers.filter((t) => t === TIER_MID).length).toBe(41 - DEFAULT_TIERS.nearCap);
  });

  it("keeps an agent near until it is past the range plus hysteresis (no flicker)", () => {
    const d = DEFAULT_TIERS.nearRange + DEFAULT_TIERS.hysteresis / 2;
    expect(run([[0, -d]]).tiers[0]).toBe(TIER_MID);
    expect(run([[0, -d]], new Set([1])).tiers[0]).toBe(TIER_NEAR);
    expect(run([[0, -(DEFAULT_TIERS.nearRange + DEFAULT_TIERS.hysteresis + 1)]], new Set([1])).tiers[0]).toBe(TIER_MID);
  });

  it("does not spend full models on agents well behind the camera", () => {
    const r = run([
      [0, 30],
      [0, 5],
      [20, 0],
    ]);
    expect(r.tiers).toEqual([TIER_MID, TIER_NEAR, TIER_NEAR]);
  });

  it("handles no agents", () => {
    expect(run([]).near).toBe(0);
  });
});

describe("instance budgets", () => {
  it("is agents x instances per agent, never above the limit", () => {
    expect(instanceBudget(10, 2, 32)).toBe(20);
    expect(instanceBudget(20, 2, 32)).toBe(32);
    expect(instanceBudget(0, 5, 32)).toBe(0);
    expect(instanceBudget(16, 2)).toBe(32);
    expect(instanceBudget(-3, 2)).toBe(0);
  });

  it("lets near hold nearCap agents, and mid and far every agent the sim can have", () => {
    expect(tierCapacity(TIER_NEAR, DEFAULT_TIERS, MAX_AGENTS)).toBe(DEFAULT_TIERS.nearCap);
    expect(tierCapacity(TIER_MID, DEFAULT_TIERS, MAX_AGENTS)).toBe(MAX_AGENTS);
    expect(tierCapacity(TIER_FAR, DEFAULT_TIERS, MAX_AGENTS)).toBe(MAX_AGENTS);
    expect(tierCapacity(TIER_HIDDEN, DEFAULT_TIERS, MAX_AGENTS)).toBe(0);
    expect(tierCapacity(TIER_NEAR, { nearCap: 900 }, MAX_AGENTS)).toBe(MAX_AGENTS);
  });
});

describe("animation helpers", () => {
  it("rolls a wheel backwards about +x as it moves forward (README: rotation.x -= distance / radius)", () => {
    expect(rollWheel(0, 0.35, 0.35)).toBeCloseTo(-1, 12);
    expect(rollWheel(0, -0.35, 0.35)).toBeCloseTo(1, 12);
    const a = rollWheel(3, 1, 0.1);
    expect(a).toBeGreaterThanOrEqual(-Math.PI);
    expect(a).toBeLessThanOrEqual(Math.PI);
    expect(Math.cos(a)).toBeCloseTo(Math.cos(3 - 10), 9);
  });

  it("steers the front wheels the way the agent turns, within the lock", () => {
    expect(steerFromYaw(0.2, 10, 2.9)).toBeGreaterThan(0); // clockwise yaw = right
    expect(steerFromYaw(-0.2, 10, 2.9)).toBeLessThan(0);
    expect(steerFromYaw(0.2, 10, 2.9)).toBeCloseTo(Math.atan(0.058), 9);
    expect(steerFromYaw(5, 2, 2.9)).toBe(0.6);
    expect(steerFromYaw(1, 0.1, 2.9)).toBe(0); // standing still: wheels straight
  });

  it("advances the gait one cycle per two strides, and swings fully only at cruise speed", () => {
    expect(advanceGait(0, 0.7, 0.7)).toBeCloseTo(Math.PI, 12); // one stride: half a cycle
    expect(advanceGait(0, -0.7, 0.7)).toBeCloseTo(Math.PI, 12);
    expect(advanceGait(0, 1.4, 0.7)).toBeCloseTo(0, 12); // two strides: the cycle repeats
    expect(gaitAmount(0, 1.3)).toBe(0);
    expect(gaitAmount(0.65, 1.3)).toBeCloseTo(0.5, 12);
    expect(gaitAmount(3, 1.3)).toBe(1);
  });
});

describe("agentCue", () => {
  const cue = (): AgentCue => ({ brake: 0, flash: 0, brakeUntil: 0 });
  const NONE = -Infinity;
  it("lights robotaxi brake lights while waiting, yielding or slowing hard", () => {
    expect(agentCue("robotaxi", "wait", 0, 0, 0, 0, NONE, cue()).brake).toBe(1);
    expect(agentCue("robotaxi", "yield", 3, 3, 3 * DT, 0, NONE, cue()).brake).toBe(1);
    // 10 -> 9.8 m/s in one tick: 12 m/s^2.
    expect(agentCue("robotaxi", "go", 10, 9.8, 9.8 * DT, 0, NONE, cue()).brake).toBe(1);
    expect(agentCue("robotaxi", "go", 10, 10.05, 10.05 * DT, 0, NONE, cue()).brake).toBe(0);
    // Coming to a stop in place is braking, and finite.
    expect(slowingRate(2, 0, 0)).toBeCloseTo(2 / DT, 6);
  });

  it("measures slowing over the distance moved, so a far agent stepped every LOD_STRIDE ticks reads like a near one", () => {
    for (const decel of [1, 2, 6]) {
      const near = slowingRate(12, 12 - decel * DT, (12 - decel * DT) * DT);
      const v1 = 12 - decel * DT * LOD_STRIDE;
      const far = slowingRate(12, v1, v1 * DT * LOD_STRIDE);
      // Within 5% (the sim moves by the new speed, so (v0^2 - v1^2) / 2d reads a little high).
      expect(Math.abs(near / decel - 1), `${decel} m/s^2, every tick: ${near}`).toBeLessThan(0.05);
      expect(Math.abs(far / decel - 1), `${decel} m/s^2, every ${LOD_STRIDE}th tick: ${far}`).toBeLessThan(0.05);
      const lit = (prev: number, v: number, d: number) => agentCue("robotaxi", "go", prev, v, d, 0, NONE, cue()).brake;
      expect(lit(12, v1, v1 * DT * LOD_STRIDE), `${decel} m/s^2 far`).toBe(decel > BRAKE_DECEL ? 1 : 0);
    }
  });

  it("holds the brake lights between a far agent's steps instead of flashing them, then lets go", () => {
    // A far robotaxi braking at 5 m/s^2: the sim moves it every LOD_STRIDE-th tick by
    // LOD_STRIDE * DT and leaves it alone in between; the renderer sees one tick per frame.
    let v = 12;
    let held = NONE;
    const lit: number[] = [];
    for (let t = 1; t <= 48; t++) {
      const prev = v;
      let d = 0;
      if (t % LOD_STRIDE === 0 && t <= 16) {
        v -= 5 * DT * LOD_STRIDE;
        d = v * DT * LOD_STRIDE;
      }
      const c = agentCue("robotaxi", "go", prev, v, d, t * DT, held, cue());
      held = c.brakeUntil;
      lit.push(c.brake);
    }
    // Dark until the first step, then lit without a gap while it brakes.
    expect(lit.slice(0, LOD_STRIDE - 1)).toEqual([0, 0, 0]);
    expect(lit.slice(LOD_STRIDE - 1, 16)).toEqual(new Array(16 - LOD_STRIDE + 1).fill(1));
    // Off BRAKE_HOLD_S after the last slowing step (tick 16).
    const off = lit.findIndex((b, i) => i >= 16 && b === 0) + 1;
    expect(off * DT - 16 * DT).toBeCloseTo(BRAKE_HOLD_S, 1);
  });

  it("flashes the hazards and status light on honk, on and off at FLASH_HZ", () => {
    const on = agentCue("robotaxi", "honk", 0, 0, 0, 0.1 / FLASH_HZ, NONE, cue());
    const off = agentCue("robotaxi", "honk", 0, 0, 0, 0.6 / FLASH_HZ, NONE, cue());
    expect([on.flash, off.flash]).toEqual([1, 0]);
  });

  it("gives walkers no vehicle cues", () => {
    expect(agentCue("person", "wait", 1, 0, 0, 0, NONE, cue())).toEqual({ brake: 0, flash: 0, brakeUntil: NONE });
    expect(agentCue("errandRobot", "yield", 1, 0, 0, 0, NONE, cue())).toEqual({ brake: 0, flash: 0, brakeUntil: NONE });
  });
});

describe("agentModelScale", () => {
  it("makes a robotaxi exactly as long as the sim's body", () => {
    const s = agentModelScale("robotaxi", { length: 4.79, width: 2.21 });
    expect(4.79 * s).toBeCloseTo(AGENT_SPEC.robotaxi.halfLength * 2, 9);
  });

  it("keeps a walker's designed size when it fits the spec body, shrinks it when far too big", () => {
    expect(agentModelScale("errandRobot", { length: 0.34, width: 0.6 })).toBe(1);
    const big = agentModelScale("sidewalkBot", { length: 2, width: 0.6 });
    expect(2 * big).toBeCloseTo(AGENT_SPEC.sidewalkBot.halfLength * 2 * 1.2, 9);
    expect(agentModelScale("person", { length: 0, width: 0 })).toBe(1);
  });
});

describe("clusterSimplify", () => {
  // A 10 x 10 grid of quads (200 triangles) in the xz plane over 1 m.
  function grid(n: number): { pos: number[]; idx: number[] } {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i / n, 0, j / n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
    }
    return { pos, idx };
  }

  it("collapses triangles inside one cell and keeps the surface's extent", () => {
    const { pos, idx } = grid(10);
    const r = clusterSimplify(pos, idx, 0.25);
    expect(r.source.length).toBeGreaterThan(0);
    expect(r.source.length).toBeLessThan(200 / 4);
    expect(r.positions.length).toBe(r.source.length * 9);
    const xs = [...r.positions].filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeLessThan(0.15);
    expect(Math.max(...xs)).toBeGreaterThan(0.85);
  });

  it("passes kept triangles (lamps) through untouched, and is unchanged with a tiny cell", () => {
    const { pos, idx } = grid(4);
    const all = clusterSimplify(pos, idx, 1e-4);
    expect(all.source.length).toBe(32);
    const kept = clusterSimplify(pos, idx, 10, (t) => t === 7);
    expect([...kept.source]).toEqual([7]);
    const v = idx.slice(21, 24);
    expect([...kept.positions]).toEqual(v.flatMap((k) => pos.slice(k * 3, k * 3 + 3)));
  });

  it("keeps both faces of a two-sided sheet (opposite windings are different triangles)", () => {
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const r = clusterSimplify(pos, [0, 1, 2, 0, 2, 1], 0.1);
    expect(r.source.length).toBe(2);
  });
});
