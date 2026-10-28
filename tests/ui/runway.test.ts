// Runway Run, UI side: the money and clock formats, the view of a run, and the one entry function.
import { describe, expect, it } from "vitest";
import { createInitialState, step } from "../../src/sim/index.ts";
import { RUNWAY_START_EVENT, createRunwaySystem } from "../../src/sim/runway-run/index.ts";
import { arrowTransform, bindRunwaySender, clearRunwayRun, formatRaised, formatRunway, quitRunwayRun, runwayView, startRunwayRun } from "../../src/ui/runway.ts";
import { gridCity } from "../sim/fixtures.ts";

describe("Runway Run formats", () => {
  it("shortens money", () => {
    expect([0, 640, 82_000, 640_000, 1_000_000, 1_240_000, 20_000_000, 2_000_000_000].map(formatRaised))
      .toEqual(["$0", "$640", "$82k", "$640k", "$1M", "$1.2M", "$20M", "$2B"]);
  });
  it("shows the runway as m:ss, rounding up", () => {
    expect([90, 59.2, 9.01, 0, -3].map(formatRunway)).toEqual(["1:30", "1:00", "0:10", "0:00", "0:00"]);
  });
});

describe("runwayView", () => {
  const world = gridCity();
  it("is idle, and can start, while the player drives and no run exists", () => {
    const s = createInitialState(world, 3, ["p"], { x: 0, z: 0, heading: 0 });
    expect(runwayView(s, "p")).toMatchObject({ phase: "idle", canStart: true, notes: [] });
  });
  it("shows the target, its distance and the turn toward it while running", () => {
    let s = createInitialState(world, 3, ["p"], { x: 0, z: 0, heading: 0 });
    s = step(world, s, { p: { throttle: 0, steer: 0, brake: 0, actions: 0 } }, [{ tick: 1, kind: RUNWAY_START_EVENT, playerId: "p" }], [createRunwaySystem()]);
    const v = runwayView(s, "p");
    expect(v.phase).toBe("running");
    expect(v.canStart).toBe(false);
    expect(v.runwayS).toBe(90);
    expect(v.investor?.name).toBeTruthy();
    expect(v.targetM).toBeGreaterThan(0);
    expect(Math.abs(v.targetTurn!)).toBeLessThanOrEqual(Math.PI);
  });
});

describe("the HUD arrow", () => {
  it("points its right-facing glyph up for a target dead ahead, right for one on the right", () => {
    expect(arrowTransform(0)).toBe(`rotate(${-Math.PI / 2}rad)`);
    expect(arrowTransform(Math.PI / 2)).toBe("rotate(0rad)");
    expect(arrowTransform(-Math.PI / 2)).toBe(`rotate(${-Math.PI}rad)`);
  });
});

describe("the one entry function", () => {
  it("sends the recorded start, quit and clear events through the bound sender, and nothing once unbound", () => {
    const sent: string[] = [];
    const unbind = bindRunwaySender((k) => sent.push(k));
    startRunwayRun(); quitRunwayRun(); clearRunwayRun();
    unbind();
    startRunwayRun();
    expect(sent).toEqual(["runway.start", "runway.quit", "runway.clear"]);
  });
});
