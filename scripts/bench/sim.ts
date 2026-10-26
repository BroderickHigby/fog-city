// The sim step's cost on the real city, in Node (docs/design.md "Simulation scale": the bench
// gate; docs/testing.md "Sim bench"). Two scenarios on the sf world, seed 7: one anchor (a player
// driving a gentle weave from the Ferry Building spawn, about 430 ambient agents) and four (that
// player plus three idle at Union Square, Chinatown and the Mission: the 1,024-agent cap). 300
// warm-up ticks, then the timed ticks (default 1,800): mean, p50, p95, p99 and max ms per tick.
//
//   node scripts/bench/sim.ts                      both scenarios, print the numbers
//   node scripts/bench/sim.ts --check              and fail (exit 1) when the mean or p95 of either is more than 20% over the baseline
//   node scripts/bench/sim.ts --update             record them as the baseline (scripts/bench/sim-baseline.json)
//   node scripts/bench/sim.ts --root <dir>         the sim (and tests/helpers.ts) of another checkout, on the same tiles
//   options: --scenario single|multi, --ticks N, --repeat N (each scenario N times, the run with the
//   median mean kept: --update and --check default to 3, since one run on a busy machine can be
//   off by a fifth), --systems game|core
//
// --systems game (the default) steps the composed registry the game, the headless drivers and
// the relay run: createGameSystems() (clock, agents runtime, combat, player, heat, missions, ...).
// --systems core steps step()'s default SYSTEMS, the static per-area lists, which leave out every
// system that needs a provider: movement, ambient traffic and the dodge only. The baseline keeps
// one entry per scenario and systems.
//
// Timing is machine-dependent: the committed baseline is the machine it was recorded on (it says
// which); re-record it on the runner that checks it. Run it alone (`flock` in this repo's memory
// rule): it holds the whole city (about 1.5-1.8 GB) and other work skews it.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { arch, cpus, platform } from "node:os";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const here = resolve(import.meta.dirname, "../..");
const root = resolve(opt("root") ?? here);
const ticks = Number(opt("ticks") ?? 1800);
const scenarios = opt("scenario") ? [opt("scenario")!] : ["single", "multi"];
const systemsOpt = opt("systems") ?? "game";
if (systemsOpt !== "game" && systemsOpt !== "core") throw new Error("--systems must be game or core");
const systemsMode: "game" | "core" = systemsOpt;
const BASELINE = join(here, "scripts/bench/sim-baseline.json");
const LIMIT = 1.2;

const S = await import(join(root, "src/sim/index.ts"));
const H = await import(join(root, "tests/helpers.ts"));
const files = H.loadWorldFiles("sf");
// The game's world: road graph, boundary and, where this checkout has them, the gameplay,
// sidewalk and transit layers the composed systems read.
const world = typeof H.buildWorldWithRoads === "function"
  ? H.buildWorldWithRoads(files.tiles, files.roads, files.boundary, files)
  : S.buildWorld(files.tiles, files.roads, files.boundary);
if (systemsMode === "game" && typeof S.createGameSystems !== "function") throw new Error("this checkout has no createGameSystems: pass --systems core");
const spawn = files.manifest.spawn as { x: number; z: number; heading: number };

const PLACES: Array<{ x: number; z: number; heading: number }> = [
  spawn,
  { x: -1213, z: 834, heading: 0 }, // Union Square
  { x: -1126, z: 0, heading: 0 }, // Chinatown
  { x: -2490, z: 3390, heading: 0 }, // the Mission
];

interface Result {
  scenario: string;
  /** Absent in baselines recorded before the composed path was benched: those were core. */
  systems?: "game" | "core";
  /** Where and when this entry was recorded (absent: the file's top-level machine). */
  machine?: string;
  recorded?: string;
  ticks: number;
  meanMs: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  agentsMean: number;
}

function run(scenario: string): Result {
  const ids = scenario === "single" ? ["p1"] : ["p1", "p2", "p3", "p4"];
  const systems = systemsMode === "game" ? S.createGameSystems() : S.SYSTEMS;
  let s = S.createInitialState(world, 7, ids, spawn);
  const players = { ...s.players };
  ids.forEach((id, i) => {
    if (i === 0) return;
    const p = PLACES[i]!;
    players[id] = { ...players[id], car: S.makeCar(p.x, p.z, p.heading, S.meshGroundHeight(world, p.x, p.z)) };
  });
  s = { ...s, players };
  // p1 drives a gentle weave at moderate speed; the others idle in their cars.
  const inputs = (t: number): Record<string, { throttle: number; steer: number; brake: number; actions: number }> => {
    const out: Record<string, { throttle: number; steer: number; brake: number; actions: number }> = {};
    for (const id of ids) out[id] = { throttle: 0, steer: 0, brake: 0, actions: 0 };
    const phase = Math.floor(t / 240) % 4;
    out.p1 = { throttle: 0.55, steer: phase === 1 ? 0.25 : phase === 3 ? -0.25 : 0, brake: 0, actions: 0 };
    return out;
  };
  const WARM = 300;
  for (let t = 0; t < WARM; t++) s = S.step(world, s, inputs(t), [], systems);
  const per: number[] = [];
  let agents = 0;
  for (let t = 0; t < ticks; t++) {
    const a = process.hrtime.bigint();
    s = S.step(world, s, inputs(WARM + t), [], systems);
    per.push(Number(process.hrtime.bigint() - a) / 1e6);
    agents += (s.ext.agents?.list ?? []).length;
  }
  per.sort((x, y) => x - y);
  const q = (f: number): number => +per[Math.min(per.length - 1, Math.floor(f * per.length))]!.toFixed(3);
  return {
    scenario,
    systems: systemsMode,
    ticks,
    meanMs: +(per.reduce((x, y) => x + y, 0) / per.length).toFixed(3),
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: +per[per.length - 1]!.toFixed(3),
    agentsMean: Math.round(agents / ticks),
  };
}

const repeat = Number(opt("repeat") ?? (args.includes("--update") || args.includes("--check") ? 3 : 1));
const results = scenarios.map((sc) => {
  const runs = Array.from({ length: repeat }, () => run(sc)).sort((a, b) => a.meanMs - b.meanMs);
  return runs[Math.floor(runs.length / 2)]!;
});
for (const r of results) console.log(JSON.stringify({ root, simVersion: S.SIM_VERSION, ...r }));

if (args.includes("--update")) {
  const machine = `${cpus()[0]?.model ?? "unknown cpu"} x${cpus().length}, ${platform()} ${arch()}, node ${process.version}`;
  const recorded = new Date().toISOString().slice(0, 10);
  let kept: Result[] = [];
  try {
    const old = JSON.parse(readFileSync(BASELINE, "utf8")) as { machine: string; recorded: string; results: Result[] };
    kept = old.results
      .filter((b) => !results.some((r) => r.scenario === b.scenario && r.systems === (b.systems ?? "core")))
      .map((b) => ({ ...b, systems: b.systems ?? "core", machine: b.machine ?? old.machine, recorded: b.recorded ?? old.recorded }));
  } catch { /* no baseline yet */ }
  const fresh = results.map((r) => ({ ...r, machine, recorded }));
  writeFileSync(BASELINE, JSON.stringify({ machine, recorded, results: [...kept, ...fresh] }, null, 2) + "\n");
  console.log(`baseline written: ${BASELINE}`);
}
if (args.includes("--check")) {
  const base = JSON.parse(readFileSync(BASELINE, "utf8")) as { machine: string; results: Result[] };
  const bad: string[] = [];
  for (const r of results) {
    const b = base.results.find((x) => x.scenario === r.scenario && (x.systems ?? "core") === r.systems);
    if (!b) continue;
    for (const k of ["meanMs", "p95"] as const) if (r[k] > b[k] * LIMIT) bad.push(`${r.scenario} ${k} ${r[k]} ms > ${b[k]} ms x ${LIMIT}`);
  }
  if (bad.length) {
    console.error(`sim bench regression (baseline from ${base.machine}; entries may name their own machine):\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
  console.log("sim bench within 20% of the baseline");
}
