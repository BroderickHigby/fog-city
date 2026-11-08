// The Planner demo's model: corridor, fuel, traffic, signals, optimized plans and forecast.
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers.ts";
import { buildCorridor, pointAt, type RoadsFile, type SignalsFile } from "../../src/planner/corridor.ts";
import { ARRB, CO2_G_PER_ML, RHNA_HOMES_2031, SF_POPULATION } from "../../src/planner/data.ts";
import { lombardDemand } from "../../src/planner/demand.ts";
import { co2GramsFromFuelMl, fuelRateMlPerS } from "../../src/planner/emissions.ts";
import { forecast2031, lombardTrend, populationElasticity } from "../../src/planner/forecast.ts";
import { averageRuns, demandFor, planFor } from "../../src/planner/scenarios.ts";
import { ADAPTIVE_PLAN, MIN_CROSS_GREEN_S, MIN_MAIN_GREEN_S, adaptiveAspects, adaptiveStep, fixedAspects, type AdaptiveState, type FixedPlan } from "../../src/planner/signals.ts";
import { CorridorSim, IDM, runScenario } from "../../src/planner/traffic.ts";

const corridor = buildCorridor(readJson<RoadsFile>("public/tiles/sf/roads.json"), readJson<SignalsFile>("public/tiles/sf/signals.json"));
const n = corridor.signals.length;
const fixed = (green: number, cycle = 100, offset = 0): FixedPlan => ({ kind: "fixed", label: "test", cycleS: cycle, mainGreenS: new Array<number>(n).fill(green), offsetS: new Array<number>(n).fill(offset) });

describe("corridor", () => {
  it("is US-101 on Lombard St: Van Ness Ave to Richardson Ave, 13 real signals, three lanes each way", () => {
    expect(n).toBe(13);
    expect(corridor.signals[0]!.street).toBe("Van Ness Ave");
    expect(corridor.signals.at(-1)!.street).toBe("Broderick St");
    expect(corridor.lanesPerDirection).toBe(3);
    expect(corridor.length).toBeGreaterThan(1700);
    expect(corridor.length).toBeLessThan(1900);
    for (let i = 1; i < n; i++) expect(corridor.signals[i]!.s).toBeGreaterThan(corridor.signals[i - 1]!.s);
    const mid = pointAt(corridor, corridor.length / 2);
    expect(Math.abs(mid.heading + Math.PI / 2)).toBeLessThan(0.4); // westbound faces roughly west
  });
});

describe("fuel and CO2", () => {
  it("idles at the model's alpha, burns more cruising, and most while accelerating", () => {
    expect(fuelRateMlPerS(0, 0)).toBeCloseTo(ARRB.alphaMlPerS, 6);
    expect(fuelRateMlPerS(10, -2)).toBeCloseTo(ARRB.alphaMlPerS, 6);
    expect(fuelRateMlPerS(11, 0)).toBeGreaterThan(ARRB.alphaMlPerS);
    expect(fuelRateMlPerS(11, 1.5)).toBeGreaterThan(fuelRateMlPerS(11, 0) * 2);
    // A car at 40 km/h: a plausible 150-300 g of CO2 per km.
    const gPerKm = co2GramsFromFuelMl(fuelRateMlPerS(11.1, 0)) / 11.1 * 1000;
    expect(gPerKm).toBeGreaterThan(150);
    expect(gPerKm).toBeLessThan(300);
    expect(CO2_G_PER_ML).toBeCloseTo(2.3477, 3);
  });
});

describe("signals", () => {
  it("runs a fixed cycle green, yellow, all-red, cross green, cross yellow, all-red", () => {
    const p = fixed(40, 90, 10);
    expect(fixedAspects(p, 0, 10).main).toBe("green");
    expect(fixedAspects(p, 0, 51).main).toBe("yellow");
    expect(fixedAspects(p, 0, 54)).toEqual({ main: "red", cross: "red" });
    expect(fixedAspects(p, 0, 60)).toEqual({ main: "red", cross: "green" });
    expect(fixedAspects(p, 0, 9)).toEqual({ main: "red", cross: "red" });
  });

  it("keeps the adaptive controller's minimum greens, for cars and for people crossing", () => {
    const st: AdaptiveState = { phase: "main", elapsed: 0 };
    let t = 0, crossGreen = 0, mainGreen = 0;
    const greens: { phase: string; length: number }[] = [];
    let last = "main";
    for (; t < 600; t += 0.5) {
      adaptiveStep(ADAPTIVE_PLAN, st, 0.5, { gap: t % 40 < 10, platoon: 0 }, 3);
      const a = adaptiveAspects(st);
      if (a.cross === "green") crossGreen += 0.5;
      if (a.main === "green") mainGreen += 0.5;
      if (st.phase !== last) { greens.push({ phase: last, length: 0 }); last = st.phase; }
    }
    expect(crossGreen).toBeGreaterThan(0);
    expect(mainGreen).toBeGreaterThan(0);
    // Replay with a tally of each green's length.
    const s2: AdaptiveState = { phase: "main", elapsed: 0 };
    let run = 0, phase = s2.phase;
    for (let k = 0; k < 1200; k++) {
      adaptiveStep(ADAPTIVE_PLAN, s2, 0.5, { gap: false, platoon: 0 }, 3);
      run += 0.5;
      if (s2.phase !== phase) {
        if (phase === "main") expect(run).toBeGreaterThanOrEqual(MIN_MAIN_GREEN_S);
        if (phase === "cross") expect(run).toBeGreaterThanOrEqual(MIN_CROSS_GREEN_S);
        phase = s2.phase; run = 0;
      }
    }
    expect(greens.length).toBeGreaterThan(4);
  });
});

describe("traffic", () => {
  const demand = lombardDemand(corridor, "pm", 1);

  it("drives the corridor at free-flow speed when every light stays green", () => {
    const m = runScenario(corridor, demand, fixed(990, 1000), { durationS: 900 });
    const freeFlow = corridor.length / IDM.v0;
    expect(m.travelTimeS[0]).toBeGreaterThan(freeFlow * 0.95);
    expect(m.travelTimeS[0]).toBeLessThan(freeFlow * 1.15);
    expect(m.stopsPerCar).toBeLessThan(0.3);
  });

  it("stops cars at red: with Lombard never green nobody drives the whole corridor", () => {
    const allRed: FixedPlan = { ...fixed(0, 100), mainGreenS: new Array<number>(n).fill(0) };
    const m = runScenario(corridor, demand, allRed, { durationS: 600 });
    expect(m.through).toEqual([0, 0]);
  });

  it("never lets a car drive into the one ahead", () => {
    const sim = new CorridorSim(corridor, demand, planFor(corridor, "today", "pm", demand), { durationS: 900 });
    let worst = Infinity;
    while (!sim.done) {
      sim.step();
      for (const dir of sim.lanes) for (const lane of dir) for (let i = 1; i < lane.length; i++) worst = Math.min(worst, lane[i - 1]!.s - IDM.len - lane[i]!.s);
    }
    expect(worst).toBeGreaterThan(-0.05);
  });

  it("is deterministic, and every plan sees the same cars", () => {
    const p = planFor(corridor, "greenwave", "pm", demand);
    expect(runScenario(corridor, demand, p, { durationS: 600 })).toEqual(runScenario(corridor, demand, p, { durationS: 600 }));
    const a = new CorridorSim(corridor, demand, planFor(corridor, "today", "pm", demand), { durationS: 600 });
    const b = new CorridorSim(corridor, demand, ADAPTIVE_PLAN, { durationS: 600 });
    a.run(); b.run();
    expect(a.snapshot().entryQueue.length).toBe(2);
    // Same arrivals at both ends, whatever the signals do.
    expect(a.arrivals(0)).toBe(b.arrivals(0));
    expect(a.arrivals(1)).toBe(b.arrivals(1));
    expect(a.arrivals(0)).toBeGreaterThan(0);
  });
});

describe("optimized timing", () => {
  it("beats today's assumed timing and a plain green wave on seeds it never saw, without starving side streets", () => {
    const d = demandFor(corridor, "now", "pm");
    const seeds = [7, 8];
    const lost = (id: "today" | "greenwave" | "optimized"): { total: number; cross: number; co2: number } => {
      const m = averageRuns(corridor, d, planFor(corridor, id, "pm", d), seeds, { durationS: 1800 });
      return { total: m.delayHoursPerHour.main + m.delayHoursPerHour.cross, cross: m.delayHoursPerHour.cross, co2: m.co2KgPerHour.total };
    };
    const today = lost("today"), wave = lost("greenwave"), opt = lost("optimized");
    expect(opt.total).toBeLessThan(wave.total);
    expect(wave.total).toBeLessThan(today.total);
    expect(opt.co2).toBeLessThan(wave.co2);
    expect(opt.cross).toBeLessThan(today.cross * 1.5);
  }, 60_000);
});

describe("forecast", () => {
  it("finds that Lombard's traffic has not grown with San Francisco's population", () => {
    const pts = lombardTrend();
    expect(pts[0]!.year).toBe(1996);
    expect(pts.length).toBeGreaterThan(10);
    const e = populationElasticity(pts);
    expect(e).toBeGreaterThan(-0.5);
    expect(e).toBeLessThan(0.3);
  });

  it("adds the housing target's residents to today's population", () => {
    const now = SF_POPULATION.at(-1)!.population;
    const f = forecast2031(2, 1);
    expect(f.population).toBe(now + RHNA_HOMES_2031 * 2);
    expect(f.scale).toBeCloseTo(f.population / now, 6);
  });
});
