// How a dodge is drawn (src/render/dodge-pose.ts): people dive with their arms out ahead, flip
// over tucked in the air, land on their feet and come up startled; the override's leap follows
// its arc with a flip (a short one is a stumble-hop); robots skid and hop. The poses flow from one
// into the next (no snap at a phase change) and end where the walk takes over again, and nobody
// is ever drawn lying still or limp, stretched flat near the ground, or upended: it must read as a
// comic leap, never as someone knocked down (the adversarial review, 2026-10-21). The dive is
// drawn higher than the sim's hop with a shadow on the ground under it, so the air shows.
import { describe, expect, it } from "vitest";
import { AIR_LIFT_M, SHORT_LEAP_M, STRETCH_HOP_M, diveBearing, drawnHop, newPersonPose, newRobotPose, personDodgePose, progress, robotDodgePose, type DodgeLike, type PersonPose } from "../../src/render/dodge-pose.ts";

const TAU = Math.PI * 2;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** A dive east (bearing pi/2) from the origin, 2.4 m, 18 ticks; then 60 ticks of recovery. */
const dive = (t: number, leap = false): DodgeLike => ({ phase: "dive", sx: 0, sz: 0, tx: 2.4, tz: 0, t, dur: leap ? 24 : 18, hop: 0, leap });
const recover = (t: number): DodgeLike => ({ phase: "recover", sx: 0, sz: 0, tx: 2.4, tz: 0, t, dur: 60, hop: 0, leap: false });

function pose(d: DodgeLike, walk = 0, alpha = 1, time = 0): PersonPose {
  const p = personDodgePose(d, walk, alpha, time, newPersonPose());
  return { ...p, armL: [...p.armL] as [number, number], armR: [...p.armR] as [number, number] };
}

function close(a: PersonPose, b: PersonPose, tol: number): void {
  expect(Math.abs(wrap(a.pitch - b.pitch)), "pitch").toBeLessThan(tol);
  expect(Math.abs(wrap(a.heading - b.heading)), "heading").toBeLessThan(tol);
  expect(Math.abs(a.lift - b.lift), "lift").toBeLessThan(tol);
  expect(Math.abs(a.squash - b.squash), "squash").toBeLessThan(tol);
  for (const k of [0, 1] as const) {
    expect(Math.abs(a.armL[k] - b.armL[k]), `armL ${k}`).toBeLessThan(tol);
    expect(Math.abs(a.armR[k] - b.armR[k]), `armR ${k}`).toBeLessThan(tol);
  }
  expect(Math.abs(a.legL - b.legL), "legL").toBeLessThan(tol);
  expect(Math.abs(a.legR - b.legR), "legR").toBeLessThan(tol);
}

describe("people dodging", () => {
  it("the dive's bearing and progress (drawn between the previous tick, alpha 0, and this one)", () => {
    expect(diveBearing(dive(0), 7)).toBeCloseTo(Math.PI / 2, 12);
    expect(diveBearing({ ...dive(0), tx: 0 }, 7)).toBe(7);
    expect(progress(dive(9), 1)).toBeCloseTo(0.5, 12);
    expect(progress(dive(9), 0)).toBeCloseTo(8 / 18, 12);
    expect(progress(dive(0), 0)).toBe(0);
    expect(progress(dive(30), 1)).toBe(1);
  });

  it("turns into the dive, stretches flat with the arms out ahead and the legs kicked back", () => {
    const start = pose(dive(0), 0, 0);
    expect(start.heading).toBeCloseTo(0, 9); // still facing the walk
    expect(start.pitch).toBeCloseTo(0, 9);
    const mid = pose(dive(8)); // u = 8/18, the stretch
    expect(mid.heading).toBeCloseTo(Math.PI / 2, 9);
    expect(mid.pitch).toBeLessThan(-1.2); // nearly flat, face down
    expect(mid.armL[0]).toBeGreaterThan(2.5); // arms up past the head: ahead of the flat body
    expect(mid.armR[0]).toBeGreaterThan(2.5);
    expect(mid.armL[1]).toBeLessThan(0); // spread a little: left out to the left
    expect(mid.armR[1]).toBeGreaterThan(0);
    expect(mid.legL).toBeLessThan(0); // kicked back
  });

  it("flips forward tucked into a ball while still in the air (one full turn), and lands on its feet in a crouch that flows into the recovery", () => {
    // The flip: from the stretch, rolling forward the whole way (pitch only falls), a full turn and a bit.
    const pitches: number[] = [];
    for (let t = 9; t <= 18; t++) pitches.push(pose(dive(t)).pitch);
    for (let i = 1; i < pitches.length; i++) expect(pitches[i]!).toBeLessThanOrEqual(pitches[i - 1]! + 1e-12);
    expect(pitches[0]! - pitches[pitches.length - 1]!).toBeGreaterThan(TAU - 1.5);
    // Curled mid-flip, and still high in the air (the sim's hop, 0.45 m at its peak).
    let curled = 0;
    for (let t = 10; t <= 14; t++) {
      const u = t / 18;
      const p = pose(dive(t));
      if (p.squash < 0.8) {
        curled++;
        expect(4 * 0.45 * u * (1 - u), `hop at tick ${t}`).toBeGreaterThan(0.2);
      }
    }
    expect(curled).toBeGreaterThan(0);
    // On its feet before it touches down: upright (but for the crouch's lean) for the last part.
    for (const t of [16, 17]) expect(Math.abs(wrap(pose(dive(t)).pitch))).toBeLessThanOrEqual(0.35 + 1e-9);
    // The end of the dive is the start of the recovery.
    close(pose(dive(18), 0, 0.999999), pose(recover(0), 0, 1), 1e-3);
  });

  it("never lies flat near the ground, and is never upended stretched out: flat only while hopping high, turned over only tucked", () => {
    const bad: string[] = [];
    for (const dur of [12, 18, 24, 36]) {
      for (const peak of [0.45, 0.35]) {
        for (let t = 0; t <= dur; t++) {
          for (const alpha of [0.25, 0.5, 0.75, 1]) {
            const d: DodgeLike = { phase: "dive", sx: 0, sz: 0, tx: 2.4, tz: 0, t, dur, hop: 0, leap: false, peak };
            const u = progress(d, alpha);
            const hop = 4 * peak * u * (1 - u);
            const p = pose(d, 0, alpha);
            const stretched = p.squash > 0.8;
            const flat = Math.abs(Math.sin(p.pitch));
            if (stretched && flat > 0.7 && hop + p.lift < STRETCH_HOP_M * 0.66) bad.push(`dur ${dur} peak ${peak} u ${u.toFixed(3)}: flat (${flat.toFixed(2)}) at ${(hop + p.lift).toFixed(2)} m`);
            if (stretched && Math.cos(p.pitch) < 0) bad.push(`dur ${dur} peak ${peak} u ${u.toFixed(3)}: upended, stretched out`);
            if (flat > 0.95 && stretched && hop < STRETCH_HOP_M - 0.02) bad.push(`dur ${dur} peak ${peak} u ${u.toFixed(3)}: stretched flat only ${hop.toFixed(2)} m up`);
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // And the recovery never lies down at all (below).
  });

  it("is drawn high in the air (above the sim's hop: a cartoon leap) with a shadow on the ground under it, which goes as they stand up", () => {
    const d = (t: number, dur = 18): DodgeLike => ({ phase: "dive", sx: 0, sz: 0, tx: 2.4, tz: 0, t, dur, hop: 0, leap: false, peak: 0.45 });
    // Mid-dive the body is drawn about 0.7 m up: plainly in the air, not lying on the pavement.
    for (const dur of [12, 18, 24, 36]) {
      let top = 0;
      for (let t = 0; t <= dur; t++) {
        const p = pose(d(t, dur));
        const u = progress(d(t, dur), 1);
        const hop = 4 * 0.45 * u * (1 - u);
        top = Math.max(top, hop + p.lift);
        // Never drawn below the sim's hop while in the air (only the landing's crouch goes lower).
        if (u < 0.82) expect(p.lift, `dur ${dur} u ${u.toFixed(2)}`).toBeGreaterThanOrEqual(0);
        expect(p.shadow, "a shadow under them all through the dive").toBe(1);
      }
      expect(top, `dur ${dur}`).toBeGreaterThan(0.45 + AIR_LIFT_M * 0.9);
    }
    // Take-off is the walk's height (no jump in the drawing).
    expect(pose(d(0), 0, 0).lift).toBeCloseTo(0, 9);
    // The shadow: full as they land, gone once they are up (recover u 0.3).
    expect(pose(recover(0), 0, 0).shadow).toBeCloseTo(1, 9);
    expect(pose(recover(9)).shadow).toBeGreaterThan(0);
    expect(pose(recover(9)).shadow).toBeLessThan(1);
    expect(pose(recover(18)).shadow).toBe(0);
    // Where the ground is: the sim's hop (dodge.ts advanceDodge) between the two ticks drawn.
    const hop = (t: number): number => 4 * 0.45 * (t / 18) * (1 - t / 18);
    expect(drawnHop(d(9), 1)).toBeCloseTo(hop(9), 12);
    expect(drawnHop(d(9), 0)).toBeCloseTo(hop(8), 12);
    expect(drawnHop(d(9), 0.5)).toBeCloseTo((hop(8) + hop(9)) / 2, 12);
    expect(drawnHop(d(1), 0)).toBe(0);
    expect(drawnHop(recover(5), 0.5)).toBe(0);
    expect(drawnHop({ ...d(9), peak: undefined }, 1)).toBeCloseTo(hop(9), 12);
  });

  it("recovers: up from the crouch, a startled pose (arms flung up, a shake), brushing off, then the walk's heading and stance", () => {
    const up = pose(recover(18)); // u = 0.3: standing, in the air of a startled little jump
    expect(Math.abs(up.pitch)).toBeLessThan(1e-9);
    expect(up.lift).toBeGreaterThan(0);
    expect(up.lift).toBeLessThan(0.1);
    // Still coming up out of the crouch, the arms are already flung up.
    expect(pose(recover(6)).lift).toBeLessThan(0);
    expect(pose(recover(12)).pitch).toBeLessThan(0);
    expect(pose(recover(12)).armL[0]).toBeGreaterThan(1.5);
    const startled = pose(recover(28), 0, 1, 0.4);
    expect(startled.armL[0]).toBeGreaterThan(2.4);
    expect(startled.armR[0]).toBeGreaterThan(2.4);
    // It shakes: the same moment at another clock time differs.
    expect(startled.armL[1]).not.toBeCloseTo(pose(recover(28), 0, 1, 0.43).armL[1], 3);
    const brushing = [44, 46, 48, 50].map((t) => pose(recover(t)).armR[0]);
    expect(Math.max(...brushing) - Math.min(...brushing)).toBeGreaterThan(0.3); // the hand moves
    // The end is the walk: facing the way it walked, standing, arms and legs at rest.
    const end = pose(recover(60), 0.4);
    expect(end.heading).toBeCloseTo(0.4, 9);
    expect(end.pitch).toBeCloseTo(0, 9);
    expect(end.lift).toBeCloseTo(0, 9);
    for (const v of [...end.armL, ...end.armR, end.legL, end.legR]) expect(Math.abs(v)).toBeLessThan(1e-6);
  });

  it("is never drawn lying still or limp: after the roll the body is never more than about 20 degrees off upright", () => {
    for (let t = 0; t <= 60; t++) expect(Math.abs(wrap(pose(recover(t)).pitch))).toBeLessThanOrEqual(0.35 + 1e-9);
  });

  it("the override's leap is drawn along its arc, from where they were to where the sim put them, with a tucked front flip", () => {
    const a = pose(dive(0, true), 0, 0);
    expect([a.x, a.z]).toEqual([0, 0]);
    const m = pose(dive(12, true));
    expect(m.x).toBeCloseTo(1.2, 9);
    expect(m.z).toBeCloseTo(0, 9);
    expect(m.squash).toBeLessThan(0.75);
    const e = pose(dive(24, true));
    expect([e.x, e.z]).toEqual([2.4, 0]);
    expect(e.pitch).toBeCloseTo(-TAU, 9);
  });

  it("a short leap (a robotaxi edging up, a car brushing past) is a stumble-hop aside: no flip, arms windmilling", () => {
    const short = (t: number): DodgeLike => ({ phase: "dive", sx: 0, sz: 0, tx: SHORT_LEAP_M * 0.5, tz: 0, t, dur: 14, hop: 0, leap: true });
    const arms: number[] = [];
    for (let t = 0; t <= 14; t++) {
      const p = pose(short(t), 0);
      expect(Math.abs(p.pitch)).toBeLessThan(0.2);
      expect(p.squash).toBe(1);
      expect(p.heading).toBe(0); // still facing the way they were going
      arms.push(p.armL[0]);
    }
    expect(Math.max(...arms) - Math.min(...arms)).toBeGreaterThan(1);
    expect(pose(short(7)).roll).toBeGreaterThan(0.2); // tipping toward it (east, to their right)
  });
});

describe("robots dodging", () => {
  it("the Trundle skids: swings round toward its dive side, tips onto its outside wheels, and is level again", () => {
    // Walking north, diving east (to its right).
    const mid = robotDodgePose("sidewalkBot", dive(9), 0, 1, newRobotPose());
    expect(mid.heading).toBeGreaterThan(0.5);
    expect(mid.roll).toBeLessThan(-0.2);
    const end = robotDodgePose("sidewalkBot", recover(60), 0, 1, newRobotPose());
    expect(end.heading).toBe(0);
    expect(Math.abs(end.roll)).toBeLessThan(1e-9);
  });

  it("the Footman hops aside leaning into it with its arms out, then steadies", () => {
    const mid = robotDodgePose("errandRobot", dive(9), 0, 1, newRobotPose());
    expect(mid.roll).toBeGreaterThan(0.3); // leaning into a dive to its right
    expect(mid.swing).toBeCloseTo(1, 6);
    const end = robotDodgePose("errandRobot", recover(60), 0, 1, newRobotPose());
    expect(end.roll).toBe(0);
    expect(Math.abs(end.swing)).toBeLessThan(1e-9);
  });
});
