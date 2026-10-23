// Street incidents and ambient density (v11 city life, src/sim/agents/incidents.ts and
// content/city-life.json) through the game composition on the grid city: the director's cards are
// staged for real near the player, the robots do what the card says, nobody is touched, and robots
// fill the streets at the city-life densities.
import { describe, expect, it } from "vitest";
import {
  AGENT_SPEC, agentsOf, createGameSystems, createInitialState, dodgeExtOf, makeFoot, step,
  type SimState, type World,
} from "../../../src/sim/index.ts";
import { agentsRuntimeOf } from "../../../src/sim/agents/runtime.ts";
import { fallbackGraph } from "../../../src/sim/agents/runtime.ts";
import { projectOnPath } from "../../../src/sim/roads.ts";
import { CITY_LIFE } from "../../../src/content/cityLife.ts";
import { LONG_RUN_MS, gridCity } from "../fixtures.ts";

const systems = createGameSystems({ wave: 2, protectedArea: () => false });

/** p1 on foot at (x, z) facing east, their car parked out of the way on the grid's west edge. */
function standing(world: World, x: number, z: number, seed = 7): SimState {
  const s = createInitialState(world, seed, ["p1"], { x: -20, z: 150, heading: 0 });
  return { ...s, players: { p1: { ...s.players.p1!, mode: "foot", foot: makeFoot(x, 0, z, Math.PI / 2) } } };
}

/** The director's request for `card`, as the activities system emits it on the previous tick. */
function request(s: SimState, card: string): SimState {
  const activities = s.ext.activities as unknown as Record<string, unknown>;
  return { ...s, ext: { ...s.ext, activities: { ...activities, events: [{ id: 9999, tick: s.tick, kind: "director.stage", playerId: "p1", targetId: card, amount: 0, detail: "" }] } as never } };
}

function run(world: World, s: SimState, ticks: number, each?: (s: SimState) => void): SimState {
  for (let t = 0; t < ticks; t++) {
    s = step(world, s, {}, [], systems);
    expect(dodgeExtOf(s).contacts).toBe(0);
    each?.(s);
  }
  return s;
}

describe("the director's cards are staged as street incidents", () => {
  const world = gridCity();

  for (const card of ["snatch-in-progress", "malfunction-spree", "crosswalk-squatter", "robotaxi-standoff"]) {
    it(`${card}: staged ${CITY_LIFE.director.stageM.join("–")} m from the player, every robot physically there`, () => {
      let s = run(world, standing(world, 150, 107), 5);
      s = run(world, request(s, card), 2);
      const runtime = agentsRuntimeOf(s)!;
      const incidents = Object.values(runtime.incidents ?? {}).filter((i) => i.cardId === card);
      expect(incidents).toHaveLength(1);
      const incident = incidents[0]!;
      const d = Math.hypot(incident.x - 150, incident.z - 107);
      expect(d).toBeGreaterThanOrEqual(CITY_LIFE.director.stageM[0]);
      expect(d).toBeLessThanOrEqual(CITY_LIFE.director.stageM[1]);
      expect(incident.targetIds.length).toBeGreaterThanOrEqual(1);
      const bodies = new Set((s.ext.agents?.list ?? []).map((a) => a.runtimeId));
      for (const id of incident.actorIds) {
        expect(bodies.has(id), id).toBe(true);
        expect(runtime.actors[id]!.significant).toBe(true);
      }
      for (const id of incident.targetIds) expect(runtime.actors[id]!.firmware).toBe("bad");
      if (card === "robotaxi-standoff") {
        const [a, b] = incident.actorIds.map((id) => runtime.actors[id]!);
        expect(a!.model).toBe("robotaxi");
        expect(Math.hypot(a!.x - b!.x, a!.z - b!.z)).toBeLessThan(7);
        // Nose to nose: facing opposite ways, each towards the other.
        expect(Math.abs(Math.cos(a!.heading - b!.heading) + 1)).toBeLessThan(1e-6);
      }
      if (card === "crosswalk-squatter") {
        const graph = fallbackGraph(world)!;
        const trundle = runtime.actors[incident.targetIds[0]!]!;
        expect(trundle.model).toBe("trundle");
        expect(trundle.posted).toBe(true);
        const onCrosswalk = graph.edges.some((e) => e.kind === "crosswalk" && projectOnPath(e.path, trundle.x, trundle.z).dist < 0.5);
        expect(onCrosswalk).toBe(true);
      }
    }, LONG_RUN_MS);
  }

  it("a staged snatch happens: the bad Footman lifts a good one's groceries within 30 s", () => {
    let s = run(world, standing(world, 150, 107), 5);
    s = request(s, "snatch-in-progress");
    let snatched = 0;
    run(world, s, 1800, (k) => { for (const e of k.ext.combat?.events ?? []) if (e.kind === "robot.inventory") snatched++; });
    expect(snatched).toBeGreaterThanOrEqual(1);
  }, LONG_RUN_MS);

  it("left alone, the director stages something within 150 m inside a minute, from several places", () => {
    for (const [x, z] of [[150, 107], [50, 207], [250, 7], [107, 250], [207, 150]] as const) {
      let s = standing(world, x, z, 11);
      let found = false;
      for (let t = 0; t < 3600 && !found; t++) {
        s = step(world, s, {}, [], systems);
        found = Object.values(agentsRuntimeOf(s)?.incidents ?? {}).some((i) => Math.hypot(i.x - x, i.z - z) <= 150);
      }
      expect(found, `${x},${z}`).toBe(true);
      expect(dodgeExtOf(s).contacts).toBe(0);
    }
  }, LONG_RUN_MS * 3);
});

describe("ambient robots at the city-life densities", () => {
  it("the game composition fills the streets with more robots than the base densities; people stay as they were", () => {
    const world = gridCity();
    const count = (s: SimState, robots: boolean) => agentsOf(s).filter((a) => (a.runtimeId === undefined || a.runtimeLegacy === true) && !AGENT_SPEC[a.kind].road && (a.kind !== "person") === robots).length;
    let game = standing(world, 150, 150), bare = game;
    for (let t = 0; t < 900; t++) {
      game = step(world, game, {}, [], systems);
      bare = step(world, bare, {});
    }
    expect(agentsRuntimeOf(game)!.density!.p1!.errandRobot).toBeGreaterThan(1.5);
    expect(count(game, true)).toBeGreaterThan(1.5 * count(bare, true));
    expect(Math.abs(count(game, false) - count(bare, false))).toBeLessThanOrEqual(0.25 * count(bare, false) + 2);
  }, LONG_RUN_MS);
});

describe("v10 save (before city-life densities and incidents)", () => {
  it("upgrades to the current version with every field kept, then fills in densities and stages incidents", async () => {
    const saved = (await import("../../golden/legacy-saves/v10-game-grid.json")).default as unknown as { simVersion: number; hash: string; state: SimState };
    const { SIM_VERSION, hashState, upgradeState, canonicalJson } = await import("../../../src/sim/index.ts");
    expect(saved.simVersion).toBe(10);
    const old = saved.state;
    expect(hashState(old)).toBe(saved.hash);
    expect(agentsRuntimeOf(old)!.incidents).toBeUndefined();
    const upgraded = upgradeState(old);
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    const world = gridCity();
    const runOn = (from: SimState) => {
      let s = upgradeState(from);
      for (let t = 0; t < 3600 && !Object.keys(agentsRuntimeOf(s)?.incidents ?? {}).length; t++) s = step(world, s, {}, [], systems);
      return s;
    };
    const a = runOn(old), b = runOn(JSON.parse(canonicalJson(old)) as SimState);
    expect(agentsRuntimeOf(a)!.density!.p1).toBeDefined();
    expect(Object.keys(agentsRuntimeOf(a)!.incidents!).length).toBe(1);
    expect(hashState(a)).toBe(hashState(b));
  }, LONG_RUN_MS);
});
