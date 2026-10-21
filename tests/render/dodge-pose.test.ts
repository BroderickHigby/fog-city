// How a dodge is drawn (src/render/dodge-pose.ts): people dive with their arms out ahead, land
// in a roll and come up startled; the override's leap follows its arc with a flip; robots skid
// and hop. The poses flow from one into the next (no snap at a phase change) and end where the
// walk takes over again, and nobody is ever drawn lying still or limp.
import { describe, expect, it } from "vitest";
import { diveBearing, newPersonPose, newRobotPose, personDodgePose, progress, robotDodgePose, type DodgeLike, type PersonPose } from "../../src/render/dodge-pose.ts";

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

  it("lands in a forward roll: one full turn, curled, coming up into a crouch that flows into the recovery", () => {
    const pitches: number[] = [];
    for (let t = 10; t <= 18; t++) pitches.push(pose(dive(t)).pitch);
    // Rolling forward the whole way (pitch only falls), a full turn and a bit.
    for (let i = 1; i < pitches.length; i++) expect(pitches[i]!).toBeLessThanOrEqual(pitches[i - 1]! + 1e-12);
    expect(pitches[0]! - pitches[pitches.length - 1]!).toBeGreaterThan(TAU - 1.5);
    // Curled mid-roll.
    expect(pose(dive(14)).squash).toBeLessThan(0.8);
    // The end of the dive is the start of the recovery.
    close(pose(dive(18), 0, 0.999999), pose(recover(0), 0, 1), 1e-3);
  });

  it("recovers: up from the crouch, a startled pose (arms flung up, a shake), brushing off, then the walk's heading and stance", () => {
    const up = pose(recover(18)); // u = 0.3: standing
    expect(Math.abs(up.pitch)).toBeLessThan(1e-9);
    expect(up.lift).toBeCloseTo(0, 9);
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
