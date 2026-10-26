// The composed-path golden replays (tests/golden/composed-v<SIM_VERSION>.json): step() through
// createGameSystems(), the registry the game, the headless drivers and the relay run, rather
// than the core-only [] of the physics goldens. Every scenario is open loop: its inputs and
// events are a function of the tick alone, so a behaviour change on the composed path shows
// up as a changed hash and never as a changed input. Shared by tests/golden/composed.test.ts
// and scripts/golden/composed.ts (which records the pins).
import {
  Action, DAY_TICKS, SIM_VERSION, SimEventKind, buildWorld, createGameSystems, createInitialState, fogDensity, hashState, makeFoot,
  rainDensity, roadWetness, step, tideLevel,
  type InputFrame, type RoadsFile, type SimEvent, type SimInput, type SimState, type World,
} from "../../src/sim/index.ts";
import { MISSIONS } from "../../src/content/catalog.ts";
import { missionPlace } from "../../src/sim/missions/system.ts";
import { createHeat } from "../../src/sim/heat/system.ts";
import { buildWorldWithRoads, loadWorldFiles } from "../helpers.ts";

export interface ComposedScenario {
  name: string;
  ticks: number;
  /** A hash every `every` ticks, and one at the end. */
  every: number;
  world: () => World;
  initial: (world: World) => SimState;
  inputs: (tick: number) => InputFrame;
  events: (tick: number) => SimEvent[];
  wave?: 2 | 3;
}

export interface ComposedRun {
  hashes: string[];
  /** What the run exercised, so a pin that stops covering a system is visible in review. */
  coverage: Record<string, number>;
}

const idle: SimInput = { throttle: 0, steer: 0, brake: 0, actions: 0 };

function devWorld(): World {
  const files = loadWorldFiles("dev");
  return buildWorldWithRoads(files.tiles, files.roads, files.boundary, files);
}

/** p1 drives a weave, gets out and walks, spraying and watching; p2 circles; p3 joins later. */
const city: ComposedScenario = {
  name: "city",
  ticks: 900,
  every: 150,
  world: devWorld,
  initial: world => createInitialState(world, 7, ["p1", "p2"], loadWorldFiles("dev").manifest.spawn),
  inputs: tick => {
    const weave = Math.floor(tick / 120) % 4;
    const p1: SimInput = tick < 240 ? { throttle: 0.7, steer: weave === 1 ? 0.3 : weave === 3 ? -0.3 : 0, brake: 0, actions: tick % 90 === 0 ? Action.horn : 0 }
      : tick < 300 ? { ...idle, brake: 1 }
      : tick === 300 ? { ...idle, actions: Action.enterExit }
      : { throttle: tick % 200 < 120 ? 1 : 0, steer: tick % 400 < 200 ? 0.25 : -0.25, brake: tick % 300 < 60 ? 1 : 0,
        actions: (tick % 30 < 10 ? Action.fire : 0) | (tick % 240 > 200 ? Action.watch : 0) | (tick % 150 === 0 ? Action.interact : 0),
        aimYaw: (tick % 360) * 0.0174533, aimPitch: 0.1 };
    const p2: SimInput = { throttle: 0.5, steer: 0.35, brake: tick % 180 < 30 ? 1 : 0, actions: 0 };
    const frame: Record<string, SimInput> = { p1, p2 };
    if (tick >= 600) frame.p3 = { throttle: 0.6, steer: -0.2, brake: 0, actions: 0 };
    return frame;
  },
  events: tick => tick === 600 ? [{ tick, kind: SimEventKind.playerJoin, playerId: "p3", payload: { x: 0, z: 10, heading: 1.5707963267948966 } }] : [],
};

/** A 1.2 km square of two-way streets 300 m apart: room for service entries off screen. */
function serviceWorld(): World {
  const nodes: RoadsFile["nodes"][number][] = [], edges: RoadsFile["edges"][number][] = [];
  const id = (i: number, j: number): string => `n${i}${j}`;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) nodes.push({ id: id(i, j), x: -600 + 300 * i, z: -600 + 300 * j });
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    const x = -600 + 300 * i, z = -600 + 300 * j;
    if (i < 4) edges.push({ id: `h${i}${j}`, a: id(i, j), b: id(i + 1, j), kind: "residential", lanes: 2, oneway: false, points: [[x, z], [x + 300, z]] });
    if (j < 4) edges.push({ id: `v${i}${j}`, a: id(i, j), b: id(i, j + 1), kind: "residential", lanes: 2, oneway: false, points: [[x, z], [x, z + 300]] });
  }
  const world = buildWorld([], { version: 1, nodes, edges });
  // No ambient population (as tests/sim/agents/services-integration.test.ts): the van's run,
  // delivery and retirement, not traffic, are what this scenario pins.
  world.roads = { ...world.roads!, areas: [] };
  return world;
}

/** Heat already asked for a van: routed by the follower, admitted, delivered, retired and released. */
const service: ComposedScenario = {
  name: "service",
  // Dispatch at tick 1, delivery near 1170, retirement (and its identity release) near 3200.
  ticks: 3600,
  every: 400,
  world: serviceWorld,
  initial: world => {
    // The player waits on foot beside a mid-block street; its car is parked well off the road.
    const state = createInitialState(world, 11, ["p1"], { x: 150, z: 40, heading: 0 });
    const p1 = state.players.p1!;
    const heat = createHeat();
    heat.events = [{ id: 1, tick: 0, kind: SimEventKind.threatSpawn, playerId: "p1", targetId: "", amount: 2, detail: "",
      payload: { id: "heat:p1:1", requestTick: 0, playerId: "p1", player: { x: 150, z: 8 }, kind: "van", threat: 2, unitCount: 2 } }];
    return { ...state, players: { p1: { ...p1, mode: "foot", foot: makeFoot(150, 0, 8, 0) } },
      ext: { ...state.ext, heat: heat as unknown as NonNullable<SimState["ext"]["heat"]> } };
  },
  inputs: tick => ({ p1: { throttle: 0, steer: tick % 600 < 300 ? 0.3 : -0.3, brake: 0, actions: tick % 120 === 0 ? Action.horn : 0 } }),
  events: () => [],
};

/** The Hot Desk opening: a recorded mission-start command, then spraying and watching on the spot. */
const mission: ComposedScenario = {
  name: "mission",
  ticks: 600,
  every: 100,
  world: () => buildWorld([]),
  initial: world => {
    const at = hotDeskPlace();
    const state = createInitialState(world, 71, ["p"], { x: at.x + 15, z: at.z, heading: 0 });
    return { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(at.x, 0, at.z, 0) } } };
  },
  inputs: tick => ({ p: { throttle: 0, steer: tick % 200 < 100 ? 0.2 : -0.2, brake: 0,
    actions: (tick % 40 < 15 ? Action.fire : 0) | (tick % 200 >= 100 ? Action.watch : 0), aimYaw: (tick % 180) * 0.0349066, aimPitch: 0 } }),
  events: tick => tick === 1 ? [{ tick, kind: SimEventKind.gameplayCommand, playerId: "p", payload: { sequence: 1, kind: "mission-start", targetId: "hot-desk" } }] : [],
};

function hotDeskPlace(): { x: number; z: number } {
  const opening = MISSIONS.find(m => m.id === "hot-desk")!.steps.find(s => s.type === "trigger")!;
  if (opening.type !== "trigger") throw new Error("hot-desk opening trigger missing");
  return missionPlace(opening.event.place);
}

// Keep the existing wave-2 scenarios and also pin the production wave's open-loop city run.
const wave3City: ComposedScenario = { ...city, name: "city-wave3", wave: 3 };

/** The first rainy winter game hour for `seed`, as elapsed clock ticks (the clock starts at 08:00 on day 0). */
function firstRain(seed: number): number {
  const probe = createInitialState(buildWorld([]), seed, [], { x: 0, z: 0, heading: 0 });
  for (let day = 28; day < 56; day++) for (let hour = 0; hour < 24; hour++) {
    const elapsedTicks = day * DAY_TICKS + (hour >= 8 ? hour - 8 : hour + 16) * 3600;
    if (rainDensity({ ...probe, ext: { clock: { version: 1, elapsedTicks }, fog: { version: 1, missionCursor: 0, windows: [] } } }) > 0) return elapsedTicks;
  }
  throw new Error("no rainy hour");
}
/** The city run in the rain at wave 3 (v10): wet-road driving, sheltered/exposed rust, puddles. */
const wave3Rain: ComposedScenario = {
  ...city, name: "city-wave3-rain", wave: 3,
  initial: world => {
    const state = city.initial(world);
    return { ...state, ext: { ...state.ext, clock: { version: 1, elapsedTicks: firstRain(7) } } };
  },
};

/** A stopped street taxi is commandeered, driven and parked; the own car stays behind. */
const robotaxiDrive: ComposedScenario = {
  name: "robotaxi-drive", ticks: 480, every: 80, wave: 3, world: devWorld,
  initial: world => {
    const state = createInitialState(world, 7, ["p1"], loadWorldFiles("dev").manifest.spawn);
    const source = state.ext.agents!.list.find(a => a.kind === "robotaxi" && a.id % 8 !== 7)!;
    const taxi = { ...source, speed: 0 };
    const foot = makeFoot(taxi.x - Math.cos(taxi.heading) * 1.7, taxi.y, taxi.z - Math.sin(taxi.heading) * 1.7, taxi.heading);
    return { ...state, players: { p1: { ...state.players.p1!, mode: "foot", foot } },
      ext: { ...state.ext, agents: { ...state.ext.agents!, list: state.ext.agents!.list.map(a => a.id === taxi.id ? taxi : a) } } };
  },
  inputs: tick => ({ p1: tick === 1 ? { ...idle, actions: Action.horn }
    : tick < 180 ? { throttle: .7, steer: tick >= 60 && tick < 100 ? .2 : 0, brake: 0, actions: 0 }
    : tick === 241 ? { ...idle, actions: Action.enterExit } : { ...idle, brake: 1 } }),
  events: () => [],
};
export const COMPOSED_SCENARIOS: readonly ComposedScenario[] = [city, service, mission, wave3City, wave3Rain, robotaxiDrive];

export function runComposedScenario(scenario: ComposedScenario, version = SIM_VERSION): ComposedRun {
  const world = scenario.world(), systems = createGameSystems({ wave: scenario.wave ?? 2 });
  let state = scenario.initial(world);
  state = { ...state, version };
  const hashes: string[] = [];
  const coverage: Record<string, number> = {};
  const count = (key: string, n = 1): void => { coverage[key] = (coverage[key] ?? 0) + n; };
  for (let t = 0; t < scenario.ticks; t++) {
    const tick = state.tick + 1;
    state = step(world, state, scenario.inputs(tick), scenario.events(tick), systems);
    for (const id of Object.keys(state.players).sort()) if (state.players[id]!.ride?.manual) count("robotaxi:manual-ticks");
    for (const event of state.ext.combat?.events ?? []) count(`combat:${event.kind}`);
    for (const event of state.ext.robots?.events ?? []) count(`robots:${event.kind}`);
    for (const event of state.ext.robots?.services?.events ?? []) count(`services:${event.kind}`);
    for (const event of state.ext.missions?.events ?? []) count(`missions:${event.kind}`);
    if (state.ext.fog) {
      const p1 = state.players.p1, body = p1 ? (p1.mode === "foot" && p1.foot ? p1.foot : p1.car) : null;
      if (rainDensity(state) > 0) count("weather:rain");
      if (roadWetness(state) > 0) count("weather:wet");
      if (tideLevel(state) > 0) count("weather:tide");
      if (body && fogDensity(world, state, body.x, body.z) > 0.4) count("weather:fog");
    }
    if ((t + 1) % scenario.every === 0 || t + 1 === scenario.ticks) hashes.push(hashState(state));
  }
  count("agents:final", state.ext.agents?.list.length ?? 0);
  count("identities:final", Object.keys(state.ext.identities?.ids ?? {}).length);
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(coverage).sort()) sorted[key] = coverage[key]!;
  return { hashes, coverage: sorted };
}

export interface ComposedGolden {
  simVersion: number;
  scenarios: Record<string, ComposedRun>;
}

export function recordComposedGolden(): ComposedGolden {
  const scenarios: Record<string, ComposedRun> = {};
  for (const scenario of COMPOSED_SCENARIOS) scenarios[scenario.name] = runComposedScenario(scenario);
  return { simVersion: SIM_VERSION, scenarios };
}
