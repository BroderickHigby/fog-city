// The dodge stream's evidence (docs/shots/dodge-stream/): how dodging bodies move in the seeded
// no-touch fuzz scenes, in cars driven straight at a person at fixed speeds, and (with the SF
// world in the checkout) in the clearance soak's runs on the real city. Writes one JSON report.
//   node tests/sim/dodge-motion-report.ts docs/shots/dodge-stream/after/motion.json [--quick]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DT, SIM_VERSION, buildWorld, step } from "../../src/sim/index.ts";
import { toLocal } from "../../src/geo/project.ts";
import { DodgeMotion, straightAtOne, type MotionSummary } from "./dodge-motion.ts";
import { makeScene, run } from "./dodge-scenes.ts";
import { NARROW_PLACES, routeFrom, soak, startNear, type SoakStart } from "./dodge-soak.ts";
import { loadWorldFiles } from "../helpers.ts";
import { SF, sfWorld } from "./world/load.ts";

const out = process.argv[2] ?? "dodge-motion.json";
const quick = process.argv.includes("--quick");

function summarise(name: string, m: DodgeMotion, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const s: MotionSummary = m.summary();
  const row = { name, ...extra, ...s, traces: undefined };
  console.log(
    `${name.padEnd(46)} dives ${String(s.dives).padStart(4)}  overrides ${String(s.overrides).padStart(3)}  peak ${s.peakSpeed.toFixed(2)} m/s (dive ${s.peakDiveSpeed.toFixed(2)}, p99 ${s.p99Speed.toFixed(2)})  accel ${s.peakAccel.toFixed(1)} (p99 ${s.p99Accel.toFixed(1)}, ${s.hardStops} pull-ups) m/s2  lift ${s.peakLift.toFixed(2)} m  leap ${s.maxLeapM.toFixed(2)} m`,
  );
  return { ...row, traces: s.traces.slice(0, 2) };
}

const rows: Record<string, unknown>[] = [];
const totals = { dives: 0, overrides: 0 };

// Straight at one person, held at a fixed speed.
for (const speed of [6, 10, 15, 20, 30]) {
  const world = buildWorld([{ tileId: "flat", buildings: [], ground: null }]);
  const state = straightAtOne(world, speed);
  const m = new DodgeMotion(world);
  let s = state;
  for (let t = 0; t < Math.round((80 / speed + 3) / DT); t++) {
    const prev = s;
    const c = s.players.car!.car;
    s = step(world, s, { car: { throttle: c.speed < speed ? 1 : 0, steer: 0, brake: 0, actions: 0 } }, []);
    m.tick(prev, s);
  }
  rows.push(summarise(`straight at one person, ${speed} m/s`, m, { carSpeed: speed }));
}

// The no-touch fuzz's seeded scenes (adversarial: up to 38 m/s, chases, drifts, handbrake turns).
{
  const seeds = quick ? 40 : 160;
  const all = new DodgeMotion(buildWorld([{ tileId: "x", buildings: [], ground: null }]));
  const per: Array<{ seed: number; name: string; dives: number; overrides: number; peakSpeed: number; peakLift: number }> = [];
  let dives = 0;
  let overrides = 0;
  let peakSpeed = 0;
  let peakDive = 0;
  let peakLift = 0;
  let peakAccel = 0;
  let maxLeap = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const sc = makeScene(seed);
    const m = new DodgeMotion(sc.world);
    run(sc, (a, b) => m.tick(a, b));
    const s = m.summary();
    dives += s.dives;
    overrides += s.overrides;
    peakSpeed = Math.max(peakSpeed, s.peakSpeed);
    peakDive = Math.max(peakDive, s.peakDiveSpeed);
    peakLift = Math.max(peakLift, s.peakLift);
    peakAccel = Math.max(peakAccel, s.peakAccel);
    maxLeap = Math.max(maxLeap, s.maxLeapM);
    per.push({ seed, name: sc.name, dives: s.dives, overrides: s.overrides, peakSpeed: s.peakSpeed, peakLift: s.peakLift });
  }
  void all;
  console.log(`fuzz ${seeds} scenes: dives ${dives}, overrides ${overrides} (${((100 * overrides) / Math.max(1, dives)).toFixed(1)}%), peak ${peakSpeed.toFixed(2)} m/s (dive ${peakDive.toFixed(2)}), accel ${peakAccel.toFixed(1)}, lift ${peakLift.toFixed(2)} m, leap ${maxLeap.toFixed(2)} m`);
  rows.push({ name: `fuzz, ${seeds} seeded scenes`, dives, overrides, peakSpeed, peakDiveSpeed: peakDive, peakAccel, peakLift, maxLeapM: maxLeap, scenes: per });
}

// The real city: the per-PR soak's runs.
if (SF) {
  const { world } = sfWorld();
  const spawn = loadWorldFiles("sf").manifest.spawn;
  const home: SoakStart = { name: "Ferry Building", ...spawn, route: routeFrom(world.roads!, spawn.x, spawn.z, spawn.heading, 2000, 3) };
  const runs: Array<[SoakStart, "chase" | "nobrake" | "rival" | "weave", number]> = [
    [home, "chase", 5],
    [home, "nobrake", 5],
    [home, "rival", 5],
  ];
  if (!quick) {
    for (const [name, lat, lon] of NARROW_PLACES) {
      const p = toLocal(lat, lon);
      const st = startNear(world, name, p.x, p.z);
      runs.push([st, "chase", 8], [st, "weave", 7]);
    }
  }
  for (const [st, driver, seed] of runs) {
    const m = new DodgeMotion(world);
    const r = soak(world, st, driver, 1200, seed, { onTick: (a, b) => m.tick(a, b) });
    totals.dives += r.dives;
    totals.overrides += r.overrides;
    rows.push(summarise(`SF ${st.name} ${driver}`, m, { contacts: r.contacts, failures: r.failures, soakDives: r.dives, soakOverrides: r.overrides, taxiOverrides: r.taxiOverrides, minCar: r.minCar }));
  }
  console.log(`SF soak runs: dives ${totals.dives}, overrides ${totals.overrides} (${((100 * totals.overrides) / Math.max(1, totals.dives)).toFixed(1)}%)`);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ simVersion: SIM_VERSION, sfWorld: SF, rows }, null, 1) + "\n");
console.log(`wrote ${out}`);
