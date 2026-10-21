// Ambient agents: robotaxis on lanes; errand robots, sidewalk bots and people on sidewalks.
// Deterministic, pure, plain JSON in state.ext.agents (AGENTS_EXT_KEY). The road graph they
// follow is static (world.roads, src/sim/roads.ts).
//
// Movement
//  - Every agent follows a path: a lane (robotaxi) or sidewalk (walkers) of one edge, or a
//    connector (cubic Bezier) that carries it across a node onto the next edge. The next edge
//    is chosen with the agent's own seeded PRNG (agent.rng) when it enters an edge.
//  - Robotaxis look ahead along their route (current path, the next connector, the next lane)
//    and slow for anything near it: players (car or on foot), people, robots and other
//    robotaxis, keeping a bumper gap of ROBOTAXI_GAP_M. Two robotaxis blocking each other:
//    the one holding a junction goes first, otherwise the lower id.
//  - Junctions (nodes with 3+ streets) work like an all-way stop. A robotaxi waits with its
//    front bumper STOPLINE_M behind the line (further back if its body would sit in a
//    holder's path) until it claims the junction: longest wait first, then lowest id, and
//    only if its path through (turn plus HOLD_EXIT_M of exit lane) keeps JUNCTION_CLEAR_M
//    from every holder's path and from the noses of robotaxis waiting at the other lines.
//    Several robotaxis hold a junction at once when their paths do not conflict. Nobody
//    claims a junction toward an exit lane whose first EXIT_CLEAR_M are occupied (no blocking
//    the box). The claim is kept (agent.node) until the tail is out of the junction.
//  - Walkers keep right on the sidewalk, cross streets at intersections, sidestep oncoming
//    walkers, wait for players, and turn around after WALKER_TURN_TICKS blocked. People have
//    right of way: robotaxis always yield to walkers, and a walker waits for a robotaxi only
//    when that robotaxi is not already waiting for the walker (so they never walk into one).
//  - Nothing moves into a building: a step that would put an agent's body in a footprint is
//    refused (the agent waits; a walker turns around; a robotaxi stuck that way for
//    ROBOTAXI_STUCK_TICKS goes out of service and is removed).
//  - Last resort: an agent stuck for STUCK_REMOVE_TICKS while farther than SPAWN_MIN_PLAYER_M
//    from every player is removed (the population refills elsewhere); in view it waits on.
//  - Deadlock breaker: a robotaxi blocked for GHOST_AFTER_TICKS by other robotaxis or by a
//    junction it cannot claim ignores other robotaxis (and junction claims) for GHOST_TICKS.
//    It never ignores people, robots on the sidewalk or players; a robotaxi waiting on a
//    player for more than 2 s switches to mode "honk".
//
// Population (seeded spawn budget per area)
//  - The world is split into AREA_M (250 m) square areas (roads.ts). An area's budget for a
//    kind is min(cap, floor(roadKm * perKm + u)), u in [0,1) hashed from (seed, area, kind).
//  - Agents exist only near players. Every POP_INTERVAL ticks: agents farther than
//    DESPAWN_RANGE_M from every player are removed; each area whose centre is within
//    ACTIVE_RANGE_M of a player and below budget gains up to SPAWN_PER_POP agents of each kind,
//    placed with state.rng on its roads at least SPAWN_MIN_PLAYER_M from every player (no
//    pop-in in view). The initial state fills every active area to budget. Nearer areas fill
//    first. Each area belongs to its nearest player (ties: the lower player id), and so does
//    each agent: one player's surroundings hold at most MAX_AGENTS agents, the whole state
//    MAX_AGENTS_TOTAL, so a second player across town gets their own traffic instead of
//    whatever the first player's areas left over. The whole city's road graph is loaded, but
//    only the areas around players are ever populated or stepped.
//
// Level of detail (documented rule)
//  - An agent within NEAR_RANGE_M of a player steps every tick. Farther agents step only on
//    ticks where (tick + id) % LOD_STRIDE === 0, by LOD_STRIDE * DT, so each far agent costs a
//    quarter as much and the work is spread evenly across ticks. With no players at all,
//    every agent is frozen (no movement, spawn or despawn).
//  - All decisions read the previous state only (players and agents as of the last tick),
//    so the order agents are processed in cannot change the result; agents are still
//    processed in ascending id order.
//
// The dodge (v4, src/sim/dodge.ts): an agent with a DodgeState is diving out of a vehicle's
// way or getting up after it. stepAgents leaves it exactly as it is (dodge.ts moves it), and
// when it has recovered it walks on from where it landed (rejoinAt: a connector back onto its
// sidewalk a little ahead), never jumping back to its line.

import { DT, sortedIds, type DodgeState, type RngState, type SimState } from "./contract.ts";
import { clamp, datan, datan2, dcos, dsin } from "./dmath.ts";
import { hash32, nextFloat, nextFloatWord, nextU32 } from "./rng.ts";
import {
  AREA_M,
  areaOf,
  connector,
  connectorPath,
  dirIndex,
  projectOnPath,
  endNode,
  lanePath,
  makePath,
  pathPoint,
  sameCorner,
  sideIndex,
  startNode,
  subPath,
  walkPath,
  type AreaRoads,
  type Dir,
  type Path,
  type RoadEdgeInfo,
  type RoadGraph,
} from "./roads.ts";
import { CAR } from "./car.ts";
import { FOOT } from "./foot.ts";
import { cellKey, circleBlocked, meshGroundHeight, type World } from "./world.ts";

export type AgentKind = "robotaxi" | "errandRobot" | "sidewalkBot" | "person";
export const AGENT_KINDS: readonly AgentKind[] = ["robotaxi", "errandRobot", "sidewalkBot", "person"];

/**
 * What the agent is doing, for renderers (brake lights, hazards, a horn, a dive) and tests.
 * v4: "dive" (leaping out of a vehicle's way) and "recover" (getting up after it), with the
 * details in AgentState.dodge.
 */
export type AgentMode = "go" | "yield" | "wait" | "honk" | "dwell" | "dive" | "recover";

export interface AgentSpec {
  /** Drives on lanes (true) or walks on sidewalks (false). */
  road: boolean;
  /** Body half length (along heading) and half width, metres. */
  halfLength: number;
  halfWidth: number;
  /** Radius of each obstacle circle other bodies collide with. */
  radius: number;
  /** Cruise speed range, m/s (each agent draws its own). */
  vmin: number;
  vmax: number;
  accel: number;
  decel: number;
  /** Spawn density per km of usable road in an area, and the per-area cap. */
  perKm: number;
  cap: number;
  /** Chance per second of pausing (walkers), and the pause length range in seconds. */
  dwellPerS: number;
  dwellMinS: number;
  dwellMaxS: number;
}

export const AGENT_SPEC: Readonly<Record<AgentKind, AgentSpec>> = {
  robotaxi: {
    road: true,
    halfLength: 2.3,
    halfWidth: 1.0,
    radius: 1.05,
    vmin: 10,
    vmax: 13,
    accel: 2.5,
    decel: 7,
    perKm: 12,
    cap: 16,
    dwellPerS: 0,
    dwellMinS: 0,
    dwellMaxS: 0,
  },
  errandRobot: {
    road: false,
    halfLength: 0.5,
    halfWidth: 0.4,
    radius: 0.45,
    vmin: 1.6,
    vmax: 1.9,
    accel: 1.5,
    decel: 4,
    perKm: 5,
    cap: 6,
    dwellPerS: 1 / 40,
    dwellMinS: 3,
    dwellMaxS: 8,
  },
  sidewalkBot: {
    road: false,
    halfLength: 0.35,
    halfWidth: 0.3,
    radius: 0.35,
    vmin: 0.9,
    vmax: 1.1,
    accel: 1.2,
    decel: 4,
    perKm: 4,
    cap: 5,
    dwellPerS: 1 / 90,
    dwellMinS: 1,
    dwellMaxS: 3,
  },
  person: {
    road: false,
    halfLength: 0.25,
    halfWidth: 0.3,
    radius: 0.3,
    vmin: 1.15,
    vmax: 1.5,
    accel: 1.5,
    decel: 5,
    perKm: 20,
    cap: 24,
    dwellPerS: 1 / 60,
    dwellMinS: 1,
    dwellMaxS: 4,
  },
};

/**
 * A robotaxi's body as people meet it: a box covering the drawn Meander (4.98 x 1.92 m), a little
 * longer than the AGENT_SPEC box traffic spaces itself by. Walkers keep clear of it, robotaxis
 * keep their berth from people by it, and the dodge (src/sim/dodge.ts) counts contacts and
 * clearance against it.
 */
export const ROBOTAXI_BODY = { halfLength: 2.5, halfWidth: 1.0 } as const;

/** About this share of the people (by id) are children: smaller, and given a wider berth by the dodge (src/sim/dodge.ts). */
export const CHILD_PERCENT = 5;

/** Is person agent `id` a child? Fixed by the id (no state, no RNG draw), so every client agrees. */
export function personIsChild(id: number): boolean {
  return hash32(id, 0x0c41d) % 100 < CHILD_PERCENT;
}

export interface AgentState {
  id: number;
  kind: AgentKind;
  x: number;
  y: number;
  z: number;
  /** Compass bearing, radians clockwise from north (-z). */
  heading: number;
  /** Body pitch on hills, radians, + = nose up (robotaxis; 0 for walkers). */
  pitch: number;
  speed: number;
  /** This agent's cruise speed. */
  vmax: number;
  /** Edge the agent is on, or entering when on a connector. */
  edge: string;
  dir: Dir;
  /** Robotaxi: lane index. Walkers: sidewalk side, +1 = right of a -> b, -1 = left. */
  lane: number;
  /** Metres along the current path: the connector when conn !== null, else the lane/sidewalk. */
  s: number;
  /** Planned edge after this one ("" = none: dead end), its direction, and lane (robotaxi) or side (walkers). */
  next: string;
  ndir: Dir;
  nlane: number;
  /** Active connector [x0,z0,x1,z1,x2,z2,x3,z3] leading onto (edge, dir, lane), or null. */
  conn: number[] | null;
  /**
   * Robotaxi: the all-way-stop node it holds (claimed at the line, kept while crossing and
   * until its tail clears the junction), else "". Walkers: the node their connector crosses.
   */
  node: string;
  /** Where the connector joins (edge, dir, lane): metres along that path (0 except after a turnaround). */
  resume: number;
  /** Walkers: sidestep offset, metres right of the walking direction. Robotaxis: 0. */
  lat: number;
  /** Ticks spent stopped by an obstacle or a refused move. */
  wait: number;
  /** Ticks left in a pause (an errand robot delivering, a person checking their phone). */
  dwell: number;
  /** Ticks left ignoring other agents (robotaxi deadlock breaker). */
  ghost: number;
  mode: AgentMode;
  /** Per-agent PRNG state (rng.ts nextU32Word). */
  rng: number;
  /** v4: diving out of a vehicle's way, or getting up after it (src/sim/dodge.ts), else null. */
  dodge: DodgeState | null;
}

/** state.ext.agents */
export interface AgentsExt {
  nextId: number;
  /** Ascending id order. */
  list: AgentState[];
}

export const AGENTS_EXT_KEY = "agents";

export const POP_INTERVAL = 30;
export const ACTIVE_RANGE_M = 350;
export const DESPAWN_RANGE_M = 750;
export const NEAR_RANGE_M = 200;
export const LOD_STRIDE = 4;
export const SPAWN_MIN_PLAYER_M = 60;
export const SPAWN_PER_POP = 2;
/** The most ambient agents around one player (the areas nearest to that player). */
export const MAX_AGENTS = 512;
/** The most ambient agents in a state, however many players. */
export const MAX_AGENTS_TOTAL = 1024;
export const ROBOTAXI_GAP_M = 1.5;
/** A robotaxi waiting at an all-way stop keeps its front bumper this far behind the line. */
export const STOPLINE_M = 0.5;
/** A lane whose first metres hold a robotaxi is full: nobody enters the junction toward it. */
export const EXIT_CLEAR_M = 7;
export const WALKER_GAP_M = 0.3;
export const GHOST_AFTER_TICKS = 20 * 60;
export const GHOST_TICKS = 2 * 60;
export const WALKER_TURN_TICKS = 4 * 60;
export const ROBOTAXI_STUCK_TICKS = 5 * 60;
/** An agent stuck this long while out of every player's view (SPAWN_MIN_PLAYER_M) is removed. */
export const STUCK_REMOVE_TICKS = 30 * 60;

const AREA_HALF_DIAG = AREA_M * 0.7072;
const HASH_CELL = 16;

// ---------------------------------------------------------------- read helpers

/** The agents in ascending id order (empty when the world has no roads). */
export function agentsOf(state: Readonly<SimState>): readonly AgentState[] {
  const ext = state.ext[AGENTS_EXT_KEY] as AgentsExt | undefined;
  return ext ? ext.list : [];
}

export function agentById(state: Readonly<SimState>, id: number): AgentState | undefined {
  const list = agentsOf(state);
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = list[mid]!;
    if (m.id === id) return m;
    if (m.id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** Number of agents, optionally of one kind. */
export function agentCount(state: Readonly<SimState>, kind?: AgentKind): number {
  const list = agentsOf(state);
  if (!kind) return list.length;
  let n = 0;
  for (const a of list) if (a.kind === kind) n++;
  return n;
}

/** The path an agent is currently on: its connector, else its lane or sidewalk. */
export function agentPath(world: World, a: Readonly<AgentState>): Path | null {
  const g = world.roads;
  if (!g) return null;
  if (a.conn) return connectorPath(a.conn);
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return null;
  return basePath(g.edges[ei]!, a);
}

/** A walker back from a dodge rejoins its sidewalk at least this far ahead of where it landed, metres. */
export const REJOIN_AHEAD_M = 1.5;

/**
 * Where a walker done with a dodge (dodge.ts), standing at (x, z), carries on from, and which
 * way it then faces. Standing on its current path (sidewalk or connector): its s there. Anywhere
 * else (beside its path, or past either end of it, where no s and lat reach and walking on from
 * the nearest end would make it jump): a connector from where it stands back onto its sidewalk,
 * ahead of it by REJOIN_AHEAD_M or by how far off it is (whichever is more, so it rejoins at 45
 * degrees or less), so it walks back on its own line, never off to the side of it. Null without
 * a road graph or a known edge.
 */
export function rejoinAt(world: World, a: Readonly<AgentState>, x: number, z: number): Pick<AgentState, "s" | "lat" | "conn" | "resume" | "heading"> | null {
  const g = world.roads;
  const path = agentPath(world, a);
  const ei = g ? g.edgeIndex.get(a.edge) : undefined;
  if (!g || !path || ei === undefined) return null;
  const p = projectOnPath(path, x, z);
  if (p.dist <= 0.01) {
    const q = pathPoint(path, p.s);
    return { s: p.s, lat: 0, conn: a.conn, resume: a.resume, heading: datan2(q.tx, -q.tz) };
  }
  const lane = basePath(g.edges[ei]!, a);
  const pl = projectOnPath(lane, x, z);
  const s1 = clamp(pl.s + Math.max(REJOIN_AHEAD_M, pl.dist), 0, lane.len);
  const t = pathPoint(lane, s1);
  const dx = t.x - x;
  const dz = t.z - z;
  const l = Math.sqrt(dx * dx + dz * dz);
  const ux = l > 1e-6 ? dx / l : t.tx;
  const uz = l > 1e-6 ? dz / l : t.tz;
  return { s: 0, lat: 0, conn: connector(x, z, ux, uz, t.x, t.z, t.tx, t.tz, 0.9), resume: s1, heading: datan2(ux, -uz) };
}

/** The obstacle circles of one agent (robotaxis are two circles, walkers one). */
export function agentCircles(a: Readonly<AgentState>): Array<{ x: number; z: number; r: number }> {
  const spec = AGENT_SPEC[a.kind];
  if (!spec.road) return [{ x: a.x, z: a.z, r: spec.radius }];
  const o = spec.halfLength - spec.radius;
  const hx = dsin(a.heading);
  const hz = -dcos(a.heading);
  return [
    { x: a.x - hx * o, z: a.z - hz * o, r: spec.radius },
    { x: a.x + hx * o, z: a.z + hz * o, r: spec.radius },
  ];
}

// ---------------------------------------------------------------- internals

function basePath(e: RoadEdgeInfo, a: Readonly<Pick<AgentState, "kind" | "dir" | "lane">>): Path {
  return AGENT_SPEC[a.kind].road ? lanePath(e, a.dir, a.lane) : walkPath(e, a.dir, a.lane);
}

interface Obs {
  x: number;
  z: number;
  /** Circle radius; for a box, its bounding radius. */
  r: number;
  /** Oriented box (a player's car): unit forward and half extents. Absent for circles. */
  box?: { fx: number; fz: number; hl: number; hw: number };
  /** Agent id, or -1 for a player body. */
  id: number;
  player: boolean;
  /** A robotaxi. */
  road: boolean;
  /**
   * Where a moving agent will be shortly. Robotaxis look at walkers' (to stop before someone
   * crosses); walkers look at robotaxis' (to wait at the kerb for a gap). Never their own kind's.
   */
  predicted?: boolean;
  /** Someone on foot (a walker or a player's walker): robotaxis give them PERSON_BERTH_M more room. */
  foot?: boolean;
  /** A child (personIsChild): a robotaxi keeps its child's berths from them (ROBOTAXI_SLOW_BERTH_CHILD_M). */
  child?: boolean;
  /**
   * Seen only by robotaxis ("road") or only by walkers ("foot"): a robotaxi is two circles to
   * other robotaxis (how traffic spaces itself) and its drawn body, a box, to walkers.
   */
  onlyFor?: "road" | "foot";
}

interface Body {
  x: number;
  z: number;
}

function buildHash(obs: readonly Obs[]): Map<number, Obs[]> {
  const m = new Map<number, Obs[]>();
  for (const o of obs) {
    const k = cellKey(Math.floor(o.x / HASH_CELL), Math.floor(o.z / HASH_CELL));
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    l.push(o);
  }
  return m;
}

function queryHash(m: Map<number, Obs[]>, x: number, z: number, r: number, out: Obs[]): void {
  out.length = 0;
  const x0 = Math.floor((x - r) / HASH_CELL);
  const x1 = Math.floor((x + r) / HASH_CELL);
  const z0 = Math.floor((z - r) / HASH_CELL);
  const z1 = Math.floor((z + r) / HASH_CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const l = m.get(cellKey(cx, cz));
      if (l) for (const o of l) out.push(o);
    }
  }
}

function minDist2(bodies: readonly Body[], x: number, z: number): number {
  let best = Infinity;
  for (const b of bodies) {
    const d2 = (b.x - x) * (b.x - x) + (b.z - z) * (b.z - z);
    if (d2 < best) best = d2;
  }
  return best;
}

/** Index of the nearest body (the first on a tie: bodies come in player id order). */
function nearestBody(bodies: readonly Body[], x: number, z: number): number {
  let best = Infinity;
  let at = 0;
  bodies.forEach((b, i) => {
    const d2 = (b.x - x) * (b.x - x) + (b.z - z) * (b.z - z);
    if (d2 < best) {
      best = d2;
      at = i;
    }
  });
  return at;
}

/** Positions of every player's active body (the car while driving, the walker on foot). */
export function playerBodies(state: Readonly<SimState>): Body[] {
  const out: Body[] = [];
  for (const id of sortedIds(state.players)) {
    const p = state.players[id]!;
    if (p.mode === "foot" && p.foot) out.push({ x: p.foot.x, z: p.foot.z });
    else out.push({ x: p.car.x, z: p.car.z });
  }
  return out;
}

function playerObstacles(state: Readonly<SimState>): Obs[] {
  const out: Obs[] = [];
  for (const id of sortedIds(state.players)) {
    const p = state.players[id]!;
    const c = p.car;
    out.push({
      x: c.x,
      z: c.z,
      r: Math.sqrt(CAR.halfLength * CAR.halfLength + CAR.halfWidth * CAR.halfWidth),
      id: -1,
      player: true,
      road: false,
      box: { fx: dsin(c.heading), fz: -dcos(c.heading), hl: CAR.halfLength, hw: CAR.halfWidth },
    });
    if (p.mode === "foot" && p.foot) out.push({ x: p.foot.x, z: p.foot.z, r: FOOT.radius, id: -1, player: true, road: false, foot: true });
  }
  return out;
}

/**
 * Robotaxis yield to anyone on foot (people, robots, a player's walker) whose body comes within
 * their probe plus this much more: their body keeps the dodge's margin (dodge.ts, 0.75 m) and a
 * little slack from a walker's, so nobody needs to dive out of a robotaxi's way in normal
 * traffic (the dodge is still there, on top, for when it does).
 */
export const PERSON_BERTH_M = 0.6;

/**
 * A robotaxi's berth from anyone on foot, by its drawn body (ROBOTAXI_BODY), metres. While
 * anyone is within ROBOTAXI_SLOW_BERTH_M (a child ROBOTAXI_SLOW_BERTH_CHILD_M: the dodge's
 * margins, dodge.ts) of it, now or anywhere along its route until it could stop as the dodge
 * predicts, it goes no faster than ROBOTAXI_CREEP_MPS (below the speed at which the dodge sees a
 * vehicle as a threat), so nobody ever has to dive out of the way of a robotaxi driving as it
 * should. And it does not set off while anyone is within ROBOTAXI_STOP_BERTH_M (a child
 * ROBOTAXI_STOP_BERTH_CHILD_M: the override's clearance, 0.3 m and 0.6 m, plus what a creep step
 * reaches, and BERTH_SLACK_M more) of it, nor
 * move on if this step would bring its body within that of anyone, closer than they are now:
 * edging past or swinging round a hairpin it never sets the override off. It waits, or creeps
 * past people waiting beside it.
 */
export const ROBOTAXI_SLOW_BERTH_M = 0.75;
export const ROBOTAXI_SLOW_BERTH_CHILD_M = 1.25;
export const ROBOTAXI_STOP_BERTH_M = 0.33;
export const ROBOTAXI_STOP_BERTH_CHILD_M = 0.63;
export const ROBOTAXI_CREEP_MPS = 1.5;
/** A robotaxi slower than this is standing (the dodge counts it as stopped below 0.3 m/s). */
const ROBOTAXI_STOPPED_MPS = 0.05;
/** Walkers keep this much further from a moving robotaxi's drawn body than from a stopped one's, metres. */
export const WALKER_TAXI_BERTH_M = 0.4;
/** A robotaxi slower than this is stopped for the walkers' berth, m/s. */
const TAXI_STOPPED_MPS = 0.05;
/** The largest radius of any obstacle (a robotaxi's box with the walkers' berth): the probe's hash query covers it. */
const OBS_RADIUS_MAX =
  Math.sqrt(
    (ROBOTAXI_BODY.halfLength + WALKER_TAXI_BERTH_M) * (ROBOTAXI_BODY.halfLength + WALKER_TAXI_BERTH_M) +
      (ROBOTAXI_BODY.halfWidth + WALKER_TAXI_BERTH_M) * (ROBOTAXI_BODY.halfWidth + WALKER_TAXI_BERTH_M),
  ) + 0.1;

/** The berth's poses along the route are this far apart (STOP_STEP_M over the step itself), metres, and it keeps this much more, metres. */
const BERTH_STEP_M = 0.1;
const STOP_STEP_M = 0.02;
const BERTH_SLACK_M = 0.05;
/** How hard the dodge counts on a robotaxi braking, m/s^2, and after how long (dodge.ts ROBOTAXI_BRAKE_MPS2, ROBOTAXI_REACT_S). */
const DODGE_TAXI_BRAKE = 6;
const DODGE_TAXI_REACT_S = 2 * DT;

/**
 * The speed limit a robotaxi's berth sets (ROBOTAXI_SLOW_BERTH_M and ROBOTAXI_STOP_BERTH_M), from
 * everyone on foot as of the previous tick: Infinity (no one near), ROBOTAXI_CREEP_MPS (someone
 * within the slow berth of its body now or at any pose along its route until it could stop as
 * the dodge predicts it, braking at 6 m/s^2 after two ticks from the speed it may have after
 * this step of `dt` seconds), or 0 (this step, and the two ticks after it, would bring its body
 * within the stop berth of someone, closer than now). The body is swept along the route, so a
 * rear swinging in on a hairpin counts.
 */
function berthLimit(c: Ctx, a: Readonly<AgentState>, dt: number): number {
  const spec = AGENT_SPEC[a.kind];
  const v = a.speed + spec.accel * dt;
  const ahead = Math.min(14, v * (dt + DODGE_TAXI_REACT_S) + (v * v) / (2 * DODGE_TAXI_BRAKE) + 0.25);
  const step = v * (dt + DODGE_TAXI_REACT_S) + 0.05;
  const reach = ROBOTAXI_BODY.halfLength + ahead + ROBOTAXI_SLOW_BERTH_CHILD_M + 1;
  queryHash(c.hash, a.x, a.z, reach, c.scratch);
  const near: Obs[] = [];
  for (const o of c.scratch) {
    if (!o.foot || o.predicted) continue;
    const dx = o.x - a.x;
    const dz = o.z - a.z;
    if (dx * dx + dz * dz <= (reach + o.r) * (reach + o.r)) near.push(o);
  }
  if (near.length === 0) return Infinity;
  const poses: Array<{ x: number; z: number; hx: number; hz: number; d: number }> = [{ x: a.x, z: a.z, hx: dsin(a.heading), hz: -dcos(a.heading), d: 0 }];
  // Every STOP_STEP_M over this step (and two ticks), exactly where that ends, then every
  // BERTH_STEP_M on to where it could stop.
  const ds: number[] = [];
  for (let d = STOP_STEP_M; d < step - 1e-9; d += STOP_STEP_M) ds.push(d);
  ds.push(step);
  for (let d = step + BERTH_STEP_M; d < ahead + 1e-9; d += BERTH_STEP_M) ds.push(d);
  for (const q of agentRouteAt(c.world, a, ds)) {
    const l = Math.sqrt(q.tx * q.tx + q.tz * q.tz);
    if (l > 1e-9) poses.push({ x: q.x, z: q.z, hx: q.tx / l, hz: q.tz / l, d: q.d });
  }
  const clear = (o: Obs, p: { x: number; z: number; hx: number; hz: number }): number => {
    // From the walker's body to the box (ROBOTAXI_BODY) at this pose.
    const ox = o.x - p.x;
    const oz = o.z - p.z;
    const along = ox * p.hx + oz * p.hz;
    const lat = -ox * p.hz + oz * p.hx;
    const el = Math.max(0, (lat < 0 ? -lat : lat) - ROBOTAXI_BODY.halfWidth);
    const ef = Math.max(0, (along < 0 ? -along : along) - ROBOTAXI_BODY.halfLength);
    return Math.sqrt(el * el + ef * ef) - o.r;
  };
  let limit = Infinity;
  for (const o of near) {
    // (A hair more than each berth: the poses are BERTH_STEP_M apart, the dodge's closer.)
    const slow = (o.child ? ROBOTAXI_SLOW_BERTH_CHILD_M : ROBOTAXI_SLOW_BERTH_M) + BERTH_SLACK_M;
    const stop = (o.child ? ROBOTAXI_STOP_BERTH_CHILD_M : ROBOTAXI_STOP_BERTH_M) + BERTH_SLACK_M;
    const now = clear(o, poses[0]!);
    // Someone within the stop berth already: it does not set off (moving at all, it would be a
    // moving vehicle within the override's clearance of them).
    if (now < stop && a.speed <= ROBOTAXI_STOPPED_MPS) return 0;
    for (const p of poses) {
      const d = clear(o, p);
      if (p.d > 0 && p.d <= step + 1e-9 && d < stop && d < now - 1e-6) return 0;
      if (d < slow) limit = ROBOTAXI_CREEP_MPS;
    }
  }
  return limit;
}

/** Seconds ahead a moving walker's position is projected (seen by robotaxis). */
const WALKER_PREDICT_S: readonly number[] = [0.6, 1.2];
/** Seconds ahead a moving robotaxi's position is projected (seen by walkers at the kerb). */
const ROBOTAXI_PREDICT_S: readonly number[] = [1.0, 2.0];

function agentObstacles(list: readonly AgentState[]): Obs[] {
  const out: Obs[] = [];
  for (const a of list) {
    const spec = AGENT_SPEC[a.kind];
    const road = spec.road;
    if (road) {
      // To robotaxis, its two circles; to walkers, its drawn body (with a berth while it moves).
      for (const c of agentCircles(a)) out.push({ x: c.x, z: c.z, r: c.r, id: a.id, player: false, road, onlyFor: "road" });
      const grow = a.speed > TAXI_STOPPED_MPS ? WALKER_TAXI_BERTH_M : 0;
      const hl = ROBOTAXI_BODY.halfLength + grow;
      const hw = ROBOTAXI_BODY.halfWidth + grow;
      out.push({ x: a.x, z: a.z, r: Math.sqrt(hl * hl + hw * hw), id: a.id, player: false, road, onlyFor: "foot", box: { fx: dsin(a.heading), fz: -dcos(a.heading), hl, hw } });
    } else {
      out.push({ x: a.x, z: a.z, r: spec.radius, id: a.id, player: false, road, foot: true, child: a.kind === "person" && personIsChild(a.id) });
    }
    if (a.speed > (road ? 1 : 0.3)) {
      const hx = dsin(a.heading);
      const hz = -dcos(a.heading);
      for (const t of road ? ROBOTAXI_PREDICT_S : WALKER_PREDICT_S) {
        out.push({ x: a.x + hx * a.speed * t, z: a.z + hz * a.speed * t, r: spec.radius, id: a.id, player: false, road, predicted: true, foot: !road });
      }
    }
  }
  return out;
}

/** Leaving direction of an edge's centreline at its start node for direction dir. */
function startTangent(e: RoadEdgeInfo, dir: Dir): [number, number] {
  const c = e.center;
  const n = c.xs.length;
  const [x0, z0, x1, z1] =
    dir === 1 ? [c.xs[0]!, c.zs[0]!, c.xs[1]!, c.zs[1]!] : [c.xs[n - 1]!, c.zs[n - 1]!, c.xs[n - 2]!, c.zs[n - 2]!];
  const l = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
  return l > 0 ? [(x1 - x0) / l, (z1 - z0) / l] : [0, -1];
}

/** Arriving direction of an edge's centreline at its end node for direction dir. */
function endTangent(e: RoadEdgeInfo, dir: Dir): [number, number] {
  const [x, z] = startTangent(e, dir === 1 ? -1 : 1);
  return [-x, -z];
}

function canDrive(e: RoadEdgeInfo, dir: Dir): boolean {
  return e.drivable && (dir === 1 || !e.oneway) && e.laneClear[dirIndex(dir)].some(Boolean);
}

function canWalk(e: RoadEdgeInfo, dir: Dir): boolean {
  return e.walkable && (e.walkClear[dirIndex(dir)][0] || e.walkClear[dirIndex(dir)][1]);
}

/**
 * Pick what follows (e, dir, lane) with the agent's PRNG: the next edge, its direction and the
 * lane (robotaxi, any clear lane) or sidewalk side (walkers: usually round the same corner,
 * otherwise the nearer side, which means crossing a street). ["", dir, 0] at a dead end with
 * no way on.
 */
function chooseNext(g: RoadGraph, e: RoadEdgeInfo, dir: Dir, lane: number, road: boolean, rng: number): [string, Dir, number, number] {
  const node = g.nodes[endNode(e, dir)]!;
  const [ix, iz] = endTangent(e, dir);
  const options: Array<{ edge: RoadEdgeInfo; dir: Dir; w: number }> = [];
  for (const o of node.out) {
    const ne = g.edges[o.edge]!;
    if (ne.index === e.index && o.dir !== dir) continue; // U-turn: only as a last resort
    if (road ? !canDrive(ne, o.dir) : !canWalk(ne, o.dir)) continue;
    const [ox, oz] = startTangent(ne, o.dir);
    const straight = ix * ox + iz * oz > 0.7;
    options.push({ edge: ne, dir: o.dir, w: road ? (straight ? 3 : 1) : straight ? 2 : 1 });
  }
  let r = rng;
  let pick: { edge: RoadEdgeInfo; dir: Dir } | null = null;
  if (options.length === 0) {
    const back: Dir = dir === 1 ? -1 : 1;
    if (road ? canDrive(e, back) : canWalk(e, back)) pick = { edge: e, dir: back };
  } else {
    let total = 0;
    for (const o of options) total += o.w;
    let u: number;
    [u, r] = nextFloatWord(r);
    let t = u * total;
    pick = options[options.length - 1]!;
    for (const o of options) {
      t -= o.w;
      if (t < 0) {
        pick = o;
        break;
      }
    }
  }
  if (!pick) return ["", dir, 0, r];
  const di = dirIndex(pick.dir);
  if (road) {
    const clear: number[] = [];
    pick.edge.laneClear[di].forEach((ok, k) => {
      if (ok) clear.push(k);
    });
    let u: number;
    [u, r] = nextFloatWord(r);
    return [pick.edge.id, pick.dir, clear[Math.min(clear.length - 1, Math.floor(u * clear.length))] ?? 0, r];
  }
  if (pick.edge.index === e.index) return [pick.edge.id, pick.dir, lane, r]; // turning back: same side
  const from = walkPath(e, dir, lane);
  const end = pathPoint(from, from.len);
  let near = 0;
  let nearD = Infinity;
  let corner = 0;
  for (const side of [1, -1] as const) {
    if (!pick.edge.walkClear[di][sideIndex(side)]) continue;
    const p = walkPath(pick.edge, pick.dir, side);
    const d = (p.xs[0]! - end.x) * (p.xs[0]! - end.x) + (p.zs[0]! - end.z) * (p.zs[0]! - end.z);
    if (d < nearD) {
      nearD = d;
      near = side;
    }
    if (sameCorner(node, end.x, end.z, p.xs[0]!, p.zs[0]!)) corner = side;
  }
  let u: number;
  [u, r] = nextFloatWord(r);
  return [pick.edge.id, pick.dir, corner !== 0 && u < 0.8 ? corner : near, r];
}

interface Plan {
  edge: RoadEdgeInfo;
  dir: Dir;
  lane: number;
  path: Path;
}

/** Where an agent goes after its current lane/sidewalk (decided earlier by chooseNext). */
function planNext(g: RoadGraph, a: Readonly<AgentState>): Plan | null {
  if (a.next === "") return null;
  const ei = g.edgeIndex.get(a.next);
  if (ei === undefined) return null;
  const e = g.edges[ei]!;
  const di = dirIndex(a.ndir);
  if (AGENT_SPEC[a.kind].road) {
    const clear = e.laneClear[di];
    let lane = clamp(a.nlane, 0, Math.max(0, clear.length - 1));
    if (!clear[lane]) {
      lane = clear.findIndex(Boolean);
      if (lane < 0) return null;
    }
    return { edge: e, dir: a.ndir, lane, path: lanePath(e, a.ndir, lane) };
  }
  const clear = e.walkClear[di];
  let side = a.nlane === -1 ? -1 : 1;
  if (!clear[sideIndex(side)]) side = -side;
  if (!clear[sideIndex(side)]) return null;
  return { edge: e, dir: a.ndir, lane: side, path: walkPath(e, a.ndir, side) };
}

function makeConnector(from: Path, to: Path, tight: number): number[] {
  const p = pathPoint(from, from.len);
  const q = pathPoint(to, 0);
  return connector(p.x, p.z, p.tx, p.tz, q.x, q.z, q.tx, q.tz, tight);
}

/** Comfortable sideways acceleration for robotaxi turns, m/s^2. */
const TURN_ACCEL = 2.8;

/**
 * Speed for taking a connector: from its tightest bend (radius from the turn between
 * successive sampled segments), v = sqrt(TURN_ACCEL * radius), between 3.5 m/s and cruise.
 */
function turnSpeed(cp: readonly number[], cruise: number): number {
  const p = connectorPath(cp);
  let minR = Infinity;
  for (let i = 1; i + 1 < p.xs.length; i++) {
    const ax = p.xs[i]! - p.xs[i - 1]!;
    const az = p.zs[i]! - p.zs[i - 1]!;
    const bx = p.xs[i + 1]! - p.xs[i]!;
    const bz = p.zs[i + 1]! - p.zs[i]!;
    const la = Math.sqrt(ax * ax + az * az);
    const lb = Math.sqrt(bx * bx + bz * bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    // Turn angle between segments (small-angle safe): sin from the cross product.
    const sin = Math.abs(ax * bz - az * bx) / (la * lb);
    const cos = (ax * bx + az * bz) / (la * lb);
    const ang = cos > 0 ? datan2(sin, cos) : HALF_PI_LOCAL + datan2(-cos, sin);
    if (ang < 1e-6) continue;
    minR = Math.min(minR, (la + lb) / 2 / ang);
  }
  if (minR === Infinity) return Math.min(cruise, 12);
  return clamp(Math.sqrt(TURN_ACCEL * minR), 3.5, Math.min(cruise, 12));
}

const HALF_PI_LOCAL = 1.5707963267948966;

interface Seg {
  path: Path;
  from: number;
  /** Lateral shift applied to points on this segment (walkers' sidestep, current segment only). */
  lat: number;
}

/** The route ahead of an agent: current path, then the planned connector and next path. */
function routeAhead(g: RoadGraph, a: Readonly<AgentState>): Seg[] {
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return [];
  const e = g.edges[ei]!;
  const lane = basePath(e, a);
  const segs: Seg[] = [];
  if (a.conn) {
    segs.push({ path: connectorPath(a.conn), from: a.s, lat: a.lat });
    segs.push({ path: lane, from: a.resume, lat: 0 });
  } else {
    segs.push({ path: lane, from: a.s, lat: a.lat });
  }
  const plan = planNext(g, a);
  if (plan) {
    segs.push({ path: connectorPath(makeConnector(lane, plan.path, AGENT_SPEC[a.kind].road ? 0.56 : 0.9)), from: 0, lat: 0 });
    segs.push({ path: plan.path, from: 0, lat: 0 });
  }
  return segs;
}

/**
 * Points along the route ahead of an agent (its current lane, sidewalk or connector, then the
 * planned connector and next lane), every `step` metres from where it is for up to `dist`
 * metres: position, unit tangent, and the distance along the route. Fewer at a dead end. The
 * dodge (dodge.ts) predicts a robotaxi along it, since that is exactly where it will drive.
 */
export function agentRoute(world: World, a: Readonly<AgentState>, dist: number, step: number): Array<{ x: number; z: number; tx: number; tz: number; d: number }> {
  const ds: number[] = [];
  for (let d = 0; d <= dist + 1e-9; d += step) ds.push(d);
  return agentRouteAt(world, a, ds);
}

/**
 * The agent's pose (position and unit tangent, the way it will face there) at each distance in
 * `ds` (ascending, metres) along the route it will take: exactly where it will be and how it will
 * face, as stepAgent will put it (no interpolation across a bend). Stops where the known route
 * ends.
 */
export function agentRouteAt(world: World, a: Readonly<AgentState>, ds: readonly number[]): Array<{ x: number; z: number; tx: number; tz: number; d: number }> {
  const g = world.roads;
  const out: Array<{ x: number; z: number; tx: number; tz: number; d: number }> = [];
  if (!g) return out;
  const segs = routeAhead(g, a);
  let si = 0;
  let base = 0;
  for (const d of ds) {
    while (si < segs.length && d - base > segs[si]!.path.len - segs[si]!.from) {
      base += Math.max(0, segs[si]!.path.len - segs[si]!.from);
      si++;
    }
    if (si >= segs.length) break;
    const sg = segs[si]!;
    const q = pathPoint(sg.path, sg.from + d - base);
    out.push({ x: q.x - q.tz * sg.lat, z: q.z + q.tx * sg.lat, tx: q.tx, tz: q.tz, d });
  }
  return out;
}

interface Hit {
  gap: number;
  id: number;
  player: boolean;
  /** Blocker's side relative to the probe point (+ = right of travel). */
  side: number;
}

interface ProbeResult {
  first: Hit | null;
  /** Nearest hit with a different id from `first` (for mutual-yield resolution). */
  second: Hit | null;
}

/** Look ahead along the route for obstacles this agent must yield to. */
function probe(
  g: RoadGraph,
  a: Readonly<AgentState>,
  hash: Map<number, Obs[]>,
  ignoreRobotaxis: boolean,
  scratch: Obs[],
): ProbeResult {
  const spec = AGENT_SPEC[a.kind];
  const segs = routeAhead(g, a);
  const step = spec.road ? 1.5 : 0.5;
  const start = spec.road ? 0.8 : 0.2;
  const look = spec.road ? spec.halfLength + Math.max(6, (a.speed * a.speed) / 6 + 4) : spec.halfLength + 2.5;
  const pr = spec.halfWidth + (spec.road ? 0.3 : 0.15);
  let first: Hit | null = null;
  let second: Hit | null = null;
  // Everything the look-ahead could touch lies within `look` of the agent (paths are never
  // shorter than straight lines): gather those once, then test each probe point against them.
  const reach = look + pr + 2.5;
  queryHash(hash, a.x, a.z, reach + OBS_RADIUS_MAX - 2.5, scratch);
  const near: Obs[] = [];
  const hx = dsin(a.heading);
  const hz = -dcos(a.heading);
  for (const o of scratch) {
    if (o.id === a.id) continue;
    if (o.onlyFor !== undefined && o.onlyFor !== (spec.road ? "road" : "foot")) continue;
    if (o.road && ignoreRobotaxis) continue;
    if (o.predicted && o.road === spec.road) continue;
    const dx = o.x - a.x;
    const dz = o.z - a.z;
    if (dx * dx + dz * dz > (reach + o.r) * (reach + o.r)) continue;
    if (dx * hx + dz * hz < -(spec.halfLength + o.r + 3)) continue; // well behind
    near.push(o);
  }
  if (near.length === 0) return { first: null, second: null };
  let si = 0;
  let base = 0; // distance already covered by earlier segments
  for (let d = start; d <= look && si < segs.length; d += step) {
    // Advance to the segment containing distance d.
    while (si < segs.length && d - base > segs[si]!.path.len - segs[si]!.from) {
      base += Math.max(0, segs[si]!.path.len - segs[si]!.from);
      si++;
    }
    if (si >= segs.length) break;
    const sg = segs[si]!;
    const q = pathPoint(sg.path, sg.from + d - base);
    const px = q.x - q.tz * sg.lat;
    const pz = q.z + q.tx * sg.lat;
    for (const o of near) {
      const dx = o.x - px;
      const dz = o.z - pz;
      const lim = pr + o.r + (spec.road && o.foot ? PERSON_BERTH_M : 0);
      if (dx * dx + dz * dz >= lim * lim) continue;
      let gap: number;
      if (o.box) {
        // Distance from the probe point to the box surface.
        const lx = -dx * -o.box.fz + -dz * o.box.fx;
        const lf = -dx * o.box.fx + -dz * o.box.fz;
        const ex = Math.max(0, (lx < 0 ? -lx : lx) - o.box.hw);
        const ef = Math.max(0, (lf < 0 ? -lf : lf) - o.box.hl);
        const dist = Math.sqrt(ex * ex + ef * ef);
        if (dist >= pr) continue;
        gap = Math.max(0, d - spec.halfLength - (pr - dist));
      } else {
        gap = Math.max(0, d - spec.halfLength - o.r);
      }
      const side = dx * -q.tz + dz * q.tx;
      const hit: Hit = { gap, id: o.id, player: o.player, side };
      if (!first || gap < first.gap) {
        if (first && first.id !== hit.id) second = first;
        first = hit;
      } else if (hit.id !== first.id && (!second || gap < second.gap)) {
        second = hit;
      }
    }
    if (first && second) break;
    if (first && d > first.gap + spec.halfLength + 3) break;
  }
  return { first, second };
}

/** A robotaxi's hold on a junction: the path it takes through it, or (once through) its body. */
interface Hold {
  id: number;
  path: Path | null;
  x: number;
  z: number;
  heading: number;
}

/** May this robotaxi drive into the junction at node id? (It holds it, or it won it this tick.) */
function mayEnter(c: Ctx, a: Readonly<AgentState>, nodeId: string): boolean {
  if (c.winners.has(a.id)) return true;
  const hs = c.holders.get(nodeId);
  if (!hs) return false;
  for (const h of hs) if (h.id === a.id) return true;
  return false;
}

function segDist2(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const l2 = ex * ex + ez * ez;
  const t = l2 > 0 ? clamp(((px - ax) * ex + (pz - az) * ez) / l2, 0, 1) : 0;
  const dx = ax + ex * t - px;
  const dz = az + ez * t - pz;
  return dx * dx + dz * dz;
}

function segsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Do two paths come within `clear` metres of each other? */
function pathsConflict(p: Path, q: Path, clear: number): boolean {
  const c2 = clear * clear;
  for (let i = 0; i + 1 < p.xs.length; i++) {
    const ax = p.xs[i]!;
    const az = p.zs[i]!;
    const bx = p.xs[i + 1]!;
    const bz = p.zs[i + 1]!;
    for (let j = 0; j + 1 < q.xs.length; j++) {
      const cx = q.xs[j]!;
      const cz = q.zs[j]!;
      const dx = q.xs[j + 1]!;
      const dz = q.zs[j + 1]!;
      if (segsCross(ax, az, bx, bz, cx, cz, dx, dz)) return true;
      if (
        segDist2(ax, az, bx, bz, cx, cz) < c2 ||
        segDist2(ax, az, bx, bz, dx, dz) < c2 ||
        segDist2(cx, cz, dx, dz, ax, az) < c2 ||
        segDist2(cx, cz, dx, dz, bx, bz) < c2
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Robotaxi bodies need this much room between their centre lines. */
const JUNCTION_CLEAR_M = 2 * AGENT_SPEC.robotaxi.halfWidth + 0.8;

function holdConflicts(path: Path, h: Hold): boolean {
  if (h.path) return pathsConflict(path, h.path, JUNCTION_CLEAR_M);
  // Through the junction already: keep clear of its body (two circles).
  const spec = AGENT_SPEC.robotaxi;
  const o = spec.halfLength - spec.radius;
  const hx = dsin(h.heading);
  const hz = -dcos(h.heading);
  const lim = spec.radius + JUNCTION_CLEAR_M / 2 + 0.3;
  for (const k of [-1, 1]) {
    const cx = h.x + hx * o * k;
    const cz = h.z + hz * o * k;
    for (let i = 0; i + 1 < path.xs.length; i++) {
      if (segDist2(path.xs[i]!, path.zs[i]!, path.xs[i + 1]!, path.zs[i + 1]!, cx, cz) < lim * lim) return true;
    }
  }
  return false;
}

/** A robotaxi body standing at arc length s on a lane. */
function bodyAt(lane: Path, s: number, id: number): Hold {
  const q = pathPoint(lane, s);
  return { id, path: null, x: q.x, z: q.z, heading: datan2(q.tx, -q.tz) };
}

/**
 * Where (arc length on its lane) a robotaxi waits for a junction it does not hold: its front
 * bumper STOPLINE_M before the line, moved back (up to 8 m) while its body would sit in the
 * path of a robotaxi that holds the junction.
 */
function stopPoint(c: Ctx, a: Readonly<AgentState>, lane: Path, nodeId: string): number {
  const spec = AGENT_SPEC[a.kind];
  let s = lane.len - spec.halfLength - STOPLINE_M;
  const hs = c.holders.get(nodeId);
  if (!hs) return s;
  for (let k = 0; k < 8 && s > a.s; k++) {
    const body = bodyAt(lane, s, a.id);
    let hit = false;
    for (const h of hs) {
      if (h.id !== a.id && h.path && holdConflicts(h.path, body)) {
        hit = true;
        break;
      }
    }
    if (!hit) break;
    s -= 1;
  }
  return s;
}

/** Metres of the exit lane a junction hold also covers (the tail is still in the junction there). */
const HOLD_EXIT_M = 8;

function joinPaths(p: Path, q: Path): Path {
  const xs = p.xs.slice();
  const zs = p.zs.slice();
  for (let i = 0; i < q.xs.length; i++) {
    xs.push(q.xs[i]!);
    zs.push(q.zs[i]!);
  }
  return makePath(xs, zs);
}

/** The path through the junction a robotaxi waiting at the end of its lane will take (turn + exit), or null. */
function plannedConnector(g: RoadGraph, a: Readonly<AgentState>): Path | null {
  const ei = g.edgeIndex.get(a.edge);
  const plan = planNext(g, a);
  if (ei === undefined || !plan) return null;
  const turn = connectorPath(makeConnector(basePath(g.edges[ei]!, a), plan.path, 0.56));
  return joinPaths(turn, subPath(plan.path, 0, Math.min(HOLD_EXIT_M, plan.path.len)));
}

/** The rest of a holder's path through its junction: the turn (if still on it) and the exit stretch. */
function holdPath(g: RoadGraph, a: Readonly<AgentState>): Path | null {
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return null;
  const lane = basePath(g.edges[ei]!, a);
  if (a.conn) return joinPaths(connectorPath(a.conn), subPath(lane, 0, Math.min(HOLD_EXIT_M, lane.len)));
  if (g.nodes[startNode(g.edges[ei]!, a.dir)]!.id === a.node) {
    return subPath(lane, Math.max(0, a.s - AGENT_SPEC[a.kind].halfLength), Math.min(lane.len, Math.max(a.s, HOLD_EXIT_M)));
  }
  return plannedConnector(g, a); // claimed, still at its line
}

function remainingOnPath(g: RoadGraph, a: Readonly<AgentState>): { node: number; dist: number } | null {
  if (a.conn) return null;
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return null;
  const e = g.edges[ei]!;
  return { node: endNode(e, a.dir), dist: basePath(e, a).len - a.s };
}

interface Ctx {
  world: World;
  g: RoadGraph;
  hash: Map<number, Obs[]>;
  /** Look-ahead results by agent id; filled for every stepping agent, and on demand (probeOf). */
  probes: Map<number, ProbeResult>;
  byId: Map<number, AgentState>;
  scratch: Obs[];
  /** Node id -> the robotaxis holding it (several when their paths through it do not conflict). */
  holders: Map<string, Hold[]>;
  /** Robotaxis holding a junction (as of the previous tick). */
  holding: Set<number>;
  /** Ids of every robotaxi. */
  road: Set<number>;
  winners: Set<number>;
}

/**
 * An agent's look-ahead as of the previous tick, computed on demand for agents that are not
 * stepping this tick (level of detail), so "are we blocking each other?" has one answer.
 */
function probeOf(c: Ctx, id: number): ProbeResult | undefined {
  const have = c.probes.get(id);
  if (have) return have;
  const a = c.byId.get(id);
  if (!a || a.dwell > 0 || a.dodge !== null) return undefined;
  const p = probe(c.g, a, c.hash, a.ghost > 0, c.scratch);
  c.probes.set(id, p);
  return p;
}

/** A walker never steps closer than this to a vehicle's body (a robotaxi's drawn one, a player's car), metres. */
export const WALKER_VEHICLE_GAP_M = 0.1;

/**
 * Would walker a's step to (x, z) bring its body within WALKER_VEHICLE_GAP_M of a vehicle's body
 * (a robotaxi's drawn body, a player's car, as of the previous tick), closer than it is now?
 */
function nearerVehicle(c: Ctx, a: Readonly<AgentState>, x: number, z: number): boolean {
  const r = AGENT_SPEC[a.kind].radius;
  queryHash(c.hash, x, z, OBS_RADIUS_MAX + r + 1, c.scratch);
  for (const o of c.scratch) {
    if (!o.box || o.predicted) continue;
    if (o.onlyFor === "road") continue;
    // (A moving robotaxi's walker box carries the walkers' berth: measure its drawn body.)
    const hl = o.road ? ROBOTAXI_BODY.halfLength : o.box.hl;
    const hw = o.road ? ROBOTAXI_BODY.halfWidth : o.box.hw;
    const gap = (px: number, pz: number): number => {
      const ox = px - o.x;
      const oz = pz - o.z;
      const along = ox * o.box!.fx + oz * o.box!.fz;
      const lat = -ox * o.box!.fz + oz * o.box!.fx;
      const el = Math.max(0, (lat < 0 ? -lat : lat) - hw);
      const ef = Math.max(0, (along < 0 ? -along : along) - hl);
      return Math.sqrt(el * el + ef * ef) - r;
    };
    const after = gap(x, z);
    if (after < WALKER_VEHICLE_GAP_M && after < gap(a.x, a.z) - 1e-9) return true;
  }
  return false;
}

/** Pitch of a robotaxi body from the ground under its axles (+ = nose up). */
function bodyPitch(world: World, x: number, z: number, heading: number): number {
  const a = AGENT_SPEC.robotaxi.halfLength * 0.6;
  const hx = dsin(heading) * a;
  const hz = -dcos(heading) * a;
  return datan((meshGroundHeight(world, x + hx, z + hz) - meshGroundHeight(world, x - hx, z - hz)) / (2 * a)) + 0;
}

function bodyBlocked(world: World, kind: AgentKind, x: number, z: number, heading: number): boolean {
  const spec = AGENT_SPEC[kind];
  if (!spec.road) return circleBlocked(world, x, z, spec.radius * 0.8);
  const o = spec.halfLength - spec.halfWidth;
  const hx = dsin(heading);
  const hz = -dcos(heading);
  const r = spec.halfWidth * 0.8;
  return circleBlocked(world, x + hx * o, z + hz * o, r) || circleBlocked(world, x - hx * o, z - hz * o, r);
}

/** Advance one agent by dt seconds (DT, or LOD_STRIDE * DT when far). null = remove it. */
function stepAgent(c: Ctx, a: AgentState, dt: number): AgentState | null {
  const spec = AGENT_SPEC[a.kind];
  const g = c.g;
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return null;
  const ticks = Math.round(dt / DT);
  let rng = a.rng;

  // Pauses.
  if (a.dwell > 0) {
    return { ...a, speed: 0, dwell: Math.max(0, a.dwell - ticks), mode: a.dwell - ticks > 0 ? "dwell" : "go" };
  }
  if (spec.dwellPerS > 0 && a.conn === null && a.wait === 0) {
    const [u, r1] = nextFloatWord(rng);
    rng = r1;
    if (u < spec.dwellPerS * dt) {
      const [u2, r2] = nextFloatWord(rng);
      rng = r2;
      const secs = spec.dwellMinS + (spec.dwellMaxS - spec.dwellMinS) * u2;
      return { ...a, speed: 0, dwell: Math.round(secs / DT), mode: "dwell", rng };
    }
  }

  const e = g.edges[ei]!;
  const cur = basePath(e, a);
  const pr = c.probes.get(a.id) ?? { first: null, second: null };
  let blocker = pr.first;
  if (blocker && !blocker.player) {
    const other = probeOf(c, blocker.id);
    const mutual = other !== undefined && other.first !== null && other.first.id === a.id;
    if (spec.road) {
      // Two robotaxis each blocking the other: one that holds a junction goes first (the other
      // is waiting for that junction anyway), otherwise the lower id.
      if (mutual && c.road.has(blocker.id)) {
        const otherHolds = c.holding.has(blocker.id);
        const iHold = c.holding.has(a.id);
        if (iHold && !otherHolds) blocker = pr.second;
        else if (iHold === otherHolds && a.id < blocker.id) blocker = pr.second;
      }
    } else if (c.road.has(blocker.id) && mutual && a.conn !== null && blocker.gap > WALKER_GAP_M) {
      // Already crossing and the robotaxi is waiting for this walker: people have right of
      // way, so the walker goes on (never into the robotaxi itself; a standoff ends with the
      // walker turning round). At the kerb a walker waits for a gap instead.
      blocker = pr.second;
    }
  }

  // Target speed.
  let cruise = a.vmax;
  if (spec.road) cruise = Math.min(cruise, e.speedLimitMps * 1.1);
  let target = cruise;
  let limitedByObstacle = false;
  if (spec.road) {
    if (a.conn) {
      target = Math.min(target, turnSpeed(a.conn, cruise));
    } else {
      const plan = planNext(g, a);
      const rem = cur.len - a.s;
      if (plan) {
        const vt = turnSpeed(makeConnector(cur, plan.path, 0.56), cruise);
        target = Math.min(target, Math.sqrt(vt * vt + 2 * 2.5 * Math.max(0, rem)));
      } else {
        target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, rem - 0.5)));
      }
      // All-way stop: wait with the front bumper at the line (or further back, clear of every
      // path through the junction already claimed) until this robotaxi may enter.
      const node = g.nodes[endNode(e, a.dir)]!;
      if (node.degree >= 3 && a.ghost === 0 && !mayEnter(c, a, node.id)) {
        const v = Math.sqrt(2 * spec.decel * Math.max(0, stopPoint(c, a, cur, node.id) - a.s));
        if (v < target) {
          target = v;
          limitedByObstacle = true;
        }
      }
    }
  }
  const gapMin = spec.road ? ROBOTAXI_GAP_M : WALKER_GAP_M;
  if (blocker) {
    const v = Math.sqrt(2 * spec.decel * Math.max(0, blocker.gap - gapMin));
    if (v < target) {
      target = v;
      limitedByObstacle = true;
    }
  }
  // Someone on foot near it: it creeps past (below the dodge's threat speed), or waits.
  if (spec.road) {
    const lim = berthLimit(c, a, dt);
    if (lim < target) {
      target = lim;
      limitedByObstacle = true;
    }
  }

  // Walkers sidestep oncoming walkers; relax back to the keep-right line otherwise.
  let lat = a.lat;
  if (!spec.road) {
    let want = 0;
    // (Only around other walkers: there is no stepping round a car.)
    if (blocker && !blocker.player && !c.road.has(blocker.id) && blocker.gap < 1.5) want = blocker.side > 0 ? -0.8 : 0.8;
    lat = want === 0 ? approachTo(lat, 0, 0.4 * dt) : approachTo(lat, want, 1.0 * dt);
    // Keep shuffling forward while stepping aside, as long as there is room.
    if (want !== 0 && blocker!.gap > WALKER_GAP_M + 0.2) target = Math.max(target, Math.min(cruise * 0.4, 0.5));
  }

  let speed = a.speed;
  if (target > speed) speed = Math.min(target, speed + spec.accel * dt);
  else speed = Math.max(target, speed - Math.max(spec.decel, 9) * dt);
  if (speed < 0.02) speed = 0;

  // Advance along the route.
  let s = a.s + speed * dt;
  let edge = a.edge;
  let dir = a.dir;
  let lane = a.lane;
  let conn = a.conn;
  let node = a.node;
  let next = a.next;
  let ndir = a.ndir;
  let nlane = a.nlane;
  let resume = a.resume;
  if (spec.road && a.conn === null && a.node === "" && c.winners.has(a.id)) {
    node = g.nodes[endNode(e, a.dir)]!.id; // claim the junction
  }
  let curEdge = e;
  let curPath = cur;
  let held = false;
  for (let hop = 0; hop < 4; hop++) {
    const len = conn ? connectorPath(conn).len : curPath.len;
    if (s < len) break;
    if (conn) {
      s = s - len + resume;
      resume = 0;
      conn = null;
      // Walkers let go of the node at once; a robotaxi holds it until its tail is clear.
      if (!spec.road) node = "";
      continue;
    }
    if (spec.road) {
      const nd = g.nodes[endNode(curEdge, dir)]!;
      if (nd.degree >= 3 && a.ghost === 0 && !mayEnter(c, a, nd.id)) {
        s = Math.min(len, Math.max(a.s, len - spec.halfLength - STOPLINE_M));
        speed = 0;
        held = true;
        break;
      }
    }
    const plan = planNext(g, { ...a, edge, dir, lane, next, ndir, nlane });
    if (!plan) {
      if (spec.road) return null; // nowhere to go: out of service
      // Walkers turn back along the same sidewalk.
      next = curEdge.id;
      ndir = dir === 1 ? -1 : 1;
      nlane = lane;
      continue;
    }
    const cp = makeConnector(curPath, plan.path, spec.road ? 0.56 : 0.9);
    s -= len;
    resume = 0;
    node = g.nodes[endNode(curEdge, dir)]!.id;
    edge = plan.edge.id;
    dir = plan.dir;
    lane = plan.lane;
    conn = cp;
    curEdge = plan.edge;
    curPath = plan.path;
    const [n2, d2, l2, r2] = chooseNext(g, plan.edge, plan.dir, plan.lane, spec.road, rng);
    next = n2;
    ndir = d2;
    nlane = l2;
    rng = r2;
  }

  if (spec.road && conn === null && node !== "" && node === g.nodes[startNode(curEdge, dir)]!.id && s >= spec.halfLength + 1) {
    node = ""; // tail clear of the junction: release it
  }

  // Pose on the (possibly new) path.
  const path = conn ? connectorPath(conn) : curPath;
  const q = pathPoint(path, s);
  const x = q.x - q.tz * lat;
  const z = q.z + q.tx * lat;
  const heading = datan2(q.tx, -q.tz);

  // Blocked: stopped (robotaxi) or reduced to a shuffle (walker) by something in the way,
  // including something right in front that right of way says to ignore but cannot be
  // walked through.
  const pressed = pr.first !== null && pr.first.gap < 0.6;
  const blocked = (limitedByObstacle || held || pressed) && speed < (spec.road ? 0.05 : 0.35);
  // A walker's wait only clears once it is really walking again (not inching along).
  let wait = blocked ? a.wait + ticks : spec.road || speed > 0.6 * cruise ? 0 : Math.max(0, a.wait - ticks);
  // On a safe lane (roads.ts LANE_SAFE_M) a robotaxi cannot touch a building: skip the check.
  const safe = spec.road && conn === null && curEdge.laneSafe[dirIndex(dir)][lane] === true;
  if ((!safe && bodyBlocked(c.world, a.kind, x, z, heading)) || (!spec.road && nearerVehicle(c, a, x, z))) {
    // Refuse the move: stay put and wait. (A walker never steps or sidesteps closer than
    // WALKER_VEHICLE_GAP_M to a vehicle's body: the dodge counts that close as in its way.)
    wait = a.wait + ticks;
    if (spec.road && wait > ROBOTAXI_STUCK_TICKS) return null;
    if (!spec.road && wait > WALKER_TURN_TICKS) return turnAround(c, { ...a, rng });
    return { ...a, speed: 0, wait, mode: "wait", rng };
  }
  if (!spec.road && wait > WALKER_TURN_TICKS) return turnAround(c, { ...a, rng });

  let ghost = Math.max(0, a.ghost - ticks);
  if (spec.road && ghost === 0 && wait > GHOST_AFTER_TICKS && (!blocker || (!blocker.player && c.road.has(blocker.id)))) {
    ghost = GHOST_TICKS;
    wait = 0;
  }

  let mode: AgentMode = "go";
  if (speed < 0.05 && (limitedByObstacle || held)) {
    mode = spec.road && blocker && blocker.player && wait > 120 ? "honk" : "wait";
  } else if (limitedByObstacle && target < cruise * 0.9) mode = "yield";

  return {
    ...a,
    x,
    y: meshGroundHeight(c.world, x, z),
    z,
    heading,
    pitch: spec.road ? bodyPitch(c.world, x, z, heading) : 0,
    speed,
    edge,
    dir,
    lane,
    s,
    next,
    ndir,
    nlane,
    conn,
    node,
    resume,
    lat,
    wait,
    ghost,
    mode,
    rng,
  };
}

function approachTo(v: number, target: number, maxDelta: number): number {
  if (v < target) return v + maxDelta > target ? target : v + maxDelta;
  return v - maxDelta < target ? target : v - maxDelta;
}

/** A walker turns round where it stands and heads back along the same sidewalk. */
function turnAround(c: Ctx, a: AgentState): AgentState {
  const g = c.g;
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return { ...a, wait: 0, speed: 0 };
  const e = g.edges[ei]!;
  const back: Dir = a.dir === 1 ? -1 : 1;
  if (!e.walkClear[dirIndex(back)][sideIndex(a.lane)]) return { ...a, wait: 0, speed: 0 };
  const from = a.conn ? connectorPath(a.conn) : basePath(e, a);
  const p = pathPoint(from, a.s);
  const px = p.x - p.tz * a.lat;
  const pz = p.z + p.tx * a.lat;
  const to = walkPath(e, back, a.lane);
  const s1 = clamp(projectOnPath(to, px, pz).s + 1.0, 0, to.len);
  const q = pathPoint(to, s1);
  // Turn on the spot (start tangent already pointing back), then step onto the return line.
  const cp = connector(px, pz, q.tx, q.tz, q.x, q.z, q.tx, q.tz);
  const [next, ndir, nlane, rng] = chooseNext(g, e, back, a.lane, false, a.rng);
  return {
    ...a,
    nlane,
    dir: back,
    conn: cp,
    node: "",
    s: 0,
    resume: s1,
    lat: 0,
    speed: 0,
    wait: 0,
    next,
    ndir,
    rng,
    heading: datan2(q.tx, -q.tz),
    mode: "wait",
  };
}

// ---------------------------------------------------------------- population

function budget(seed: number, area: AreaRoads, kind: AgentKind): number {
  const spec = AGENT_SPEC[kind];
  const km = (spec.road ? area.driveLen : area.walkLen) / 1000;
  const u = hash32(seed, area.ax, area.az, AGENT_KINDS.indexOf(kind)) / 4294967296;
  return Math.min(spec.cap, Math.floor(km * spec.perKm + u));
}

/** The seeded spawn budget of every kind in one area (for tests and tooling). */
export function areaBudget(world: World, seed: number, key: string): Record<AgentKind, number> {
  const g = world.roads;
  const out: Record<AgentKind, number> = { robotaxi: 0, errandRobot: 0, sidewalkBot: 0, person: 0 };
  if (!g) return out;
  const i = g.areaIndex.get(key);
  if (i === undefined) return out;
  for (const k of AGENT_KINDS) out[k] = budget(seed, g.areas[i]!, k);
  return out;
}

function pickPiece(cum: readonly number[], u: number): number {
  const total = cum[cum.length - 1]!;
  const t = u * total;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function trySpawn(
  world: World,
  g: RoadGraph,
  area: AreaRoads,
  kind: AgentKind,
  rng: RngState,
  id: number,
  others: readonly AgentState[],
  bodies: readonly Body[],
  minPlayerDist: number,
): [AgentState | null, RngState] {
  const spec = AGENT_SPEC[kind];
  const pieces = spec.road ? area.drive : area.walk;
  const cum = spec.road ? area.driveCum : area.walkCum;
  if (pieces.length === 0) return [null, rng];
  let r = rng;
  for (let attempt = 0; attempt < 6; attempt++) {
    let u: number;
    [u, r] = nextFloat(r);
    const piece = pieces[pickPiece(cum, u)]!;
    const e = g.edges[piece.edge]!;
    [u, r] = nextFloat(r);
    const sc = piece.s0 + (piece.s1 - piece.s0) * u;
    // Direction and lane / side among the clear ones.
    const choices: Array<[Dir, number]> = [];
    for (const dir of [1, -1] as const) {
      if (spec.road) {
        if (!canDrive(e, dir)) continue;
        e.laneClear[dirIndex(dir)].forEach((ok, k) => {
          if (ok) choices.push([dir, k]);
        });
      } else {
        for (const side of [1, -1] as const) if (e.walkable && e.walkClear[dirIndex(dir)][sideIndex(side)]) choices.push([dir, side]);
      }
    }
    if (choices.length === 0) continue;
    [u, r] = nextFloat(r);
    const [dir, lane] = choices[Math.min(choices.length - 1, Math.floor(u * choices.length))]!;
    const path = spec.road ? lanePath(e, dir, lane) : walkPath(e, dir, lane);
    const along = dir === 1 ? sc : e.center.len - sc;
    const s = clamp(e.center.len > 0 ? (along * path.len) / e.center.len : 0, 0, path.len);
    const q = pathPoint(path, s);
    const heading = datan2(q.tx, -q.tz);
    if (bodyBlocked(world, kind, q.x, q.z, heading)) continue;
    if (minDist2(bodies, q.x, q.z) < minPlayerDist * minPlayerDist) continue;
    let clash = false;
    for (const o of others) {
      const os = AGENT_SPEC[o.kind];
      const need = spec.road && os.road ? spec.halfLength + os.halfLength + 3 : spec.radius + os.radius + (spec.road || os.road ? 1.5 : 0.4);
      if ((o.x - q.x) * (o.x - q.x) + (o.z - q.z) * (o.z - q.z) < need * need) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    let w: number;
    [w, r] = nextU32(r);
    [u, r] = nextFloat(r);
    const vmax = spec.vmin + (spec.vmax - spec.vmin) * u;
    const [next, ndir, nlane, arng] = chooseNext(g, e, dir, lane, spec.road, w);
    const agent: AgentState = {
      id,
      kind,
      x: q.x,
      y: meshGroundHeight(world, q.x, q.z),
      z: q.z,
      heading,
      pitch: spec.road ? bodyPitch(world, q.x, q.z, heading) : 0,
      speed: 0,
      vmax,
      edge: e.id,
      dir,
      lane,
      s,
      next,
      ndir,
      nlane,
      conn: null,
      node: "",
      resume: 0,
      lat: 0,
      wait: 0,
      dwell: 0,
      ghost: 0,
      mode: "go",
      rng: arng,
      dodge: null,
    };
    return [agent, r];
  }
  return [null, r];
}

/**
 * Despawn agents far from every player and spawn into active areas below budget.
 * `initial` fills every active area to budget and only keeps spawns off the players' bodies.
 */
export function populate(
  world: World,
  ext: AgentsExt,
  rng: RngState,
  bodies: readonly Body[],
  seed: number,
  initial: boolean,
): { ext: AgentsExt; rng: RngState } {
  const g = world.roads;
  if (!g || bodies.length === 0) return { ext, rng };
  const keep = ext.list.filter((a) => minDist2(bodies, a.x, a.z) <= DESPAWN_RANGE_M * DESPAWN_RANGE_M);
  const list = keep.slice();
  let nextId = ext.nextId;
  let r = rng;

  const reach = ACTIVE_RANGE_M + AREA_HALF_DIAG;
  const active = g.areas
    .map((ar) => ({ ar, d2: minDist2(bodies, ar.cx, ar.cz) }))
    .filter((v) => v.d2 <= reach * reach)
    .sort((p, q) => p.d2 - q.d2 || (p.ar.key < q.ar.key ? -1 : p.ar.key > q.ar.key ? 1 : 0));

  // Agents wander between areas, so an area can be short while its neighbours are over.
  // Each kind's total is also held to the sum of the active areas' budgets.
  const counts = new Map<string, number>();
  const totals = new Map<AgentKind, number>();
  // Agents around each player (by nearest player), held to MAX_AGENTS each.
  const owned = bodies.map(() => 0);
  for (const a of list) {
    const k = `${areaOf(a.x, a.z).key}|${a.kind}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    totals.set(a.kind, (totals.get(a.kind) ?? 0) + 1);
    owned[nearestBody(bodies, a.x, a.z)]!++;
  }
  const room = new Map<AgentKind, number>();
  for (const kind of AGENT_KINDS) {
    let sum = 0;
    for (const { ar } of active) sum += budget(seed, ar, kind);
    room.set(kind, sum - (totals.get(kind) ?? 0));
  }
  const minPlayer = initial ? 6 : SPAWN_MIN_PLAYER_M;
  for (const { ar } of active) {
    const owner = nearestBody(bodies, ar.cx, ar.cz);
    for (const kind of AGENT_KINDS) {
      const want = budget(seed, ar, kind);
      const have = counts.get(`${ar.key}|${kind}`) ?? 0;
      let add = Math.min(Math.max(0, want - have), Math.max(0, room.get(kind)!));
      if (!initial) add = Math.min(add, SPAWN_PER_POP);
      for (let i = 0; i < add && owned[owner]! < MAX_AGENTS && list.length < MAX_AGENTS_TOTAL; i++) {
        const [agent, r2] = trySpawn(world, g, ar, kind, r, nextId, list, bodies, minPlayer);
        r = r2;
        if (!agent) continue;
        list.push(agent);
        nextId++;
        room.set(kind, room.get(kind)! - 1);
        owned[nearestBody(bodies, agent.x, agent.z)]!++;
      }
    }
  }
  return { ext: { nextId, list }, rng: r };
}

/** Initial ambient population for a new state (empty when the world has no roads). */
export function initialAgents(world: World, state: Readonly<SimState>): { ext: AgentsExt; rng: RngState } {
  return populate(world, { nextId: 1, list: [] }, state.rng, playerBodies(state), state.seed, true);
}

/**
 * Advance every agent one tick. Reads `prev` only (players and agents as of the previous
 * tick); returns the new agents and the new global RNG state.
 */
export function stepAgents(world: World, prev: Readonly<SimState>, tick: number): { ext: AgentsExt; rng: RngState } | null {
  const g = world.roads;
  if (!g) return null;
  const ext = (prev.ext[AGENTS_EXT_KEY] as AgentsExt | undefined) ?? { nextId: 1, list: [] };
  const bodies = playerBodies(prev);
  if (bodies.length === 0) return { ext, rng: prev.rng };

  const obs = [...playerObstacles(prev), ...agentObstacles(ext.list)];
  const hash = buildHash(obs);

  // Who steps this tick, and by how much.
  const stepDt = new Map<number, number>();
  for (const a of ext.list) {
    const near = minDist2(bodies, a.x, a.z) <= NEAR_RANGE_M * NEAR_RANGE_M;
    if (near) stepDt.set(a.id, DT);
    else if ((tick + a.id) % LOD_STRIDE === 0) stepDt.set(a.id, DT * LOD_STRIDE);
  }

  // Look-ahead for everyone who steps (pass 1), so mutual blocks can be resolved fairly.
  const probes = new Map<number, ProbeResult>();
  const scratch: Obs[] = [];
  for (const a of ext.list) {
    if (!stepDt.has(a.id) || a.dwell > 0 || a.dodge !== null) continue;
    probes.set(a.id, probe(g, a, hash, a.ghost > 0, scratch));
  }

  // Junctions (nodes with 3+ streets): who holds each one (claimed at the line, crossing, or
  // with its tail still inside), and who may claim it this tick: longest wait first, then
  // lowest id, as long as its path through the junction keeps clear of every holder's.
  // Nobody enters toward a lane whose start is full (no blocking the box).
  const holders = new Map<string, Hold[]>();
  const fullStart = new Set<string>();
  for (const a of ext.list) {
    if (!AGENT_SPEC[a.kind].road) continue;
    if (a.node !== "") {
      const ni = g.nodeIndex.get(a.node);
      if (ni !== undefined && g.nodes[ni]!.degree >= 3) {
        const path = holdPath(g, a);
        let l = holders.get(a.node);
        if (!l) holders.set(a.node, (l = []));
        l.push({ id: a.id, path, x: a.x, z: a.z, heading: a.heading });
      }
    }
    if (a.conn === null && a.s < EXIT_CLEAR_M) fullStart.add(`${a.edge}|${a.dir}|${a.lane}`);
  }
  // Robotaxis waiting near a junction's lines (contenders are the ones that may claim now).
  const waiters = new Map<string, Array<{ a: AgentState; path: Path | null }>>();
  const contenders = new Map<string, AgentState[]>();
  for (const a of ext.list) {
    const spec = AGENT_SPEC[a.kind];
    if (!spec.road || a.ghost > 0 || a.node !== "") continue;
    const rem = remainingOnPath(g, a);
    if (!rem) continue;
    const nd = g.nodes[rem.node]!;
    if (nd.degree < 3) continue;
    if (rem.dist > spec.halfLength + STOPLINE_M + 9) continue;
    let w = waiters.get(nd.id);
    if (!w) waiters.set(nd.id, (w = []));
    w.push({ a, path: plannedConnector(g, a) });
    const dt = stepDt.get(a.id) ?? DT;
    if (rem.dist > spec.halfLength + STOPLINE_M + 1 + a.speed * dt) continue;
    const plan = planNext(g, a);
    if (plan && fullStart.has(`${plan.edge.id}|${plan.dir}|${plan.lane}`)) continue;
    let l = contenders.get(nd.id);
    if (!l) contenders.set(nd.id, (l = []));
    l.push(a);
  }
  const winners = new Set<number>();
  for (const key of [...contenders.keys()].sort()) {
    const l = contenders.get(key)!.slice().sort((p, q) => q.wait - p.wait || p.id - q.id);
    const ws = waiters.get(key) ?? [];
    let hs = holders.get(key);
    if (!hs) holders.set(key, (hs = []));
    for (const a of l) {
      const path = plannedConnector(g, a);
      if (!path) continue;
      let ok = true;
      for (const h of hs) {
        if (holdConflicts(path, h)) {
          ok = false;
          break;
        }
      }
      // Not through the nose of another robotaxi waiting here, unless each is in the other's
      // way (then priority decides).
      const me: Hold = { id: a.id, path: null, x: a.x, z: a.z, heading: a.heading };
      for (const w of ws) {
        if (!ok) break;
        if (w.a.id === a.id || winners.has(w.a.id)) continue;
        const wb: Hold = { id: w.a.id, path: null, x: w.a.x, z: w.a.z, heading: w.a.heading };
        if (holdConflicts(path, wb) && !(w.path && holdConflicts(w.path, me))) ok = false;
      }
      if (!ok) continue;
      winners.add(a.id);
      hs.push({ id: a.id, path, x: a.x, z: a.z, heading: a.heading });
    }
  }

  const holding = new Set<number>();
  const road = new Set<number>();
  for (const a of ext.list) {
    if (!AGENT_SPEC[a.kind].road) continue;
    road.add(a.id);
    if (a.node !== "") holding.add(a.id);
  }
  const byId = new Map<number, AgentState>();
  for (const a of ext.list) byId.set(a.id, a);
  const ctx: Ctx = { world, g, hash, probes, byId, scratch, holders, holding, road, winners };
  const list: AgentState[] = [];
  for (const a of ext.list) {
    const dt = stepDt.get(a.id);
    // Not stepping this tick, or diving out of a vehicle's way (dodge.ts moves it).
    if (dt === undefined || a.dodge !== null) {
      list.push(a);
      continue;
    }
    const n = stepAgent(ctx, a, dt);
    if (!n) continue;
    // Out of view and stuck for good (a standoff in a tangle of real-world junctions): retire it.
    if (n.wait > STUCK_REMOVE_TICKS && minDist2(bodies, n.x, n.z) > SPAWN_MIN_PLAYER_M * SPAWN_MIN_PLAYER_M) continue;
    list.push(n);
  }

  let out: AgentsExt = { nextId: ext.nextId, list };
  let rng = prev.rng;
  if (tick % POP_INTERVAL === 0) {
    const p = populate(world, out, rng, bodies, prev.seed, false);
    out = p.ext;
    rng = p.rng;
  }
  return { ext: out, rng };
}

/** Why an agent is doing what it does (for debug overlays, the harness and tests). */
export interface AgentExplain {
  id: number;
  kind: AgentKind;
  mode: AgentMode;
  /** Nearest thing ahead it yields to: an agent id, "player", or null. */
  blocker: number | "player" | null;
  gap: number | null;
  /** Metres to the end of its lane/sidewalk (null on a connector). */
  remaining: number | null;
  /** The node its lane ends at, and which robotaxi holds that node (all-way stop), if any. */
  node: string | null;
  holder: number | null;
  /** Planned next edge, direction and lane/side. */
  next: string;
  ndir: Dir;
  nlane: number;
}

export function explainAgent(world: World, state: Readonly<SimState>, id: number): AgentExplain | null {
  const g = world.roads;
  const a = agentById(state, id);
  if (!g || !a) return null;
  const ext = state.ext[AGENTS_EXT_KEY] as AgentsExt;
  const hash = buildHash([...playerObstacles(state), ...agentObstacles(ext.list)]);
  const pr = probe(g, a, hash, a.ghost > 0, []);
  const rem = remainingOnPath(g, a);
  let holder: number | null = null;
  const nodeId = rem ? g.nodes[rem.node]!.id : null;
  if (nodeId) for (const o of ext.list) if (AGENT_SPEC[o.kind].road && o.node === nodeId && holder === null) holder = o.id;
  return {
    id: a.id,
    kind: a.kind,
    mode: a.mode,
    blocker: pr.first ? (pr.first.player ? "player" : pr.first.id) : null,
    gap: pr.first ? pr.first.gap : null,
    remaining: rem ? rem.dist : null,
    node: nodeId,
    holder,
    next: a.next,
    ndir: a.ndir,
    nlane: a.nlane,
  };
}

/**
 * Agents of `curr` paired with the same agent in `prev` (or null when it just spawned), in
 * ascending id order: what a renderer needs to interpolate poses between two ticks. Agents
 * that despawned between the two states are not listed.
 */
export function agentPairs(prev: Readonly<SimState>, curr: Readonly<SimState>): Array<[AgentState | null, AgentState]> {
  const a = agentsOf(prev);
  const b = agentsOf(curr);
  const out: Array<[AgentState | null, AgentState]> = [];
  let i = 0;
  for (const n of b) {
    while (i < a.length && a[i]!.id < n.id) i++;
    out.push([i < a.length && a[i]!.id === n.id ? a[i]! : null, n]);
  }
  return out;
}
