// A walker sidestepping (held 0.8 m off its line) never pops sideways where its path bends.
// The sideways direction is a smoothed tangent (roads.ts smoothTangent / offsetPoint: a
// connector's own Bezier tangent, a polyline's turning over a short arc around each vertex), and
// a walker advances so its offset point moves no farther than its step (offsetAdvance: the
// outside of a tight bend is the longer way round, so it takes longer). Before, the offset
// followed each sampled segment's direction, and a walker jumped up to ~1.5 m in one tick.
//
// Checked three ways: synthetic paths of every kind (corners both ways, acute corners, U-turns,
// turnarounds, crossings, rejoins, bent sidewalk polylines) walked tick by tick with the same
// rule stepAgent uses; the real stepAgents on every connector kind of the dev world; and the
// same on a deterministic sample of the real SF world's connectors (skipped until that world
// exists in the checkout). Per tick, the move may exceed speed * DT by at most EPS_M.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AGENTS_EXT_KEY,
  AGENT_SPEC,
  DT,
  agentsOf,
  buildWorld,
  connector,
  connectorPath,
  createInitialState,
  endNode,
  makePath,
  offsetAdvance,
  offsetPoint,
  pathPoint,
  sameCorner,
  stepAgents,
  walkPath,
  type AgentState,
  type AgentsExt,
  type Path,
  type RoadsFile,
  type SimState,
  type TileCollider,
  type World,
} from "../../src/sim/index.ts";
import { ROOT, readJson } from "../helpers.ts";
import { SF_RUN_MS, loadDevWorldWithRoads } from "./fixtures.ts";

/** A sidestep's offset (agents.ts: 0.8 m right or left of the walking line). */
const LAT = 0.8;
/** Allowed per-tick movement beyond speed * DT, metres. */
const EPS_M = 0.05;
const V = AGENT_SPEC.person.vmax;

type Kind = "corner" | "cross" | "uturn";

/** Walk a chain of paths at speed v, offset lat, the way stepAgent advances (offsetAdvance) and poses (offsetPoint) a walker; worst per-tick excess over v * DT. */
function walkChain(paths: readonly Path[], lat: number, v = V): number {
  let worst = 0;
  let prev: { x: number; z: number } | null = null;
  let i = 0;
  let s = 0;
  for (let tick = 0; tick < 100_000 && i < paths.length; tick++) {
    s = offsetAdvance(paths[i]!, s, lat, v * DT);
    while (i < paths.length && s >= paths[i]!.len) {
      const rest = s - paths[i]!.len;
      i++;
      if (i < paths.length) s = offsetAdvance(paths[i]!, 0, lat, rest);
    }
    if (i >= paths.length) break;
    const q = offsetPoint(paths[i]!, s, lat);
    if (prev) worst = Math.max(worst, Math.hypot(q.x - prev.x, q.z - prev.z) - v * DT);
    prev = q;
  }
  return worst;
}

/** A straight polyline from (x, z) heading (tx, tz) for len metres. */
function line(x: number, z: number, tx: number, tz: number, len: number): Path {
  return makePath([x, x + tx * len], [z, z + tz * len]);
}

/** The connector agents.ts builds from one walk path's end to the next one's start (makeConnector, walkers). */
function walkConnector(from: Path, to: Path): number[] {
  const p = pathPoint(from, from.len);
  const q = pathPoint(to, 0);
  return connector(p.x, p.z, p.tx, p.tz, q.x, q.z, q.tx, q.tz, 0.9);
}

describe("a sidestepping walker never pops sideways at a bend (synthetic paths)", () => {
  const cases: Array<{ name: string; paths: Path[] }> = [];
  // Corners: arriving northbound at the origin, leaving at every turn angle, both ways, tight and wide.
  for (const r of [0.3, 0.6, 1.5, 4]) {
    for (const deg of [30, 60, 90, 120, 150]) {
      for (const sgn of [1, -1]) {
        const a = (sgn * deg * Math.PI) / 180;
        const tx = Math.sin(a);
        const tz = -Math.cos(a);
        const from = line(0, 10, 0, -1, 10 - r);
        const sx = tx * r;
        const sz = tz * r;
        const to = line(sx, sz, tx, tz, 10);
        const cp = walkConnector(from, to);
        cases.push({ name: `corner ${sgn > 0 ? "right" : "left"} ${deg} deg r${r}`, paths: [from, connectorPath(cp), to] });
      }
    }
  }
  // U-turns at a dead end (agents.ts: next = the same edge back, same side): onto the return line beside it.
  for (const gap of [0.4, 1.0, 2.0]) {
    for (const sgn of [1, -1]) {
      const from = line(0, 10, 0, -1, 10);
      const to = line(sgn * gap, 0, 0, 1, 10);
      cases.push({ name: `U-turn ${sgn > 0 ? "right" : "left"} gap ${gap}`, paths: [from, connectorPath(walkConnector(from, to)), to] });
    }
  }
  // turnAround: the start tangent already points back, to a point 1 m on along the return line.
  for (const gap of [0.5, 1.0]) {
    const to = line(-gap, -1, 0, 1, 10);
    const cp = connector(0, 0, 0, 1, -gap, -1, 0, 1, 0.56);
    cases.push({ name: `turnaround gap ${gap}`, paths: [connectorPath(cp), to] });
  }
  // Crossings: straight over a street onto a line offset sideways, and a rejoin at 45 degrees.
  for (const off of [0, 1.5, 4]) {
    const from = line(0, 20, 0, -1, 10);
    const to = line(off, -2, 0, -1, 10);
    cases.push({ name: `crossing offset ${off}`, paths: [from, connectorPath(walkConnector(from, to)), to] });
  }
  {
    const to = line(0, -1.5, 0, -1, 10);
    cases.push({ name: "rejoin", paths: [connectorPath(connector(1.5, 0, -0.7071, -0.7071, 0, -1.5, 0, -1, 0.9)), to] });
  }
  // Bent sidewalk polylines: sharp and gentle vertices, short and long segments.
  cases.push({ name: "polyline 90 deg", paths: [makePath([0, 0, 10], [10, 0, 0])] });
  cases.push({ name: "polyline 150 deg, short legs", paths: [makePath([0, 0, 0.6, 0.6], [3, 0, 1.0, 4])] });
  cases.push({ name: "polyline zigzag", paths: [makePath([0, 0.3, 0, 0.3, 0, 0.3], [0, -0.5, -1, -1.5, -2, -2.5])] });
  cases.push({ name: "polyline gentle", paths: [makePath([0, 1, 3, 6, 10, 15], [0, -10, -20, -29, -37, -44])] });

  it("every synthetic corner, U-turn, turnaround, crossing, rejoin and polyline, both sides", () => {
    const bad: string[] = [];
    let worst = 0;
    for (const c of cases) {
      for (const lat of [LAT, -LAT]) {
        const w = walkChain(c.paths, lat);
        worst = Math.max(worst, w);
        if (w > EPS_M) bad.push(`${c.name} lat ${lat}: ${w.toFixed(3)} m over speed * DT`);
      }
    }
    expect(bad, `worst ${worst.toFixed(3)}`).toEqual([]);
  });

  it("offsetPoint is the path itself at lat 0 and lies lat away, square to the path, away from bends", () => {
    const p = makePath([0, 0, 10], [10, 0, 0]);
    for (const s of [0, 3, 9.9, 10, 12, 20]) {
      const q = pathPoint(p, s);
      const o = offsetPoint(p, s, 0);
      expect(o.x).toBe(q.x);
      expect(o.z).toBe(q.z);
    }
    // Mid-segment, far from the vertex: exactly 0.8 m to the right of travel.
    const a = offsetPoint(p, 4, LAT);
    expect(a.x).toBeCloseTo(LAT, 9);
    expect(a.z).toBeCloseTo(6, 9);
    const b = offsetPoint(p, 16, LAT);
    expect(b.x).toBeCloseTo(6, 9);
    expect(b.z).toBeCloseTo(LAT, 9);
  });
});

/** Every walker connector of a road graph (end of one sidewalk to the start of the next), with its kind; `keep` samples nodes. */
function walkerConnectors(world: World, keep: (nodeIndex: number) => boolean): Array<{ kind: Kind; cp: number[]; edge: string; dir: 1 | -1; side: number; node: string }> {
  const g = world.roads!;
  const out: Array<{ kind: Kind; cp: number[]; edge: string; dir: 1 | -1; side: number; node: string }> = [];
  const di = (d: number) => (d === 1 ? 0 : 1);
  for (const e of g.edges) {
    if (!e.walkable) continue;
    for (const dir of [1, -1] as const) {
      for (const side of [1, -1]) {
        if (!e.walkClear[di(dir)][di(side)]) continue;
        const ni = endNode(e, dir);
        if (!keep(ni)) continue;
        const node = g.nodes[ni]!;
        const from = walkPath(e, dir, side);
        for (const o of node.out) {
          const f = g.edges[o.edge]!;
          if (!f.walkable) continue;
          for (const fs of [1, -1]) {
            if (!f.walkClear[di(o.dir)][di(fs)]) continue;
            const uturn = f.index === e.index;
            if (uturn && (o.dir === dir || fs !== side)) continue;
            const to = walkPath(f, o.dir, fs);
            const cp = walkConnector(from, to);
            const kind: Kind = uturn ? "uturn" : sameCorner(node, cp[0]!, cp[1]!, cp[6]!, cp[7]!) ? "corner" : "cross";
            out.push({ kind, cp, edge: f.id, dir: o.dir, side: fs, node: node.id });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Put one person on connector `cp` (leading onto edge/dir/side) held `lat` off its line, with the
 * player 40 m away (so it steps every tick), and step the real stepAgents until it is 1 m onto the
 * next sidewalk. Worst per-tick move beyond its speed * DT.
 */
function stepOnConnector(world: World, base: SimState, template: AgentState, c: { cp: number[]; edge: string; dir: 1 | -1; side: number; node: string }, lat: number): number {
  const p1 = base.players.p1!;
  const start = pathPoint(connectorPath(c.cp), 0);
  const agent: AgentState = {
    ...template,
    id: 1,
    kind: "person",
    vmax: V,
    speed: V,
    edge: c.edge,
    dir: c.dir,
    lane: c.side,
    s: 0,
    next: "",
    ndir: c.dir,
    nlane: c.side,
    conn: c.cp,
    node: c.node,
    resume: 0,
    lat,
    wait: 0,
    dwell: 0,
    ghost: 0,
    mode: "go",
    dodge: null,
    x: start.x,
    z: start.z,
  };
  let s: SimState = {
    ...base,
    players: { p1: { ...p1, mode: "vehicle", car: { ...p1.car, x: start.x + 40, z: start.z, speed: 0 } } },
    ext: { ...base.ext, [AGENTS_EXT_KEY]: { nextId: 2, list: [agent] } satisfies AgentsExt },
  };
  let worst = 0;
  let prev: AgentState | null = null;
  for (let t = 0; t < 600; t++) {
    const r = stepAgents(world, s, s.tick);
    const a = r?.ext.list[0];
    if (!a) break;
    if (prev) {
      const d = Math.hypot(a.x - prev.x, a.z - prev.z) - Math.max(a.speed, prev.speed) * DT;
      worst = Math.max(worst, d);
    }
    prev = a;
    if (a.conn === null && a.s > 1) break;
    // Hold the sidestep while on this connector (stepAgent relaxes it toward 0 when nobody is in
    // the way); after it (onto the sidewalk, a U-turn, or a turnaround, which restarts at lat 0
    // where the walker stands) it relaxes as it would.
    const onIt = a.conn !== null && a.conn.every((v, k) => v === c.cp[k]);
    s = { ...s, tick: s.tick + 1, ext: { ...s.ext, [AGENTS_EXT_KEY]: { nextId: 2, list: [onIt ? { ...a, lat } : a] } } };
  }
  return worst;
}

function checkConnectors(world: World, base: SimState, list: ReturnType<typeof walkerConnectors>): { bad: string[]; counts: Record<Kind, number>; worst: number } {
  const template = agentsOf(base).find((a) => a.kind === "person") ?? agentsOf(base)[0]!;
  const bad: string[] = [];
  const counts: Record<Kind, number> = { corner: 0, cross: 0, uturn: 0 };
  let worst = 0;
  for (const c of list) {
    counts[c.kind]++;
    for (const lat of [LAT, -LAT]) {
      const w = stepOnConnector(world, base, template, c, lat);
      worst = Math.max(worst, w);
      if (w > EPS_M && bad.length < 20) bad.push(`${c.kind} onto ${c.edge} dir ${c.dir} side ${c.side} at ${c.node}, lat ${lat}: ${w.toFixed(3)} m over speed * DT`);
    }
  }
  return { bad, counts, worst };
}

describe("a sidestepping walker never pops sideways at a bend (stepAgents, dev world)", () => {
  it("every corner, crossing and U-turn connector of the dev world, both sides", () => {
    const { world, spawn } = loadDevWorldWithRoads();
    const base = createInitialState(world, 1, ["p1"], spawn);
    const all = walkerConnectors(world, () => true);
    const { bad, counts, worst } = checkConnectors(world, base, all);
    expect(counts.corner).toBeGreaterThan(0);
    expect(counts.cross).toBeGreaterThan(0);
    expect(counts.uturn).toBeGreaterThan(0);
    expect(bad, `worst ${worst.toFixed(3)}`).toEqual([]);
  }, 120_000);
});

const SF = "public/tiles/sf";
const sfPresent = existsSync(join(ROOT, SF, "manifest.json"));

describe.skipIf(!sfPresent)("a sidestepping walker never pops sideways at a bend (stepAgents, real SF sample)", () => {
  let world: World;
  let base: SimState;
  beforeAll(() => {
    const manifest = readJson<{ spawn: { x: number; z: number; heading: number }; roads?: string | null; tiles: Array<{ collider: string }> }>(`${SF}/manifest.json`);
    const tiles = manifest.tiles.map((t) => readJson<TileCollider>(`${SF}/${t.collider}`));
    const roads = manifest.roads ? readJson<RoadsFile>(`${SF}/${manifest.roads}`) : null;
    world = buildWorld(tiles, roads);
    base = createInitialState(world, 1, ["p1"], manifest.spawn);
  }, SF_RUN_MS);

  it("a deterministic sample of the city's corner, crossing and U-turn connectors, both sides", () => {
    // Every 7th node's connectors, then about 250 of each kind, evenly spread.
    const all = walkerConnectors(world, (i) => i % 7 === 0);
    const sample: typeof all = [];
    for (const kind of ["corner", "cross", "uturn"] as const) {
      const of = all.filter((c) => c.kind === kind);
      const stride = Math.max(1, Math.ceil(of.length / 250));
      for (let i = 0; i < of.length; i += stride) sample.push(of[i]!);
    }
    const { bad, counts, worst } = checkConnectors(world, base, sample);
    expect(counts.corner).toBeGreaterThan(20);
    expect(counts.cross).toBeGreaterThan(20);
    expect(counts.uturn).toBeGreaterThan(0);
    expect(bad, `worst ${worst.toFixed(3)}`).toEqual([]);
  }, SF_RUN_MS);
});
