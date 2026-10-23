import { existsSync } from "node:fs";
import { chromium, expect, firefox, test, webkit } from "@playwright/test";
import type { InputFrame, RoadsFile, SimEvent, TileCollider } from "../../src/sim/index.ts";
import { optionalAbsent } from "./fixtures.ts";

interface RuntimeModulePaths {
  sim: string;
  session: string;
  registration: string;
  robots: string;
  combat: string;
}
interface RuntimeParityTrace {
  checkpoints: string[];
  finalJson: string;
  coverage: {
    playersSeen: string[];
    footTicks: number;
    combatEvents: number;
    projectilePeak: number;
    robotPeak: number;
    animalPeak: number;
    routinePeak: number;
    serviceJobsPeak: number;
    serviceVehiclesPeak: number;
    externalEvents: number;
  };
}

/** Serialized directly by Playwright. All executable dependencies come from explicit
 * module paths so Node and each browser execute the same runner and actual reducers. */
async function integratedRuntimeTrace(paths: RuntimeModulePaths): Promise<RuntimeParityTrace> {
  const sim = await import(/* @vite-ignore */ paths.sim) as typeof import("../../src/sim/index.ts");
  const session = await import(/* @vite-ignore */ paths.session) as typeof import("../../src/sim/agents/runtime-state.ts");
  const registration = await import(/* @vite-ignore */ paths.registration) as typeof import("../../src/sim/agents/runtime-registration.ts");
  const robots = await import(/* @vite-ignore */ paths.robots) as typeof import("../../src/sim/robots/runtime-system.ts");
  const combat = await import(/* @vite-ignore */ paths.combat) as typeof import("../../src/sim/agents/runtime-combat.ts");
  const seed = 20261023, ticks = 1800;
  // The grid joins the Ferry Building origin to the real HQ vicinity, allowing the
  // normal depot selector and procedural bus fallback to run without mocked services.
  const xs = [-1000, -750, -500, -250, 0], zs = [0, 250, 500, 750, 1000, 1250, 1500];
  const nodes: RoadsFile["nodes"][number][] = [];
  const edges: RoadsFile["edges"][number][] = [];
  const buildings: TileCollider["buildings"] = [];
  for (let x = 0; x < xs.length; x++) for (let z = 0; z < zs.length; z++) {
    nodes.push({ id: `n${x}_${z}`, x: xs[x]!, z: zs[z]! });
    if (x + 1 < xs.length) edges.push({ id: `h${x}_${z}`, a: `n${x}_${z}`, b: `n${x + 1}_${z}`,
      kind: "residential", lanes: 2, oneway: false, widthM: 12, speedLimitMps: 10,
      points: [[xs[x]!, zs[z]!], [xs[x + 1]!, zs[z]!]] });
    if (z + 1 < zs.length) edges.push({ id: `v${x}_${z}`, a: `n${x}_${z}`, b: `n${x}_${z + 1}`,
      kind: "residential", lanes: 2, oneway: false, widthM: 12, speedLimitMps: 10,
      points: [[xs[x]!, zs[z]!], [xs[x]!, zs[z + 1]!]] });
    if (x + 1 < xs.length && z + 1 < zs.length) buildings.push({ id: `block${x}_${z}`, baseY: 0, topY: 12,
      footprint: [[xs[x]! + 18, zs[z]! + 18], [xs[x + 1]! - 18, zs[z]! + 18],
        [xs[x + 1]! - 18, zs[z + 1]! - 18], [xs[x]! + 18, zs[z + 1]! - 18]] });
  }
  const world = sim.buildWorld([{ tileId: "runtime-grid", buildings, ground: null }], { version: 1, nodes, edges });
  let state = session.enableAgentRuntime(sim.createInitialState(world, seed, ["p1", "p2", "p3"], { x: -10, z: 0, heading: -sim.PI / 2 }), {
    wave: 4, startGameMinute: 179, startWeekday: 2,
  });
  state.players.p1!.car = sim.makeCar(-10, 0, -sim.PI / 2);
  state.players.p2!.mode = "foot";
  state.players.p2!.foot = sim.makeFoot(-750, 0, 1242, sim.PI / 2);
  state.players.p2!.car = sim.makeCar(-750, 1270, 0);
  state.players.p3!.car = sim.makeCar(-500, 740, 0);
  const systems = [registration.completeAgentRuntimeSystem, robots.robotRuntimeSystem, combat.runtimeCombatSystem];
  const checkpoints: string[] = [];
  const seen = new Set(sim.sortedIds(state.players));
  const coverage: RuntimeParityTrace["coverage"] = {
    playersSeen: [], footTicks: 0, combatEvents: 0, projectilePeak: 0, robotPeak: 0,
    animalPeak: 0, routinePeak: 0, serviceJobsPeak: 0, serviceVehiclesPeak: 0, externalEvents: 0,
  };
  for (let tick = 1; tick <= ticks; tick++) {
    const inputs: Record<string, InputFrame[string]> = {};
    for (const id of sim.sortedIds(state.players)) {
      const n = Number(id.slice(1));
      let actions = tick % (90 + n * 10) === 0 ? sim.Action.horn : 0;
      if (id === "p2" && tick % 600 >= 60 && tick % 600 < 160) actions |= sim.Action.fire;
      if (id === "p2" && tick % 600 >= 180 && tick % 600 < 250) actions |= sim.Action.scan;
      if (id === "p2" && tick % 600 >= 300 && tick % 600 < 500) actions |= sim.Action.watch;
      if (id !== "p2" && (tick === 420 || tick === 900)) actions |= sim.Action.enterExit;
      inputs[id] = {
        throttle: id === "p2" ? 0 : tick % 300 < 240 ? 0.35 : -0.15,
        steer: id === "p2" ? 0 : Math.floor(tick / 120) % 2 === 0 ? 0.2 : -0.2,
        brake: tick % 300 >= 240 ? 0.6 : 0,
        aimYaw: id === "p2" ? sim.PI / 2 : 0, aimPitch: 0.05, actions,
      };
    }
    const events: SimEvent[] = [];
    if (tick === 120 || tick === 720) events.push({ tick, kind: "threat.spawn", playerId: "p2",
      payload: { id: `parity-van-${tick}`, playerId: "p2", requestTick: tick, kind: "van", threat: 2, unitCount: 2 } });
    if (tick === 360) events.push({ tick, kind: "threat.spawn", playerId: "p2",
      payload: { id: "parity-drones", playerId: "p2", requestTick: tick, kind: "drone", threat: 3, unitCount: 2 } });
    if (tick === 600) events.push({ tick, kind: "player.join", playerId: "p4", payload: { x: -250, z: 500, heading: 0 } });
    if (tick === 1200) events.push({ tick, kind: "player.leave", playerId: "p3" });
    if (tick === 540 || tick === 1080) events.push({ tick, kind: "gameplay.command", playerId: "p2",
      payload: { sequence: tick, kind: "close-ad" } });
    coverage.externalEvents += events.length;
    state = sim.step(world, state, inputs, events, systems);
    for (const id of sim.sortedIds(state.players)) {
      seen.add(id);
      if (state.players[id]!.mode === "foot") coverage.footTicks++;
    }
    const agents = registration.completeAgentRuntimeOf(state)!;
    const robotState = robots.robotsRuntimeOf(state)!;
    coverage.combatEvents += state.ext.combat!.events.length;
    coverage.projectilePeak = Math.max(coverage.projectilePeak, state.ext.combat!.projectiles.length);
    coverage.robotPeak = Math.max(coverage.robotPeak, robotState.brain.robots.length);
    coverage.animalPeak = Math.max(coverage.animalPeak, agents.spatial.animals.length);
    coverage.routinePeak = Math.max(coverage.routinePeak, agents.routines?.specials.length ?? 0);
    coverage.serviceJobsPeak = Math.max(coverage.serviceJobsPeak, agents.fleet.vans.jobs.length + agents.fleet.buses.runs.length);
    coverage.serviceVehiclesPeak = Math.max(coverage.serviceVehiclesPeak, agents.fleet.vehicles.length);
    if (tick % 60 === 0) checkpoints.push(`${state.tick}:${sim.hashState(state)}`);
  }
  coverage.playersSeen = [...seen].sort();
  return { checkpoints, finalJson: sim.canonicalJson(state), coverage };
}

function browserInstalled(name: string): boolean {
  const type = { chromium, firefox, webkit }[name];
  try { return type !== undefined && existsSync(type.executablePath()); } catch { return false; }
}

test.describe("activated agent runtime parity", { tag: "@engines" }, () => {
  test.skip(({ browserName }) => optionalAbsent("engines", browserInstalled(browserName)), "browser engine is not installed");

  test("Node and browser agree across 1,800 integrated multiplayer ticks", async ({ page, browserName }) => {
    const relative: RuntimeModulePaths = {
      sim: "/src/sim/index.ts", session: "/src/sim/agents/runtime-state.ts",
      registration: "/src/sim/agents/runtime-registration.ts", robots: "/src/sim/robots/runtime-system.ts",
      combat: "/src/sim/agents/runtime-combat.ts",
    };
    const local = Object.fromEntries(Object.entries(relative).map(([name, path]) => [name, new URL(`../../${path.slice(1)}`, import.meta.url).href])) as unknown as RuntimeModulePaths;
    const node = await integratedRuntimeTrace(local);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/__agent-runtime-parity", route => route.fulfill({ status: 200, contentType: "text/html",
      body: "<!doctype html><title>Integrated runtime parity</title>" }));
    await page.goto("/__agent-runtime-parity");
    const actual = await page.evaluate(integratedRuntimeTrace, relative);
    expect(errors).toEqual([]);
    expect(actual.checkpoints).toHaveLength(30);
    for (let index = 0; index < node.checkpoints.length; index++) {
      expect(actual.checkpoints[index], `first differing integrated checkpoint ${index + 1}`).toBe(node.checkpoints[index]);
    }
    expect(actual.finalJson === node.finalJson, "complete serialized state matches, not only sampled hashes").toBe(true);
    expect(actual.coverage).toEqual(node.coverage);
    expect(node.coverage.playersSeen).toEqual(["p1", "p2", "p3", "p4"]);
    expect(node.coverage.footTicks).toBeGreaterThan(0);
    expect(node.coverage.combatEvents).toBeGreaterThan(0);
    expect(node.coverage.projectilePeak).toBeGreaterThan(0);
    expect(node.coverage.robotPeak).toBeGreaterThan(0);
    expect(node.coverage.animalPeak).toBeGreaterThan(0);
    expect(node.coverage.routinePeak).toBeGreaterThan(0);
    expect(node.coverage.serviceJobsPeak).toBeGreaterThan(0);
    expect(node.coverage.serviceVehiclesPeak).toBeGreaterThan(0);
    expect(node.coverage.externalEvents).toBe(7);
    test.info().annotations.push({ type: "runtime-parity", description: `${browserName}: 30 full-runtime checkpoints, 1,800 ticks, four player identities; ${JSON.stringify(node.coverage)}` });
  });
});
