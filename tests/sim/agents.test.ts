// Ambient agents: population, movement rules and invariants on the synthetic grid city and
// the dev loop.
import { describe, expect, it } from "vitest";
import {
  AGENTS_EXT_KEY,
  AGENT_KINDS,
  AGENT_SPEC,
  CAR,
  DESPAWN_RANGE_M,
  GHOST_AFTER_TICKS,
  KEEP_RIGHT_M,
  LOD_STRIDE,
  NEAR_RANGE_M,
  POP_INTERVAL,
  ROBOTAXI_GAP_M,
  agentById,
  agentCount,
  agentsOf,
  areaBudget,
  areaOf,
  canonicalJson,
  circleBlocked,
  connectorPath,
  createInitialState,
  dcos,
  dsin,
  explainAgent,
  hashState,
  laneOffset,
  lanePath,
  pathPoint,
  pointInPolygon,
  projectOnPath,
  step,
  walkPath,
  type AgentState,
  type InputFrame,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { gridCity, loadDevWorldWithRoads } from "./fixtures.ts";

const NONE: InputFrame = {};
/** A player parked off the grid's west edge: every block is within range, nothing is blocked. */
const OFFSIDE = { x: -20, z: 150, heading: 0 };

function run(world: World, s: SimState, ticks: number, input: InputFrame | ((t: number) => InputFrame) = NONE, each?: (s: SimState, t: number) => void): SimState {
  for (let t = 0; t < ticks; t++) {
    s = step(world, s, typeof input === "function" ? input(s.tick) : input);
    each?.(s, t);
  }
  return s;
}

/** Do two oriented rectangles overlap? (Separating axis test.) */
function boxesOverlap(a: { x: number; z: number; heading: number; hl: number; hw: number }, b: typeof a): boolean {
  const axes = (h: number): Array<[number, number]> => [
    [dsin(h), -dcos(h)],
    [dcos(h), dsin(h)],
  ];
  const corners = (r: typeof a): Array<[number, number]> => {
    const [f, s] = axes(r.heading) as [[number, number], [number, number]];
    const out: Array<[number, number]> = [];
    for (const i of [-1, 1]) for (const j of [-1, 1]) out.push([r.x + f[0] * r.hl * i + s[0] * r.hw * j, r.z + f[1] * r.hl * i + s[1] * r.hw * j]);
    return out;
  };
  const ca = corners(a);
  const cb = corners(b);
  for (const [ax, az] of [...axes(a.heading), ...axes(b.heading)]) {
    const pa = ca.map(([x, z]) => x * ax + z * az);
    const pb = cb.map(([x, z]) => x * ax + z * az);
    if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
  }
  return true;
}

function bodyOf(a: AgentState) {
  const sp = AGENT_SPEC[a.kind];
  return { x: a.x, z: a.z, heading: a.heading, hl: sp.halfLength, hw: sp.halfWidth };
}

describe("population", () => {
  const world = gridCity();

  it("the initial state fills the active areas from their seeded budgets, every kind present", () => {
    const s = createInitialState(world, 7, ["p1"], OFFSIDE);
    const list = agentsOf(s);
    expect(Object.keys(s.ext)).toEqual([AGENTS_EXT_KEY]);
    for (const k of AGENT_KINDS) expect(agentCount(s, k)).toBeGreaterThan(0);
    const budget: Record<string, number> = {};
    for (const ar of world.roads!.areas) {
      const b = areaBudget(world, 7, ar.key);
      for (const k of AGENT_KINDS) budget[k] = (budget[k] ?? 0) + b[k];
    }
    for (const k of AGENT_KINDS) expect(agentCount(s, k)).toBeLessThanOrEqual(budget[k]!);
    expect(list.length).toBeGreaterThan(0.8 * Object.values(budget).reduce((p, q) => p + q, 0));
    // Ascending, unique ids; nextId is past every id.
    for (let i = 1; i < list.length; i++) expect(list[i]!.id).toBeGreaterThan(list[i - 1]!.id);
    expect(agentById(s, list[3]!.id)).toBe(list[3]);
  });

  it("budgets and placements are seeded: same seed same agents, another seed differs", () => {
    const a = createInitialState(world, 7, ["p1"], OFFSIDE);
    const b = createInitialState(world, 7, ["p1"], OFFSIDE);
    const c = createInitialState(world, 8, ["p1"], OFFSIDE);
    expect(hashState(a)).toBe(hashState(b));
    expect(canonicalJson(agentsOf(a))).not.toBe(canonicalJson(agentsOf(c)));
    const keys = world.roads!.areas.map((ar) => ar.key);
    const budgets = (seed: number) => keys.map((k) => canonicalJson(areaBudget(world, seed, k))).join("|");
    expect(budgets(7)).toBe(budgets(7));
    let differs = false;
    for (let seed = 1; seed < 6 && !differs; seed++) differs = budgets(seed) !== budgets(seed + 100);
    expect(differs).toBe(true);
  });

  it("a world without roads has no agents and no ext key", () => {
    const { world: dev } = loadDevWorldWithRoads();
    const plain = { ...dev, roads: null };
    const s = run(plain, createInitialState(plain, 1, ["p1"], { x: 0, z: 0, heading: 0 }), 60);
    expect(s.ext).toEqual({});
    expect(agentsOf(s)).toEqual([]);
  });

  it("with no players every agent is frozen", () => {
    let s = createInitialState(world, 7, ["p1"], OFFSIDE);
    s = step(world, s, NONE, [{ tick: 1, kind: "player.leave", playerId: "p1" }]);
    const before = agentsOf(s);
    s = run(world, s, 120);
    expect(agentsOf(s)).toEqual(before);
  });

  it("agents far from every player are removed, and none spawn where there are no roads", () => {
    let s = createInitialState(world, 7, ["p1"], OFFSIDE);
    expect(agentsOf(s).length).toBeGreaterThan(0);
    s = step(world, s, NONE, [
      { tick: 1, kind: "player.leave", playerId: "p1" },
      { tick: 1, kind: "player.join", playerId: "p2", payload: { x: 5000, z: 5000, heading: 0 } },
    ]);
    s = run(world, s, POP_INTERVAL);
    for (const a of agentsOf(s)) expect(Math.hypot(a.x - 5000, a.z - 5000)).toBeLessThanOrEqual(DESPAWN_RANGE_M);
    expect(agentsOf(s).length).toBe(0);
  });

  it("the population holds steady over time (no creep past the summed budgets)", () => {
    let s = createInitialState(world, 7, ["p1"], OFFSIDE);
    const n0 = agentsOf(s).length;
    s = run(world, s, 3000);
    expect(agentsOf(s).length).toBeLessThanOrEqual(n0 + 2);
    expect(agentsOf(s).length).toBeGreaterThanOrEqual(n0 - 6);
  });
});

describe("movement invariants over a long run (grid city, 4000 ticks)", () => {
  const world = gridCity(true); // with the hill
  const g = world.roads!;
  const buildings = world.tiles.flatMap((t) => t.buildings);
  let s = createInitialState(world, 11, ["p1"], OFFSIDE);
  const failures: string[] = [];
  let robotaxiSpeed = 0;
  let robotaxiSamples = 0;
  let maxWait = 0;
  const startPositions = new Map(agentsOf(s).map((a) => [a.id, [a.x, a.z] as const]));
  s = run(world, s, 4000, NONE, (k) => {
    const list = agentsOf(k);
    const taxis = list.filter((a) => a.kind === "robotaxi");
    for (const a of list) {
      const sp = AGENT_SPEC[a.kind];
      // 1. Never inside a building: centre point, and the body circles the sim promises.
      for (const b of buildings) if (pointInPolygon(a.x, a.z, b.footprint)) failures.push(`t${k.tick} #${a.id} ${a.kind} inside ${b.id}`);
      if (!sp.road && circleBlocked(world, a.x, a.z, sp.radius * 0.79)) failures.push(`t${k.tick} #${a.id} body in a building`);
      if (sp.road) {
        const o = sp.halfLength - sp.halfWidth;
        for (const sgn of [-1, 1]) if (circleBlocked(world, a.x + dsin(a.heading) * o * sgn, a.z - dcos(a.heading) * o * sgn, sp.halfWidth * 0.79)) failures.push(`t${k.tick} robotaxi #${a.id} body in a building`);
      }
      // 2. On its road or sidewalk.
      const e = g.edges[g.edgeIndex.get(a.edge)!]!;
      if (a.conn) {
        const d = projectOnPath(connectorPath(a.conn), a.x, a.z).dist;
        if (d > Math.abs(a.lat) + 1e-6) failures.push(`t${k.tick} #${a.id} off its connector by ${d}`);
      } else if (sp.road) {
        const d = projectOnPath(lanePath(e, a.dir, a.lane), a.x, a.z).dist;
        if (d > 1e-6) failures.push(`t${k.tick} robotaxi #${a.id} off its lane by ${d}`);
        const fromCentre = projectOnPath(e.center, a.x, a.z).dist;
        if (fromCentre + sp.halfWidth > e.widthM / 2 + 0.25) failures.push(`t${k.tick} robotaxi #${a.id} outside the road (${fromCentre})`);
        if (Math.abs(fromCentre - Math.abs(laneOffset(e, a.dir, a.lane))) > 0.3) failures.push(`t${k.tick} robotaxi #${a.id} not on its lane line`);
      } else {
        const d = projectOnPath(walkPath(e, a.dir, a.lane), a.x, a.z).dist;
        if (d > Math.abs(a.lat) + 1e-6 || Math.abs(a.lat) > 0.8 + 1e-9) failures.push(`t${k.tick} #${a.id} off its sidewalk by ${d}`);
        const fromCentre = projectOnPath(e.center, a.x, a.z).dist;
        const line = e.widthM / 2 + e.sidewalkM[a.lane === 1 ? 0 : 1];
        if (Math.abs(fromCentre - line) > KEEP_RIGHT_M + 0.8 + 0.3) failures.push(`t${k.tick} #${a.id} ${a.kind} not on the sidewalk (${fromCentre} vs ${line})`);
      }
      maxWait = Math.max(maxWait, a.wait);
    }
    // 3. Robotaxi bodies never overlap.
    for (let i = 0; i < taxis.length; i++) {
      robotaxiSpeed += taxis[i]!.speed;
      robotaxiSamples++;
      for (let j = i + 1; j < taxis.length; j++) {
        if (boxesOverlap(bodyOf(taxis[i]!), bodyOf(taxis[j]!))) failures.push(`t${k.tick} robotaxis #${taxis[i]!.id} and #${taxis[j]!.id} overlap`);
      }
    }
  });

  it("no agent is ever inside a building", () => {
    expect(failures.filter((f) => f.includes("inside") || f.includes("in a building")).slice(0, 5)).toEqual([]);
  });

  it("every agent stays on its lane, sidewalk or connector within tolerance", () => {
    expect(failures.filter((f) => f.includes("off ") || f.includes("outside") || f.includes("not on")).slice(0, 5)).toEqual([]);
  });

  it("robotaxis keep their spacing: no two bodies ever overlap", () => {
    expect(failures.filter((f) => f.includes("overlap")).slice(0, 5)).toEqual([]);
  });

  it("traffic keeps moving: nobody waits long enough to need the deadlock breaker", () => {
    expect(maxWait).toBeLessThan(GHOST_AFTER_TICKS);
    expect(robotaxiSpeed / robotaxiSamples).toBeGreaterThan(5);
    let moved = 0;
    for (const a of agentsOf(s)) {
      const p = startPositions.get(a.id);
      if (p && Math.hypot(a.x - p[0], a.z - p[1]) > 20) moved++;
    }
    expect(moved).toBeGreaterThan(agentsOf(s).length * 0.6);
  });

  it("agents follow the terrain", () => {
    for (const a of agentsOf(s)) expect(a.y).toBeCloseTo(a.x <= 150 ? 0 : 0.12 * (Math.min(a.x, 300) - 150), 6);
  });

  it("one-way streets are only ever driven one way", () => {
    // Re-check the final state: v1x is one-way a -> b (southbound).
    for (const a of agentsOf(s)) if (a.kind === "robotaxi" && a.edge.startsWith("v1")) expect(a.dir).toBe(1);
  });
});

describe("yielding", () => {
  it("a robotaxi stops behind a car parked in its lane, keeps a gap, and honks", () => {
    const { world } = loadDevWorldWithRoads();
    let s = createInitialState(world, 3, ["p1"], { x: 0, z: 0, heading: 0 });
    const taxi = agentsOf(s).find((a) => a.kind === "robotaxi" && !a.conn)!;
    expect(taxi).toBeDefined();
    // Park the player's car 25 m ahead of that robotaxi in its lane (or on its next one).
    const g = world.roads!;
    const e = g.edges[g.edgeIndex.get(taxi.edge)!]!;
    const lane = lanePath(e, taxi.dir, taxi.lane);
    const at = Math.min(taxi.s + 25, lane.len - 3);
    const q = pathPoint(lane, at);
    const heading = Math.atan2(q.tx, -q.tz);
    s = { ...s, players: { p1: { ...s.players.p1!, car: { ...s.players.p1!.car, x: q.x, z: q.z, heading } } } };
    const playerBox = { x: q.x, z: q.z, heading, hl: CAR.halfLength, hw: CAR.halfWidth };
    s = run(world, s, 600, NONE, (k) => {
      for (const a of agentsOf(k)) if (a.kind === "robotaxi") expect(boxesOverlap(bodyOf(a), playerBox)).toBe(false);
    });
    const t = agentById(s, taxi.id)!;
    expect(t.speed).toBe(0);
    expect(t.mode).toBe("honk");
    const why = explainAgent(world, s, taxi.id)!;
    expect(why.blocker).toBe("player");
    // Bumper to bumper: at least the robotaxi gap, not much more.
    const along = (t.s - at) * -1;
    const gap = along - AGENT_SPEC.robotaxi.halfLength - CAR.halfLength;
    expect(gap).toBeGreaterThan(ROBOTAXI_GAP_M * 0.5);
    expect(gap).toBeLessThan(ROBOTAXI_GAP_M + 3);
  });

  it("robotaxis queue behind each other with a gap; the queue never overlaps", () => {
    const { world } = loadDevWorldWithRoads();
    // Player car parked across both lanes of the north road.
    let s = createInitialState(world, 5, ["p1"], { x: 0, z: -50, heading: 0 });
    s = run(world, s, 1800, NONE, (k) => {
      const taxis = agentsOf(k).filter((a) => a.kind === "robotaxi");
      for (let i = 0; i < taxis.length; i++) {
        for (let j = i + 1; j < taxis.length; j++) expect(boxesOverlap(bodyOf(taxis[i]!), bodyOf(taxis[j]!))).toBe(false);
      }
    });
    const stopped = agentsOf(s).filter((a) => a.kind === "robotaxi" && a.speed === 0);
    expect(stopped.length).toBeGreaterThanOrEqual(2); // the loop's robotaxis all end up queued at the car
  });
});

describe("level of detail", () => {
  it("agents beyond NEAR_RANGE_M of every player advance only on their stride ticks", () => {
    const world = gridCity();
    // Player at the far west: the east side of the grid is beyond NEAR_RANGE_M.
    let s = createInitialState(world, 7, ["p1"], { x: -100, z: 150, heading: 0 });
    let checked = 0;
    for (let t = 0; t < 200; t++) {
      const prev = s;
      s = step(world, s, NONE);
      if (s.tick % POP_INTERVAL === 0) continue;
      for (const a of agentsOf(prev)) {
        const far = Math.hypot(a.x + 100, a.z - 150) > NEAR_RANGE_M;
        if (!far) continue;
        const after = agentById(s, a.id);
        if (!after) continue;
        if ((s.tick + a.id) % LOD_STRIDE !== 0) {
          expect(after).toBe(a); // untouched, same object
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("helpers", () => {
  it("areaOf matches the area keys the graph uses", () => {
    const world = gridCity();
    for (const ar of world.roads!.areas) expect(areaOf(ar.cx, ar.cz).key).toBe(ar.key);
  });
});
