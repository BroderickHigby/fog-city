// Ambient agents at city scale (src/sim/agents.ts, "Population"): the whole city's road graph is
// loaded, but agents exist only in the seeded budgets of the areas around the players, each
// player gets their own share, and surface traffic never routes onto a freeway (no decks yet)
// or a pedestrian-only street.
import { beforeAll, describe, expect, it } from "vitest";
import {
  ACTIVE_RANGE_M,
  AGENT_KINDS,
  AGENT_SPEC,
  AREA_M,
  DESPAWN_RANGE_M,
  MAX_AGENTS,
  MAX_AGENTS_TOTAL,
  POP_INTERVAL,
  agentsOf,
  areaBudget,
  areaOf,
  buildWorld,
  createInitialState,
  hashState,
  step,
  type AgentState,
  type RoadsFile,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { loadWorldFiles, worldExists } from "../helpers.ts";
import { SF_RUN_MS } from "./fixtures.ts";

const SF = worldExists("sf");
const NEUTRAL = { throttle: 0, steer: 0, brake: 0, actions: 0 };

function nearestTo(a: AgentState, players: ReadonlyArray<{ x: number; z: number }>): number {
  let best = Infinity;
  let at = 0;
  players.forEach((p, i) => {
    const d = (a.x - p.x) * (a.x - p.x) + (a.z - p.z) * (a.z - p.z);
    if (d < best) {
      best = d;
      at = i;
    }
  });
  return at;
}

describe.skipIf(!SF)("agent budget near players, on the whole city", () => {
  let world: World;
  let rawEdges: Map<string, RoadsFile["edges"][number]>;
  let spawn: { x: number; z: number; heading: number };
  beforeAll(() => {
    const files = loadWorldFiles("sf");
    world = buildWorld(files.tiles, files.roads as RoadsFile, files.boundary);
    rawEdges = new Map((files.roads as RoadsFile).edges.map((e) => [e.id, e]));
    spawn = files.manifest.spawn;
  }, SF_RUN_MS);

  it("populates only the areas around the player, within their seeded budgets", () => {
    const s = createInitialState(world, 1, ["p1"], spawn);
    const list = agentsOf(s);
    expect(list.length).toBeGreaterThan(100);
    expect(list.length).toBeLessThanOrEqual(MAX_AGENTS);
    // Active areas have their centre within ACTIVE_RANGE_M plus half an area's diagonal of the player.
    const reach = ACTIVE_RANGE_M + AREA_M * 0.7072;
    for (const a of list) expect(Math.hypot(a.x - spawn.x, a.z - spawn.z)).toBeLessThanOrEqual(reach + AREA_M * 0.7072);
    // A few dozen of the city's ~1,900 areas hold agents, not the whole city.
    const areas = new Set(list.map((a) => areaOf(a.x, a.z).key));
    expect(world.roads!.areas.length).toBeGreaterThan(1500);
    expect(areas.size).toBeLessThan(40);
    // Each kind stays within the summed budgets of the areas that hold it.
    for (const kind of AGENT_KINDS) {
      const n = list.filter((a) => a.kind === kind).length;
      let budget = 0;
      for (const ar of world.roads!.areas) {
        if (Math.hypot(ar.cx - spawn.x, ar.cz - spawn.z) <= reach) budget += areaBudget(world, 1, ar.key)[kind];
      }
      expect(n, kind).toBeLessThanOrEqual(budget);
    }
  }, SF_RUN_MS);

  it("is seeded and deterministic: the same seed and players give the same agents, another seed differs", () => {
    const a = createInitialState(world, 1, ["p1"], spawn);
    const b = createInitialState(world, 1, ["p1"], spawn);
    const c = createInitialState(world, 2, ["p1"], spawn);
    expect(hashState(a)).toBe(hashState(b));
    expect(hashState(a)).not.toBe(hashState(c));
  }, SF_RUN_MS);

  it("gives a second player across town their own traffic, each player at most MAX_AGENTS", () => {
    // North Beach is dense enough to fill one player's share by itself.
    const nb = { x: -1600, z: -1000, heading: 0 };
    const solo = createInitialState(world, 3, ["p1"], nb);
    expect(agentsOf(solo).length).toBe(MAX_AGENTS);
    // p2 joins in the Mission, 4.5 km away: within a minute the areas around p2 fill too.
    const mission = { x: -2200, z: 3300, heading: 0 };
    let s: SimState = step(world, solo, { p1: NEUTRAL }, [{ tick: 1, kind: "player.join", playerId: "p2", payload: mission }]);
    for (let t = 0; t < POP_INTERVAL * 30; t++) s = step(world, s, { p1: NEUTRAL, p2: NEUTRAL });
    const list = agentsOf(s);
    const bodies = [nb, mission];
    const share = [0, 0];
    for (const a of list) share[nearestTo(a, bodies)]!++;
    expect(list.length).toBeLessThanOrEqual(MAX_AGENTS_TOTAL);
    expect(share[0]).toBeLessThanOrEqual(MAX_AGENTS);
    expect(share[1]).toBeLessThanOrEqual(MAX_AGENTS);
    expect(share[1], "p2's surroundings got agents of their own").toBeGreaterThan(150);
    expect(share[0], "p1 kept theirs").toBeGreaterThan(400);
    for (const a of list) expect(Math.min(Math.hypot(a.x - nb.x, a.z - nb.z), Math.hypot(a.x - mission.x, a.z - mission.z))).toBeLessThanOrEqual(DESPAWN_RANGE_M);
  }, SF_RUN_MS);

  it("never routes surface traffic onto a freeway, a ramp joining one, or a pedestrian street", () => {
    const g = world.roads!;
    let freeways = 0;
    for (const e of g.edges) {
      const raw = rawEdges.get(e.id)!;
      if (raw.gradeSeparated) {
        freeways++;
        expect(e.drivable, e.id).toBe(false);
        expect(e.walkable, e.id).toBe(false);
      }
      if (raw.pedestrian) expect(e.drivable, e.id).toBe(false);
    }
    expect(freeways).toBeGreaterThan(100);
    // Drive the traffic next to the Central Freeway's ramps for 40 s and check every edge used.
    const fw = g.edges.find((e) => rawEdges.get(e.id)!.gradeSeparated && e.name.includes("101"))?.center ?? g.edges.find((e) => rawEdges.get(e.id)!.gradeSeparated)!.center;
    const mid = { x: fw.xs[Math.floor(fw.xs.length / 2)]!, z: fw.zs[Math.floor(fw.zs.length / 2)]!, heading: 0 };
    let s = createInitialState(world, 5, ["p1"], mid);
    const bad: string[] = [];
    const check = (st: SimState): void => {
      for (const a of agentsOf(st)) {
        for (const id of [a.edge, a.next]) {
          if (id === "") continue;
          const e = g.edges[g.edgeIndex.get(id)!]!;
          if (AGENT_SPEC[a.kind].road ? !e.drivable : !e.walkable) bad.push(`${a.kind} #${a.id} on ${id}`);
        }
      }
    };
    check(s);
    for (let t = 0; t < 2400; t++) {
      s = step(world, s, { p1: NEUTRAL });
      if (t % 20 === 0) check(s);
    }
    expect(agentsOf(s).length).toBeGreaterThan(50);
    expect(bad.slice(0, 5)).toEqual([]);
  }, SF_RUN_MS);
});
