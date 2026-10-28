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
//    From v20, signal-controlled approaches may claim only on their shared green phase;
//    existing holders clear the junction through amber/red, including during jam recovery.
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
//    pop-in in view) and SPAWN_VEHICLE_CLEAR_M clear of every vehicle's body (a player's parked
//    car included; a new robotaxi clear of everyone on foot), so nobody appears inside or
//    against one. The initial state fills every active area to budget. Nearer areas fill
//    first. Each area belongs to its nearest player (ties: the lower player id), and so does
//    each agent: one player's surroundings hold at most MAX_AGENTS agents, the whole state
//    MAX_AGENTS_TOTAL, so a second player across town gets their own traffic instead of
//    whatever the first player's areas left over. The whole city's road graph is loaded, but
//    only the areas around players are ever populated or stepped.
//  - v26 (owner, 2026-10-27: "remove the little vacuum robots for now"): Trundles (sidewalkBot)
//    are no longer part of the street. The initial fill is unchanged (older replays restamp the
//    state createInitialState makes, so it must not change), but the first step of a v26 state
//    takes every ambient Trundle off the street (one mid-dodge waits for its dodge to end), and
//    population passes give each area's Trundle budget to Footmen (errandRobot), one for one,
//    with the Trundles' hour and district shaping. Missions and the Ambient Director still stage
//    their own named Trundles (runtime actors, src/sim/agents/incidents.ts, mission-actors.ts).
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

import { isCivilianTraffic, CIVILIAN_PASS_INTERVAL_TICKS } from "./civilian-traffic.ts";
import { agentActorId } from "./identity.ts";
import { DT, SIM_VERSION, sortedIds, type DodgeState, type RngState, type SimState } from "./contract.ts";
import { clamp, datan, datan2, dcos, dsin } from "./dmath.ts";
import { arrived, hailsByAgent, playerPose, ridesByAgent } from "./ride.ts";
import { rideRouteNext } from "./ride-route.ts";
import { hash32, nextFloat, nextFloatWord, nextU32 } from "./rng.ts";
import { movementLimit } from "./combat/system.ts";
import {
  AREA_M,
  areaOf,
  connector,
  connectorPath,
  dirIndex,
  projectOnPath,
  endNode,
  laneOffset,
  lanePath,
  makePath,
  offsetAdvance,
  offsetPoint,
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
import { amberTicksLeft, signalAspect, type TrafficSignalControls } from "./traffic-signals.ts";
import {
  PASS_BEYOND_M,
  PASS_RAMPS_M,
  PASS_FOOT_SLACK_M,
  PASS_FOOT_WAIT_TICKS,
  PASS_RETRY_TICKS,
  PASS_SIDE_CLEAR_M,
  PASS_SPEED_MPS,
  PASS_STANDOFF_M,
  PASS_TARGET_GAP_M,
  PASS_VEHICLE_GAP_M,
  PASS_WAIT_TICKS,
  PASS_POSE_STEP_M,
  passLat,
  passOffsets,
  passPose,
  passTime,
  pointRectGap,
  poseHeading,
  rectAt,
  rectGap,
  rectOnPath,
  type PassState,
  type Rect,
} from "./overtake.ts";

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
 * A robotaxi's body as people meet it: a box covering the drawn Meander (4.98 x 1.92 m, 1.53 m tall), a little
 * longer than the AGENT_SPEC box traffic spaces itself by. Walkers keep clear of it, robotaxis
 * keep their berth from people by it, and the dodge (src/sim/dodge.ts) counts contacts and
 * clearance against it.
 */
export const ROBOTAXI_BODY = { halfLength: 2.5, halfWidth: 1.0, height: 1.6 } as const;

/** About this share of the people (by id) are children: smaller, and given a wider berth by the dodge (src/sim/dodge.ts). */
export const CHILD_PERCENT = 5;

/** Is person agent `id` a child? Fixed by the id (no state, no RNG draw), so every client agrees. */
export function personIsChild(id: number): boolean {
  return hash32(id, 0x0c41d) % 100 < CHILD_PERCENT;
}

export interface TrafficLeg { edge: string; dir: Dir; lane: number }

export interface AgentState {
  /** v15: a bounded admission approach; consumed after its final frontage, then normal wandering. */
  trafficRoute?: TrafficLeg[];
  /** Core physical proxies for lane-owned runtime actors stay out of ambient rendering/sensing. */
  runtimeId?: string;
  /** Physical controller memory for service vehicles. */
  vehicle?: import("./contract.ts").CarState;
  /** Claimed ambient body remains visible through the legacy read adapter. */
  runtimeLegacy?: boolean;
  radius?: number;
  height?: number;
  halfLength?: number;
  halfWidth?: number;
  protected?: boolean;
  child?: boolean;
  mobilityAid?: boolean;
  posture?: "standing" | "seated" | "lying";
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
  /** v14: knocked off its path by a hit (src/sim/impacts.ts); absent otherwise. stepAgents leaves it alone. */
  knock?: import("./impacts.ts").KnockState;
  /** v14: how dented each side is (src/sim/impacts.ts); absent while undamaged. */
  dents?: import("./impacts.ts").Dents;
  /** v13 robotaxis: going round a stopped vehicle on the current lane (src/sim/overtake.ts); absent otherwise. */
  pass?: PassState;
  /** v16: commandeered taxi physics. With no driver it brakes and parks where it was left. */
  manualCar?: import("./contract.ts").CarState;
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
/** With city-life densities, a kind over its budget sheds at most this many agents per population pass. */
export const TRIM_PER_POP = 4;
/** The most ambient agents around one player (the areas nearest to that player). */
export const MAX_AGENTS = 512;
/** The most ambient agents in a state, however many players. */
export const MAX_AGENTS_TOTAL = 1024;
/**
 * v26: the first SIM_VERSION with no ambient Trundles (sidewalkBot); their population budget goes
 * to Footmen. See the header (Population). Older versions keep them, bit for bit.
 */
export const TRUNDLE_FREE_VERSION = 26;
/**
 * v26: two stand-offs that more Footmen made common are broken (stepAgent, Ctx.unstick). A robotaxi
 * or civilian car whose pass has stalled behind the vehicle it was going round drops the pass and
 * plans again; a robot on the pavement nose to nose with a vehicle steps aside as it would for a
 * walker. v25 and older wait there until the deadlock breaker.
 */
export const UNSTICK_VERSION = 26;
export const ROBOTAXI_GAP_M = 1.5;
/** A robotaxi waiting at an all-way stop keeps its front bumper this far behind the line. */
export const STOPLINE_M = 0.5;
/** A lane whose first metres hold a robotaxi is full: nobody enters the junction toward it. */
export const EXIT_CLEAR_M = 7;
/**
 * A lane into another junction shorter than this is a short link: a robotaxi waiting at its far
 * line (backed off as far as stopPoint goes, 8 m) still has its tail in the junction behind it,
 * so it keeps that junction (released at halfLength + 1 m) while it waits.
 */
export const SHORT_LINK_M = 2 * AGENT_SPEC.robotaxi.halfLength + 1 + STOPLINE_M + 8;
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
  if (!ext) return [];
  return ext.list.some(a => a.runtimeId !== undefined) ? ext.list.filter(a => a.runtimeId === undefined || a.runtimeLegacy === true) : ext.list;
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
  if (a.runtimeId !== undefined) {
    const radius = a.radius ?? spec.radius;
    if (!spec.road) return [{ x:a.x,z:a.z,r:radius }];
    const halfLength=a.halfLength??ROBOTAXI_BODY.halfLength, halfWidth=a.halfWidth??ROBOTAXI_BODY.halfWidth;
    const span=Math.max(0,halfLength-halfWidth),steps=Math.max(1,Math.ceil(span/halfWidth));
    return Array.from({length:steps*2+1},(_,i)=>{const offset=(i/steps-1)*span;return {x:a.x+dsin(a.heading)*offset,z:a.z-dcos(a.heading)*offset,r:halfWidth};});
  }
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
  /** A vehicle a robotaxi may go round once it is standing still (a player's car, a service vehicle, a seized robotaxi). */
  pass?: PassBody;
  /** A robotaxi going round a stopped vehicle (never ignored by the deadlock breaker or a mutual yield). */
  passing?: boolean;
  /** The stretch of road a passing robotaxi has claimed ahead of it: robotaxis stop short of it. */
  claim?: boolean;
}

/** A body robotaxis may go round once it stands still in their lane: a vehicle, or someone on foot. */
interface PassBody {
  /** "p:<player id>" (a car), "pf:<player id>" (a player on foot) or "a:<agent id>". */
  key: string;
  rect: Rect;
  speed: number;
  /** Someone on foot (a person, a robot, a player's walker): passed only with the walker berth to spare. */
  foot?: boolean;
  child?: boolean;
}

/** A vehicle body for planning a pass: everything with wheels near the road. */
interface PassVehicle extends PassBody {
  id: number;
}

/** Someone on foot, for planning a pass: position, velocity, radius. */
interface PassFoot {
  x: number;
  z: number;
  vx: number;
  vz: number;
  r: number;
  child: boolean;
}

interface Body {
  x: number;
  z: number;
}

/** The obstacle hash (buildHash) and, in the same pass, the ones on foot and the vehicle boxes walkers meet (Ctx.footHash, Ctx.boxHash). */
function buildHashes(obs: readonly Obs[]): { hash: Map<number, Obs[]>; footHash: Map<number, Obs[]>; boxHash: Map<number, Obs[]> } {
  const hash = new Map<number, Obs[]>();
  const footHash = new Map<number, Obs[]>();
  const boxHash = new Map<number, Obs[]>();
  const put = (m: Map<number, Obs[]>, k: number, o: Obs): void => {
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    l.push(o);
  };
  for (const o of obs) {
    const k = cellKey(Math.floor(o.x / HASH_CELL), Math.floor(o.z / HASH_CELL));
    put(hash, k, o);
    if (o.predicted === true) continue;
    if (o.foot === true) put(footHash, k, o);
    if (o.box !== undefined && o.onlyFor !== "road") put(boxHash, k, o);
  }
  return { hash, footHash, boxHash };
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
    // A rider counts where the taxi is (keeps it stepped every tick and never despawned).
    const b = playerPose(state.players[id]!);
    out.push({ x: b.x, z: b.z });
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
      pass: { key: `p:${id}`, rect: rectAt(c.x, c.z, c.heading, CAR.halfLength, CAR.halfWidth), speed: c.speed },
    });
    if (p.mode === "foot" && p.foot) out.push({ x: p.foot.x, z: p.foot.z, r: FOOT.radius, id: -1, player: true, road: false, foot: true,
      pass: { key: `pf:${id}`, rect: rectAt(p.foot.x, p.foot.z, 0, FOOT.radius, FOOT.radius), speed: p.foot.speed, foot: true } });
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
export const ROBOTAXI_CREEP_MPS = 0.9;
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
/** berthLimit first looks along the route this often, metres (and finer only when someone is near it). */
const COARSE_STEP_M = 0.5;
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
  queryHash(c.footHash, a.x, a.z, reach, c.scratch);
  const near: Obs[] = [];
  for (const o of c.scratch) {
    const dx = o.x - a.x;
    const dz = o.z - a.z;
    if (dx * dx + dz * dz <= (reach + o.r) * (reach + o.r)) near.push(o);
  }
  if (near.length === 0) return Infinity;
  const segs = routeOf(c.routes, c.g, a);
  // First the route every COARSE_STEP_M: the body at any pose lies within half that and its half
  // diagonal of one of those points, so someone farther than that plus the slow berth from all of
  // them is clear of every pose (most people on the pavement beside a lane): no finer look.
  const coarse: number[] = [];
  for (let d = COARSE_STEP_M; d < ahead - 1e-9; d += COARSE_STEP_M) coarse.push(d);
  coarse.push(ahead);
  const cps = agentRouteAt(c.world, a, coarse, segs);
  const halfDiag = Math.sqrt(ROBOTAXI_BODY.halfLength * ROBOTAXI_BODY.halfLength + ROBOTAXI_BODY.halfWidth * ROBOTAXI_BODY.halfWidth);
  let any = false;
  for (const o of near) {
    const slow = (o.child ? ROBOTAXI_SLOW_BERTH_CHILD_M : ROBOTAXI_SLOW_BERTH_M) + BERTH_SLACK_M;
    const lim = slow + o.r + halfDiag + COARSE_STEP_M / 2 + 0.02;
    let close = (o.x - a.x) * (o.x - a.x) + (o.z - a.z) * (o.z - a.z) < lim * lim;
    for (let i = 0; !close && i < cps.length; i++) {
      const q = cps[i]!;
      close = (o.x - q.x) * (o.x - q.x) + (o.z - q.z) * (o.z - q.z) < lim * lim;
    }
    if (close) {
      any = true;
      break;
    }
  }
  // (A route that ends short of `ahead`, at a dead end: the finer look below handles it.)
  if (!any && cps.length === coarse.length) return Infinity;
  const poses: Array<{ x: number; z: number; hx: number; hz: number; d: number }> = [{ x: a.x, z: a.z, hx: dsin(a.heading), hz: -dcos(a.heading), d: 0 }];
  // Every STOP_STEP_M over this step (and two ticks), exactly where that ends, then every
  // BERTH_STEP_M on to where it could stop.
  const ds: number[] = [];
  for (let d = STOP_STEP_M; d < step - 1e-9; d += STOP_STEP_M) ds.push(d);
  ds.push(step);
  for (let d = step + BERTH_STEP_M; d < ahead + 1e-9; d += BERTH_STEP_M) ds.push(d);
  for (const q of agentRouteAt(c.world, a, ds, segs)) {
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
    // Someone within the stop berth already: it does not set off, or stops (moving at all, it
    // would be a moving vehicle within the override's clearance of them).
    if (now < stop) return 0;
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

/** Spacing of a passing robotaxi's claim circles along its profile, metres. */
const CLAIM_STEP_M = 2.5;
/** Only where the profile is at least this far off the lane does it claim road, metres. */
const CLAIM_LAT_M = 0.5;

/** The body robotaxis plan a pass around: a service vehicle's own extents, else the drawn robotaxi. */
function vehicleRect(a: Readonly<AgentState>): Rect {
  return rectAt(a.x, a.z, a.heading, a.halfLength ?? ROBOTAXI_BODY.halfLength, a.halfWidth ?? ROBOTAXI_BODY.halfWidth);
}

/**
 * Obstacles of the agents. With the road graph: a passing robotaxi also claims the road ahead
 * of it along its profile. `passable`: robotaxi ids others may go round once they stand still
 * (seized ones); service and mission vehicles (runtimeId) always may.
 */
function agentObstacles(list: readonly AgentState[], g: RoadGraph | null = null, passable: ReadonlySet<number> = new Set()): Obs[] {
  const out: Obs[] = [];
  for (const a of list) {
    const spec = AGENT_SPEC[a.kind];
    const road = spec.road;
    if (road) {
      // To robotaxis, its two circles; to walkers, its drawn body (with a berth while it moves).
      const pass = a.runtimeId !== undefined || a.manualCar || passable.has(a.id) ? { key: `a:${a.id}`, rect: vehicleRect(a), speed: a.speed } : undefined;
      const passing = a.pass !== undefined;
      for (const c of agentCircles(a)) out.push({ x: c.x, z: c.z, r: c.r, id: a.id, player: false, road, onlyFor: "road", ...(pass ? { pass } : {}), ...(passing ? { passing } : {}) });
      const ei = g && a.pass && a.conn === null ? g.edgeIndex.get(a.edge) : undefined;
      if (g && a.pass && ei !== undefined) {
        const lane = basePath(g.edges[ei]!, a);
        for (let d = a.s + CLAIM_STEP_M; d < a.pass.s3; d += CLAIM_STEP_M) {
          if (Math.abs(passLat(a.pass, d)) < CLAIM_LAT_M) continue;
          const q = passPose(lane, a.pass, d);
          out.push({ x: q.x, z: q.z, r: spec.radius, id: a.id, player: false, road, onlyFor: "road", passing: true, claim: true });
        }
      }
      const grow = a.speed > TAXI_STOPPED_MPS ? WALKER_TAXI_BERTH_M : 0;
      const hl = ROBOTAXI_BODY.halfLength + grow;
      const hw = ROBOTAXI_BODY.halfWidth + grow;
      out.push({ x: a.x, z: a.z, r: Math.sqrt(hl * hl + hw * hw), id: a.id, player: false, road, onlyFor: "foot", box: { fx: dsin(a.heading), fz: -dcos(a.heading), hl, hw } });
    } else {
      const r = a.radius ?? spec.radius, child = a.child === true || (a.kind === "person" && personIsChild(a.id));
      out.push({ x: a.x, z: a.z, r: spec.radius, id: a.id, player: false, road, foot: true, child,
        pass: { key: `a:${a.id}`, rect: rectAt(a.x, a.z, 0, r, r), speed: a.speed, foot: true, child } });
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
function chooseNext(g: RoadGraph, e: RoadEdgeInfo, dir: Dir, lane: number, road: boolean, rng: number, goal: { x: number; z: number } | null = null): [string, Dir, number, number] {
  const node = g.nodes[endNode(e, dir)]!;
  // A ridden taxi follows a cached shortest route, including a legal turn back if needed.
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
  if (goal && road) {
    const next = rideRouteNext(g, node.index, goal);
    if (next) pick = { edge: g.edges[next.edge]!, dir: next.dir };
  } else if (options.length === 0) {
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

export interface Seg {
  path: Path;
  from: number;
  /** Lateral shift applied to points on this segment (walkers' sidestep, current segment only). */
  lat: number;
  /** A robotaxi's pass profile on its current lane (overtake.ts): the shift by arc length instead of `lat`. */
  pass?: PassState;

}

/** Position and unit tangent (the way the body faces) at arc length s of a route segment. */
function segPose(sg: Seg, s: number): { x: number; z: number; tx: number; tz: number } {
  if (sg.pass) {
    const p = passPose(sg.path, sg.pass, s);
    return { x: p.x, z: p.z, tx: p.hx, tz: p.hz };
  }
  const q = pathPoint(sg.path, s);
  const o = offsetPoint(sg.path, s, sg.lat);
  return { x: o.x, z: o.z, tx: q.tx, tz: q.tz };
}

/**
 * The route ahead of an agent (routeAhead): the segments it has worked out, and the planned
 * connector and next path it adds only when a walk along the route gets past them (most walks,
 * a walker's look-ahead, a robotaxi on a long lane, end on the path the agent is on).
 */
export interface Route {
  segs: Seg[];
  pending: { g: RoadGraph; a: Readonly<AgentState>; lane: Path } | null;
}

/**
 * The route ahead of an agent (routeAhead), for callers that ask agentRouteAt about the same
 * agent more than once in a tick (the dodge's prediction and reach of a robotaxi): one route walk.
 */
export function agentRouteSegs(world: World, a: Readonly<AgentState>): Route {
  return world.roads ? routeAhead(world.roads, a) : { segs: [], pending: null };
}

/** The route ahead of an agent: current path, then the planned connector and next path (segAt adds those when needed). */
function routeAhead(g: RoadGraph, a: Readonly<AgentState>): Route {
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return { segs: [], pending: null };
  const e = g.edges[ei]!;
  const lane = basePath(e, a);
  const segs: Seg[] = [];
  if (a.conn) {
    segs.push({ path: connectorPath(a.conn), from: a.s, lat: a.lat });
    segs.push({ path: lane, from: a.resume, lat: 0 });
  } else if (a.pass && AGENT_SPEC[a.kind].road) {
    segs.push({ path: lane, from: a.s, lat: 0, pass: a.pass });
  } else {
    segs.push({ path: lane, from: a.s, lat: a.lat });
  }
  return { segs, pending: { g, a, lane } };
}

/** Segment i of a route (adding the planned connector and next path when the walk needs them), or null past its end. */
function segAt(r: Route, i: number): Seg | null {
  if (i >= r.segs.length && r.pending) {
    const { g, a, lane } = r.pending;
    r.pending = null;
    const plan = planNext(g, a);
    if (plan) {
      r.segs.push({ path: connectorPath(makeConnector(lane, plan.path, AGENT_SPEC[a.kind].road ? 0.56 : 0.9)), from: 0, lat: 0 });
      r.segs.push({ path: plan.path, from: 0, lat: 0 });
    }
  }
  return r.segs[i] ?? null;
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
export function agentRouteAt(world: World, a: Readonly<AgentState>, ds: readonly number[], route: Route | null = null): Array<{ x: number; z: number; tx: number; tz: number; d: number }> {
  const g = world.roads;
  const out: Array<{ x: number; z: number; tx: number; tz: number; d: number }> = [];
  if (!g) return out;
  route ??= routeAhead(g, a);
  let si = 0;
  let base = 0;
  for (const d of ds) {
    let sg = segAt(route, si);
    while (sg && d - base > sg.path.len - sg.from) {
      base += Math.max(0, sg.path.len - sg.from);
      sg = segAt(route, ++si);
    }
    if (!sg) break;
    const o = segPose(sg, sg.from + d - base);
    out.push({ x: o.x, z: o.z, tx: o.tx, tz: o.tz, d });
  }
  return out;
}

interface Hit {
  gap: number;
  id: number;
  player: boolean;
  /** Blocker's side relative to the probe point (+ = right of travel). */
  side: number;
  /** A vehicle that may be gone round once it stands still (Obs.pass). */
  pass?: PassBody;
  /** A passing robotaxi, or the road it claimed. */
  passing?: boolean;
}

interface ProbeResult {
  first: Hit | null;
  /** Nearest hit with a different id from `first` (for mutual-yield resolution). */
  second: Hit | null;
}

/** Look ahead along the route (from `routes`, the tick's route walks, when given) for obstacles this agent must yield to. */
function probe(
  g: RoadGraph,
  a: Readonly<AgentState>,
  hash: Map<number, Obs[]>,
  ignoreRobotaxis: boolean,
  scratch: Obs[],
  routes: Map<number, Route> | null = null,
): ProbeResult {
  const spec = AGENT_SPEC[a.kind];
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
    if (o.road && ignoreRobotaxis && o.passing !== true) continue;
    if (o.predicted && o.road === spec.road) continue;
    const dx = o.x - a.x;
    const dz = o.z - a.z;
    if (dx * dx + dz * dz > (reach + o.r) * (reach + o.r)) continue;
    if (dx * hx + dz * hz < -(spec.halfLength + o.r + 3)) continue; // well behind
    near.push(o);
  }
  if (near.length === 0) return { first: null, second: null };
  const route = routes ? routeOf(routes, g, a) : routeAhead(g, a);
  let si = 0;
  let base = 0; // distance already covered by earlier segments
  for (let d = start; d <= look; d += step) {
    // Advance to the segment containing distance d.
    let sg = segAt(route, si);
    while (sg && d - base > sg.path.len - sg.from) {
      base += Math.max(0, sg.path.len - sg.from);
      sg = segAt(route, ++si);
    }
    if (!sg) break;
    const { x: px, z: pz, tx, tz } = segPose(sg, sg.from + d - base);
    const q = { tx, tz };
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
      const hit: Hit = { gap, id: o.id, player: o.player, side, ...(o.pass ? { pass: o.pass } : {}), ...(o.passing ? { passing: true } : {}) };
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

/** A reserved turn is occupied only after its front crossed the line, or while clearing it. */
function enteredJunction(g: RoadGraph, a: Readonly<AgentState>, nodeId: string): boolean {
  if (a.node !== nodeId) return false;
  if (a.conn !== null) return true;
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return false;
  const edge = g.edges[ei]!;
  if (g.nodes[startNode(edge, a.dir)]!.id === nodeId) return true;
  if (g.nodes[endNode(edge, a.dir)]!.id !== nodeId) return false;
  const stop = basePath(edge, a).len - AGENT_SPEC[a.kind].halfLength - STOPLINE_M;
  return a.s > stop + 1e-6;
}

/** Stopping distance over the gap to the line, and slack (m), before amber counts as committed. */
const AMBER_STOP_FACTOR = 1.2;
const AMBER_STOP_SLACK_M = 0.3;

/**
 * v21: on amber, a robotaxi whose front cannot stop behind the line at its braking rate, and
 * that reaches the line before red at its speed, goes on, as a driver would; before v21 it
 * stopped dead in one tick wherever it was. A car braking along its stop curve never exceeds
 * the margin, so it cannot tip into "committed" in the last metre and meet red at the line.
 */
function committedOnAmber(g: RoadGraph, signals: TrafficSignalControls | undefined, tick: number, a: Readonly<AgentState>, nodeId: string): boolean {
  if (a.conn !== null || a.speed <= 0) return false;
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return false;
  const edge = g.edges[ei]!;
  if (g.nodes[endNode(edge, a.dir)]!.id !== nodeId) return false;
  const left = amberTicksLeft(signals, nodeId, a.edge, tick);
  if (left === 0) return false;
  const spec = AGENT_SPEC[a.kind];
  const gap = Math.max(0, basePath(edge, a).len - spec.halfLength - STOPLINE_M - a.s);
  const stopping = (a.speed * a.speed) / (2 * spec.decel);
  return stopping > gap * AMBER_STOP_FACTOR + AMBER_STOP_SLACK_M && gap <= a.speed * left * DT;
}

/** May this robotaxi drive into the junction at node id? (It holds it, or it won it this tick.) */
function mayEnter(c: Ctx, a: Readonly<AgentState>, nodeId: string, edgeId = a.edge): boolean {
  const hs = c.holders.get(nodeId);
  const aspect = signalAspect(c.signals, nodeId, edgeId, c.tick);
  const goesOn = c.amberCommit && committedOnAmber(c.g, c.signals, c.tick, a, nodeId);
  if (aspect !== null && aspect !== "green" && !goesOn) return enteredJunction(c.g, a, nodeId);
  if (hs) for (const h of hs) if (h.id === a.id) return true;
  return c.winners.has(a.id);
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

/** On a short link (SHORT_LINK_M), still holding the junction at its start (its tail is in it). */
function rearHold(g: RoadGraph, a: Readonly<AgentState>, signals?: TrafficSignalControls): boolean {
  if (a.node === "" || a.conn !== null) return false;
  const ei = g.edgeIndex.get(a.edge);
  if (ei === undefined) return false;
  const e = g.edges[ei]!;
  const ahead = g.nodes[endNode(e, a.dir)]!;
  return g.nodes[startNode(e, a.dir)]!.id === a.node && basePath(e, a).len < SHORT_LINK_M && (ahead.degree >= 3 || signals?.has(ahead.id) === true);
}

/** Whether a planned lane is a short link (SHORT_LINK_M) into another junction. */
function shortLink(g: RoadGraph, plan: Plan, signals?: TrafficSignalControls): boolean {
  const ahead = g.nodes[endNode(plan.edge, plan.dir)]!;
  return plan.path.len < SHORT_LINK_M && (ahead.degree >= 3 || signals?.has(ahead.id) === true);
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
  /** v20 static controllers; older replay versions retain all-way-stop behaviour. */
  signals: TrafficSignalControls | undefined;
  /** v21 amber dilemma zone (committedOnAmber); v20 replays keep the hard stop. */
  amberCommit: boolean;
  /** v26 (UNSTICK_VERSION): a stalled pass is dropped; a robot on foot steps aside for a vehicle. */
  unstick: boolean;
  /** v18 jam recovery relaxes priority, never physical vehicle clearance. */
  solidVehicles: boolean;
  world: World;
  g: RoadGraph;
  hash: Map<number, Obs[]>;
  /** The same obstacles, only those on foot (not predicted): what a robotaxi's berth is kept from. */
  footHash: Map<number, Obs[]>;
  /** Only the vehicle boxes walkers meet (players' cars, robotaxis' drawn bodies): what nearerVehicle checks. */
  boxHash: Map<number, Obs[]>;
  /** The route ahead of each agent this tick (routeAhead, once per agent: routeOf). */
  routes: Map<number, Route>;
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
  /** Ridden robotaxis (step.ts boards riders): their goal and whether the rider asked to stop. */
  rides: ReturnType<typeof ridesByAgent>;
  /** Robotaxis hailed by a player on foot: they pull up and wait (step.ts). */
  hailed: Map<number, number>;
  /** The tick being stepped to (pass re-checks are spread over PASS_RETRY_TICKS by id). */
  tick: number;
  /** Every vehicle (players' cars, robotaxis, service vehicles) and everyone on foot, for planning a pass. */
  vehicles: PassVehicle[];
  feet: PassFoot[];
}

/** A vehicle slower than this stands still for going round it, m/s. */
const PASS_STOPPED_MPS = 0.1;

/**
 * Is the road clear for robotaxi a to drive pass profile p on `lane` from arc length `from` to its
 * end? Every pose (PASS_POSE_STEP_M apart) keeps the body: out of buildings; PASS_TARGET_GAP_M
 * from the vehicle it goes round; PASS_VEHICLE_GAP_M from every other vehicle, a moving one where
 * it is predicted (straight on at its speed) from a second before to 1.5 s after the robotaxi
 * gets there; and its walkers' slow berth from everyone on foot, now and where they are
 * predicted when it gets there.
 */
function passClear(c: Ctx, a: Readonly<AgentState>, lane: Path, p: Readonly<PassState>, from: number): boolean {
  const spec = AGENT_SPEC[a.kind];
  const self = `a:${a.id}`;
  const ds: number[] = [];
  for (let d = Math.max(from, p.s0); d < p.s3; d += PASS_POSE_STEP_M) ds.push(d);
  ds.push(p.s3);
  const mid = pathPoint(lane, (Math.max(from, p.s0) + p.s3) / 2);
  const reach = (p.s3 - Math.max(from, p.s0)) / 2 + Math.abs(p.off) + ROBOTAXI_BODY.halfLength + 2;
  const tMax = passTime(p.s3 - a.s, spec.accel) + 1.5;
  const near = (x: number, z: number, extra: number): boolean => (x - mid.x) * (x - mid.x) + (z - mid.z) * (z - mid.z) <= (reach + extra) * (reach + extra);
  const vehicles = c.vehicles.filter((v) => v.key !== self && near(v.rect.x, v.rect.z, v.rect.hl + PASS_VEHICLE_GAP_M + Math.abs(v.speed) * tMax));
  const feet = c.feet.filter((f) => near(f.x, f.z, f.r + ROBOTAXI_SLOW_BERTH_CHILD_M + Math.sqrt(f.vx * f.vx + f.vz * f.vz) * tMax));
  for (const d of ds) {
    const q = passPose(lane, p, d);
    const heading = poseHeading(q);
    if (bodyBlocked(c.world, a.kind, q.x, q.z, heading)) return false;
    const body: Rect = { x: q.x, z: q.z, fx: q.hx, fz: q.hz, hl: ROBOTAXI_BODY.halfLength, hw: ROBOTAXI_BODY.halfWidth };
    const t = passTime(d - a.s, spec.accel);
    for (const v of vehicles) {
      if (v.key === p.target) {
        if (rectGap(body, v.rect) < PASS_TARGET_GAP_M) return false;
        continue;
      }
      if (Math.abs(v.speed) < PASS_STOPPED_MPS) {
        if (rectGap(body, v.rect) < PASS_VEHICLE_GAP_M) return false;
        continue;
      }
      for (const dt of [-1, 0, 0.75, 1.5]) {
        const tt = Math.max(0, t + dt);
        const moved: Rect = { ...v.rect, x: v.rect.x + v.rect.fx * v.speed * tt, z: v.rect.z + v.rect.fz * v.speed * tt };
        if (rectGap(body, moved) < PASS_VEHICLE_GAP_M) return false;
      }
    }
    for (const f of feet) {
      const berth = (f.child ? ROBOTAXI_SLOW_BERTH_CHILD_M : ROBOTAXI_SLOW_BERTH_M) + BERTH_SLACK_M + f.r;
      for (const tt of [0, t, t + 1]) {
        if (pointRectGap(f.x + f.vx * tt, f.z + f.vz * tt, body) < berth) return false;
      }
    }
  }
  return true;
}

/** How fast a robotaxi backs up to the standoff behind a vehicle standing still, m/s. */
const PASS_BACKUP_MPS = 0.8;

/**
 * May robotaxi a back up to arc length `s` on its lane? Its body there keeps PASS_VEHICLE_GAP_M
 * from every vehicle (a moving one now and a second on), its walkers' slow berth from everyone on
 * foot, and out of buildings.
 */
function backClear(c: Ctx, a: Readonly<AgentState>, lane: Path, s: number): boolean {
  const q = pathPoint(lane, s);
  const heading = datan2(q.tx, -q.tz);
  if (bodyBlocked(c.world, a.kind, q.x, q.z, heading)) return false;
  const body: Rect = { x: q.x, z: q.z, fx: q.tx, fz: q.tz, hl: ROBOTAXI_BODY.halfLength, hw: ROBOTAXI_BODY.halfWidth };
  const self = `a:${a.id}`;
  const reach = ROBOTAXI_BODY.halfLength + 20;
  for (const v of c.vehicles) {
    if (v.key === self || Math.abs(v.rect.x - q.x) > reach || Math.abs(v.rect.z - q.z) > reach) continue;
    for (const t of Math.abs(v.speed) < PASS_STOPPED_MPS ? [0] : [0, 0.5, 1]) {
      const moved: Rect = { ...v.rect, x: v.rect.x + v.rect.fx * v.speed * t, z: v.rect.z + v.rect.fz * v.speed * t };
      if (rectGap(body, moved) < PASS_VEHICLE_GAP_M) return false;
    }
  }
  for (const f of c.feet) {
    if (Math.abs(f.x - q.x) > reach || Math.abs(f.z - q.z) > reach) continue;
    const berth = (f.child ? ROBOTAXI_SLOW_BERTH_CHILD_M : ROBOTAXI_SLOW_BERTH_M) + BERTH_SLACK_M + f.r;
    if (pointRectGap(f.x, f.z, body) < berth || pointRectGap(f.x + f.vx, f.z + f.vz, body) < berth) return false;
  }
  return true;
}

/**
 * A pass round `target` (standing still ahead of robotaxi a on `lane`), or null when there is no
 * room or the road is not clear: the smaller offset that clears it inside the carriageway (left
 * first), the shortest ease-out that keeps every pose clear (passClear), easing back in
 * PASS_BEYOND_M past its front, all before the lane ends.
 */
function planPass(c: Ctx, a: Readonly<AgentState>, e: RoadEdgeInfo, lane: Path, target: PassBody): PassState | null {
  const span = rectOnPath(lane, target.rect);
  if (span.sMin <= a.s) return null;
  const end = lane.len - 1;
  const s2 = span.sMax + ROBOTAXI_BODY.halfLength + PASS_BEYOND_M;
  // Someone on foot: the robotaxis' walker berth (a child's wider one) and some more alongside.
  const side = target.foot ? (target.child ? ROBOTAXI_SLOW_BERTH_CHILD_M : ROBOTAXI_SLOW_BERTH_M) + PASS_FOOT_SLACK_M : PASS_SIDE_CLEAR_M;
  for (const off of passOffsets(span, ROBOTAXI_BODY.halfWidth, laneOffset(e, a.dir, a.lane), e.widthM / 2, side)) {
    for (const ramp of PASS_RAMPS_M) {
      const s1 = a.s + ramp;
      const hold = Math.max(s1, s2);
      const p: PassState = { off, s0: a.s, s1, s2: hold, s3: hold + ramp, commit: span.sMin - ROBOTAXI_BODY.halfLength - 0.5, target: target.key };
      if (p.s3 > end) break;
      if (passClear(c, a, lane, p, a.s)) return p;
    }
  }
  return null;
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
  const p = probe(c.g, a, c.hash, a.ghost > 0 && !c.solidVehicles, c.scratch, c.routes);
  c.probes.set(id, p);
  return p;
}

/** The route ahead of agent a (as of the previous tick), walked once per tick. */
function routeOf(routes: Map<number, Route>, g: RoadGraph, a: Readonly<AgentState>): Route {
  let r = routes.get(a.id);
  if (!r) {
    r = routeAhead(g, a);
    routes.set(a.id, r);
  }
  return r;
}

/** A walker never steps closer than this to a vehicle's body (a robotaxi's drawn one, a player's car), metres. */
export const WALKER_VEHICLE_GAP_M = 0.1;

/**
 * Would walker a's step to (x, z) bring its body within WALKER_VEHICLE_GAP_M of a vehicle's body
 * (a robotaxi's drawn body, a player's car, as of the previous tick), closer than it is now?
 */
function nearerVehicle(c: Ctx, a: Readonly<AgentState>, x: number, z: number): boolean {
  const r = AGENT_SPEC[a.kind].radius;
  queryHash(c.boxHash, x, z, OBS_RADIUS_MAX + r + 1, c.scratch);
  for (const o of c.scratch) {
    if (!o.box) continue;
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
function stepAgent(c: Ctx, a: AgentState, dt: number, movement?: ReturnType<typeof movementLimit>): AgentState | null {
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
  // Going round a stopped vehicle (overtake.ts): only on the lane it was planned on.
  let pass = spec.road && a.pass && a.conn === null ? a.pass : undefined;
  const pr = c.probes.get(a.id) ?? { first: null, second: null };
  let blocker = pr.first;
  if (blocker && !blocker.player) {
    const other = probeOf(c, blocker.id);
    const mutual = other !== undefined && other.first !== null && other.first.id === a.id;
    if (spec.road) {
      // Two robotaxis each blocking the other: one that holds a junction goes first (the other
      // is waiting for that junction anyway), otherwise the lower id. Never round a pass:
      // neither drives into the other there; the one meeting it waits short of its claim.
      if (mutual && c.road.has(blocker.id) && pass === undefined && blocker.passing !== true) {
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
  const speedCap = movement?.maxSpeed ?? Infinity;
  let cruise = Math.min(a.vmax * (movement?.scale ?? 1), speedCap);
  if (spec.road) cruise = Math.min(cruise, e.speedLimitMps * 1.1);
  let target = cruise;
  let limitedByObstacle = false;
  // A rider asked to get out, or the taxi is at their goal: stop here (in lane, as for a fare).
  const ride = c.rides.get(a.id);
  if ((ride && (ride.exitPending || arrived(ride, a.x, a.z))) || c.hailed.has(a.id)) target = 0;
  // Heading for a rider's goal: re-plan the next street while well short of the junction (never
  // once committed to it: claimed, on a connector, or close enough to be contending for it).
  if (spec.road && ride?.goal && a.conn === null && a.node === "" && cur.len - a.s > 15) {
    const [n, d, l] = chooseNext(g, e, a.dir, a.lane, true, a.rng, ride.goal);
    if (n !== a.next || d !== a.ndir) a = { ...a, next: n, ndir: d, nlane: l };
  }
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
      // Wait behind the line until this robotaxi may enter. Signals also gate jam recovery;
      // unsignalised intersections retain the existing all-way-stop priority.
      const node = g.nodes[endNode(e, a.dir)]!;
      if (((node.degree >= 3 && a.ghost === 0) || c.signals?.get(node.id)?.approaches.has(e.id)) && !mayEnter(c, a, node.id)) {
        const v = Math.sqrt(2 * spec.decel * Math.max(0, stopPoint(c, a, cur, node.id) - a.s));
        if (v < target) {
          target = v;
          limitedByObstacle = true;
        }
      }
    }
  }
  // v26: a pass that has eased back in behind the vehicle it was going round (aborted after its
  // commit point, or eased in short) and stands still blocked by it would wait forever: nothing
  // replans a robotaxi with a pass. Drop it (a step of under 0.3 m back onto its lane), so the
  // robotaxi waits, backs up and plans again.
  if (c.unstick && pass && a.speed < 0.05 && a.s > pass.s1 && blocker?.pass?.key === pass.target && blocker.gap < PASS_STANDOFF_M
    && Math.abs(passLat(pass, a.s)) < 0.3) pass = undefined;
  // Behind a vehicle standing still that it may go round: wait further back, room to ease out.
  const stoodStill = spec.road && pass === undefined && blocker !== null && blocker.pass !== undefined && Math.abs(blocker.pass.speed) < PASS_STOPPED_MPS;
  const gapMin = spec.road ? (stoodStill ? PASS_STANDOFF_M : ROBOTAXI_GAP_M) : WALKER_GAP_M;
  if (pass) target = Math.min(target, PASS_SPEED_MPS);
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

  if (spec.road && a.conn === null) {
    const passWait = blocker?.pass?.foot ? PASS_FOOT_WAIT_TICKS : PASS_WAIT_TICKS;
    if (pass === undefined && stoodStill && a.speed < 0.05 && a.wait >= passWait) {
      // Try before the first backup, even off this id's retry slot. Backing over a probe-sample
      // boundary can let it creep forward and reset wait before the scheduled slot ever arrives.
      if (a.wait < passWait + ticks || (c.tick + a.id) % PASS_RETRY_TICKS === 0) {
        // Waited behind a vehicle standing still: go round it if the road is clear (it sets off next tick).
        const planned = planPass(c, a, e, cur, blocker!.pass!);
        if (planned) return { ...a, pass: planned, speed: 0, mode: "yield", rng };
      }
      // Stopped too close to steer round it (it pulled up behind it while it still moved, or it
      // stopped right in front): back up along its lane to the standoff, while the way back is clear.
      const back = a.s - PASS_BACKUP_MPS * dt;
      if (blocker!.gap < PASS_STANDOFF_M - 0.3 && back >= 0 && backClear(c, a, cur, back)) {
        const q = pathPoint(cur, back);
        const heading = datan2(q.tx, -q.tz);
        return { ...a, x: q.x, y: meshGroundHeight(c.world, q.x, q.z), z: q.z, heading, pitch: bodyPitch(c.world, q.x, q.z, heading), s: back, speed: 0, wait: a.wait + ticks, mode: "yield", rng };
      }
    } else if (pass && a.s < pass.commit && (c.tick + a.id) % PASS_RETRY_TICKS === 0 && !passClear(c, a, cur, pass, a.s)) {
      // Not yet alongside and the road is no longer clear: ease back in behind it, and wait again.
      const now = passLat(pass, a.s);
      pass = Math.abs(now) < 0.05 ? undefined
        : { ...pass, off: now, s0: a.s - 1, s1: a.s, s2: a.s, s3: Math.min(cur.len - 0.5, a.s + Math.max(3, PASS_RAMPS_M[0]! * Math.abs(now / pass.off))), commit: a.s };
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
  speed = Math.min(speed, speedCap);
  if (speed < 0.02) speed = 0;

  // Advance along the route. A walker sidestepped off its line walks the offset line at its own
  // pace (roads.ts offsetAdvance: the outside of a bend is the longer way round), also over a hop
  // onto the next path, where s - len is then the distance still to walk. At lat 0 (and for
  // robotaxis) this is plain arc length.
  const paced = !spec.road && lat !== 0;
  let s = paced ? offsetAdvance(a.conn ? connectorPath(a.conn) : cur, a.s, lat, speed * dt) : a.s + speed * dt;
  const approachNode = g.nodes[endNode(e, a.dir)]!.id;
  if (spec.road && a.conn === null && c.signals?.get(approachNode)?.approaches.has(e.id) && !mayEnter(c, a, approachNode)) {
    // The braking curve can overshoot by a fraction of a timestep. Keep a red/amber
    // front behind its line, without moving a vehicle already beyond that line back.
    const line = stopPoint(c, a, cur, approachNode);
    if (s > line && s > a.s) { s = Math.max(a.s, line); speed = 0; }
  }
  let edge = a.edge;
  let dir = a.dir;
  let lane = a.lane;
  let conn = a.conn;
  let node = a.node;
  let next = a.next;
  let ndir = a.ndir;
  let nlane = a.nlane;
  let resume = a.resume;
  let trafficRoute = a.trafficRoute;
  if (spec.road && a.conn === null && (a.node === "" || rearHold(g, a, c.signals)) && c.winners.has(a.id)) {
    node = g.nodes[endNode(e, a.dir)]!.id; // claim the junction (letting go of the one behind)
  }
  let curEdge = e;
  let curPath = cur;
  let held = false;
  for (let hop = 0; hop < 4; hop++) {
    const len = conn ? connectorPath(conn).len : curPath.len;
    if (s < len) break;
    if (conn) {
      s = paced ? offsetAdvance(curPath, resume, lat, s - len) : s - len + resume;
      resume = 0;
      conn = null;
      // Walkers let go of the node at once; a robotaxi holds it until its tail is clear.
      if (!spec.road) node = "";
      continue;
    }
    if (spec.road) {
      const nd = g.nodes[endNode(curEdge, dir)]!;
      if (((nd.degree >= 3 && a.ghost === 0) || c.signals?.get(nd.id)?.approaches.has(curEdge.id)) && !mayEnter(c, a, nd.id, curEdge.id)) {
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
    if (paced) s = offsetAdvance(connectorPath(cp), 0, lat, s - len);
    else s -= len;
    resume = 0;
    node = g.nodes[endNode(curEdge, dir)]!.id;
    edge = plan.edge.id;
    dir = plan.dir;
    lane = plan.lane;
    conn = cp;
    curEdge = plan.edge;
    curPath = plan.path;
    // Admission routes are finite intentions fixed at spawn, never a moving-player destination.
    // Read-only input queue: only the successful output owns its consumed slice.
    if(trafficRoute?.[0]?.edge === edge && trafficRoute[0].dir === dir && trafficRoute[0].lane === lane) trafficRoute=trafficRoute.slice(1);
    const planned=trafficRoute?.[0];
    if(planned) { next=planned.edge; ndir=planned.dir; nlane=planned.lane; }
    else {
      const [n2, d2, l2, r2] = chooseNext(g, plan.edge, plan.dir, plan.lane, spec.road, rng, ride?.goal ?? null);
      next = n2; ndir = d2; nlane = l2; rng = r2;
    }
  }

  if (spec.road && conn === null && node !== "" && node === g.nodes[startNode(curEdge, dir)]!.id && s >= spec.halfLength + 1) {
    node = ""; // tail clear of the junction: release it
  }

  // Pose on the (possibly new) path; a pass ends once eased back in (or off its lane).
  if (pass && (conn !== null || curEdge !== e || s >= pass.s3)) pass = undefined;
  const path = conn ? connectorPath(conn) : curPath;
  let x: number;
  let z: number;
  let heading: number;
  if (pass) {
    const p = passPose(path, pass, s);
    x = p.x;
    z = p.z;
    heading = poseHeading(p);
    lat = passLat(pass, s);
  } else {
    const q = pathPoint(path, s);
    const o = offsetPoint(path, s, lat);
    x = o.x;
    z = o.z;
    heading = datan2(q.tx, -q.tz);
    if (spec.road) lat = 0;
  }

  // Blocked: stopped (robotaxi) or reduced to a shuffle (walker) by something in the way,
  // including something right in front that right of way says to ignore but cannot be
  // walked through.
  const pressed = pr.first !== null && pr.first.gap < 0.6;
  const blocked = (limitedByObstacle || held || pressed) && speed < (spec.road ? 0.05 : 0.35);
  const nextNode = g.nodes[endNode(e, a.dir)]!.id;
  const aspect = spec.road && a.conn === null && a.node !== nextNode ? signalAspect(c.signals, nextNode, e.id, c.tick) : null;
  // Regulatory waiting is not a jam. Reset its age so a long red cannot retire a car
  // or trigger ghost recovery on the first green. Real collision handling below stays active.
  const signalWaiting = aspect !== null && aspect !== "green";
  // A walker's wait only clears once it is really walking again (not inching along).
  let wait = signalWaiting ? 0 : blocked ? a.wait + ticks : spec.road || speed > 0.6 * cruise ? 0 : Math.max(0, a.wait - ticks);
  // On a safe lane (roads.ts LANE_SAFE_M) a robotaxi cannot touch a building: skip the check.
  const safe = spec.road && conn === null && pass === undefined && curEdge.laneSafe[dirIndex(dir)][lane] === true;
  if ((!safe && bodyBlocked(c.world, a.kind, x, z, heading)) || (!spec.road && nearerVehicle(c, a, x, z))) {
    // Refuse the move: stay put and wait. (A walker never steps or sidesteps closer than
    // WALKER_VEHICLE_GAP_M to a vehicle's body: the dodge counts that close as in its way.)
    wait = a.wait + ticks;
    // (A ridden taxi waits on: its rider is let out where it stands, never dropped with it.)
    if (spec.road && wait > ROBOTAXI_STUCK_TICKS && !ride) return null;
    if (!spec.road && wait > WALKER_TURN_TICKS) return turnAround(c, { ...a, rng });
    return { ...a, speed: 0, wait, mode: "wait", rng };
  }
  if (!spec.road && wait > WALKER_TURN_TICKS) return turnAround(c, { ...a, rng });

  let ghost = Math.max(0, a.ghost - ticks);
  if (spec.road && (aspect === null || aspect === "green") && pass === undefined && ghost === 0 && wait > GHOST_AFTER_TICKS && (!blocker || (!blocker.player && c.road.has(blocker.id) && blocker.passing !== true))) {
    ghost = GHOST_TICKS;
    wait = 0;
  }

  let mode: AgentMode = "go";
  if (speed < 0.05 && (limitedByObstacle || held)) {
    mode = spec.road && blocker && blocker.player && wait > 120 ? "honk" : "wait";
  } else if (limitedByObstacle && target < cruise * 0.9) mode = "yield";

  const out: AgentState = {
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
  if(trafficRoute?.length) out.trafficRoute=trafficRoute;
  else delete out.trafficRoute;
  if (pass) out.pass = pass;
  else delete out.pass;
  return out;
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
  const { x: px, z: pz } = offsetPoint(from, a.s, a.lat);
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

/**
 * An area's seeded budget for a kind, its density and cap scaled by `scale` (v11 city life: the
 * game composition scales them by district and hour, src/content/cityLife.ts; 1 elsewhere).
 */
function budget(seed: number, area: AreaRoads, kind: AgentKind, scale = 1): number {
  const spec = AGENT_SPEC[kind];
  const km = (spec.road ? area.driveLen : area.walkLen) / 1000;
  const u = hash32(seed, area.ax, area.az, AGENT_KINDS.indexOf(kind)) / 4294967296;
  return Math.min(Math.round(spec.cap * scale), Math.floor(km * spec.perKm * scale + u));
}

/** Density multipliers by kind, per player (sortedIds order): what populate scales each player's areas by. */
export type PopulationScales = ReadonlyArray<Readonly<Partial<Record<AgentKind, number>>>>;

/** state.ext.robots.density (the agents runtime's per-player city-life scales), in sortedIds order; empty without it. */
function populationScales(state: Readonly<SimState>): PopulationScales {
  const density = (state.ext.robots as { density?: Record<string, Partial<Record<AgentKind, number>>> } | undefined)?.density;
  if (!density) return [];
  return sortedIds(state.players).map((id) => density[id] ?? {});
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

/**
 * A new agent keeps at least this far from a vehicle's body (every player's car, parked or
 * driven, and every robotaxi's drawn body), or a new robotaxi's body from anyone on foot, metres:
 * the dodge's widest override clearance (0.6 m, src/sim/dodge.ts) and a little more, so nobody
 * appears inside or against a vehicle (a contact, or a leap out of it).
 */
export const SPAWN_VEHICLE_CLEAR_M = 0.7;

/** Distance from (px, pz) to a box centred at (x, z) facing (fx, fz) with half extents hl, hw (0 inside). */
function boxGap(px: number, pz: number, x: number, z: number, fx: number, fz: number, hl: number, hw: number): number {
  const ox = px - x;
  const oz = pz - z;
  const along = ox * fx + oz * fz;
  const lat = -ox * fz + oz * fx;
  const el = Math.max(0, (lat < 0 ? -lat : lat) - hw);
  const ef = Math.max(0, (along < 0 ? -along : along) - hl);
  return Math.sqrt(el * el + ef * ef);
}

/** Every player's car (driven, or parked while they are on foot): spawns keep clear of them. */
export interface CarSpot {
  x: number;
  z: number;
  fx: number;
  fz: number;
}

export function playerCars(state: Readonly<SimState>): CarSpot[] {
  return sortedIds(state.players).map((id) => {
    const c = state.players[id]!.car;
    return { x: c.x, z: c.z, fx: dsin(c.heading), fz: -dcos(c.heading) };
  });
}

/** Is a new agent of this kind at (x, z) facing (hx, hz) clear of every vehicle (and, a robotaxi, of everyone on foot) by SPAWN_VEHICLE_CLEAR_M? */
function spawnClearOfVehicles(kind: AgentKind, x: number, z: number, hx: number, hz: number, others: readonly AgentState[], cars: readonly CarSpot[]): boolean {
  const spec = AGENT_SPEC[kind];
  if (!spec.road) {
    const need = spec.radius + SPAWN_VEHICLE_CLEAR_M;
    for (const c of cars) if (boxGap(x, z, c.x, c.z, c.fx, c.fz, CAR.halfLength, CAR.halfWidth) < need) return false;
    for (const o of others) {
      if (!AGENT_SPEC[o.kind].road) continue;
      if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) > 64) continue;
      if (boxGap(x, z, o.x, o.z, dsin(o.heading), -dcos(o.heading), ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth) < need) return false;
    }
    return true;
  }
  // A robotaxi: its drawn body clear of every player's car (by both bodies' half diagonals) and of everyone on foot.
  const carDiag = Math.sqrt(CAR.halfLength * CAR.halfLength + CAR.halfWidth * CAR.halfWidth);
  const taxiDiag = Math.sqrt(ROBOTAXI_BODY.halfLength * ROBOTAXI_BODY.halfLength + ROBOTAXI_BODY.halfWidth * ROBOTAXI_BODY.halfWidth);
  const lim = carDiag + taxiDiag + 0.5;
  for (const c of cars) if ((c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) < lim * lim) return false;
  for (const o of others) {
    if (AGENT_SPEC[o.kind].road) continue;
    if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) > 64) continue;
    if (boxGap(o.x, o.z, x, z, hx, hz, ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth) < AGENT_SPEC[o.kind].radius + SPAWN_VEHICLE_CLEAR_M) return false;
  }
  return true;
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
  cars: readonly CarSpot[],
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
    if (!spawnClearOfVehicles(kind, q.x, q.z, q.tx, q.tz, others, cars)) continue;
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
  cars: readonly CarSpot[] = [],
  scales: PopulationScales = [],
  version: number = SIM_VERSION,
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
  // Each area is scaled by its owner's density (the nearest player's).
  const scaleOf = (ar: AreaRoads, kind: AgentKind): number => scales[nearestBody(bodies, ar.cx, ar.cz)]?.[kind] ?? 1;
  // v26: no ambient Trundles; Footmen take each area's Trundle budget, one for one, with its hour
  // and district shaping. Never in the initial fill (see the header, Population).
  const trundleFree = !initial && version >= TRUNDLE_FREE_VERSION;
  const areaWant = (ar: AreaRoads, kind: AgentKind): number => {
    if (!trundleFree) return budget(seed, ar, kind, scaleOf(ar, kind));
    if (kind === "sidewalkBot") return 0;
    const own = budget(seed, ar, kind, scaleOf(ar, kind));
    return kind === "errandRobot" ? own + budget(seed, ar, "sidewalkBot", scaleOf(ar, "sidewalkBot")) : own;
  };
  const room = new Map<AgentKind, number>();
  for (const kind of AGENT_KINDS) {
    let sum = 0;
    for (const { ar } of active) sum += areaWant(ar, kind);
    room.set(kind, sum - (totals.get(kind) ?? 0));
  }
  // City-life densities (game composition): a kind over its scaled budget (fewer people than the
  // base densities, or a district or hour that wants fewer) sheds its surplus out of every player's
  // view, the farthest first, at most TRIM_PER_POP per kind per population pass. Never in bare
  // step() (no scales), where wanderers between areas are no surplus.
  if (scales.length > 0 && !initial) {
    const drop = new Set<number>();
    for (const kind of AGENT_KINDS) {
      const surplus = Math.min(TRIM_PER_POP, -room.get(kind)!);
      if (surplus <= 0) continue;
      const out = list
        .filter((a) => a.kind === kind && (a.runtimeId === undefined || a.runtimeLegacy === true) && a.dodge === null && minDist2(bodies, a.x, a.z) > SPAWN_MIN_PLAYER_M * SPAWN_MIN_PLAYER_M)
        .sort((p, q) => minDist2(bodies, q.x, q.z) - minDist2(bodies, p.x, p.z) || p.id - q.id)
        .slice(0, surplus);
      for (const a of out) drop.add(a.id);
      room.set(kind, room.get(kind)! + out.length);
    }
    if (drop.size) {
      const kept = list.filter((a) => !drop.has(a.id));
      list.length = 0;
      list.push(...kept);
    }
  }
  const minPlayer = initial ? 6 : SPAWN_MIN_PLAYER_M;
  for (const { ar } of active) {
    const owner = nearestBody(bodies, ar.cx, ar.cz);
    for (const kind of AGENT_KINDS) {
      const want = areaWant(ar, kind);
      const have = counts.get(`${ar.key}|${kind}`) ?? 0;
      let add = Math.min(Math.max(0, want - have), Math.max(0, room.get(kind)!));
      if (!initial) add = Math.min(add, SPAWN_PER_POP);
      for (let i = 0; i < add && owned[owner]! < MAX_AGENTS && list.length < MAX_AGENTS_TOTAL; i++) {
        const [agent, r2] = trySpawn(world, g, ar, kind, r, nextId, list, bodies, minPlayer, cars);
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

interface CivilianApproach { edge: RoadEdgeInfo; dir: Dir; lane: number; s: number; score: number; route: TrafficLeg[] }

/** A finite connected road approach, extending upstream through short links as necessary. */
function civilianApproaches(world: World, body: Body): CivilianApproach[] {
  const graph=world.roads!;
  const edges=new Set<number>();
  for(const area of graph.areas) {
    const dx=area.cx-body.x,dz=area.cz-body.z;
    if(dx*dx+dz*dz < 350*350) for(const piece of area.drive) edges.add(piece.edge);
  }
  // RoadNode.out contains legal outgoing directions only, so reversing it loses one-way
  // predecessors. Index the legal directed incoming links themselves in this bounded area.
  const incomingByNode=new Map<number,{edge:number;dir:Dir}[]>();
  const ordered=[...edges].sort((a,b)=>a-b);
  for(const index of ordered) {
    const edge=graph.edges[index]!;
    for(const dir of [1,-1] as const) if(canDrive(edge,dir)) {
      const node=endNode(edge,dir),links=incomingByNode.get(node)??[];
      links.push({edge:index,dir});incomingByNode.set(node,links);
    }
  }
  const choices:CivilianApproach[]=[];
  for(const index of ordered) {
    const frontage=graph.edges[index]!;
    for(const dir of [1,-1] as const) {
      if(!canDrive(frontage,dir)) continue;
      for(let lane=0;lane<frontage.laneCount[dirIndex(dir)];lane++) {
        if(!frontage.laneClear[dirIndex(dir)][lane]) continue;
        const path=lanePath(frontage,dir,lane),near=projectOnPath(path,body.x,body.z);
        if(near.dist>35 || path.len-near.s<8) continue;
        let visited=0;
        const extend=(edge:RoadEdgeInfo,direction:Dir,slot:number,toS:number,after:number,route:TrafficLeg[],seen:ReadonlySet<number>):void=>{
          if(++visited>64) return;
          const current=lanePath(edge,direction,slot);
          for(const travel of [65,80,95,110,125]) {
            const s=toS-(travel-after);
            if(s<3 || s>toS) continue;
            const point=pathPoint(current,s),dx=point.x-body.x,dz=point.z-body.z,distance=Math.sqrt(dx*dx+dz*dz);
            if(distance<SPAWN_MIN_PLAYER_M || distance>100) continue;
            choices.push({edge,dir:direction,lane:slot,s,route:route.slice(1),score:near.dist*4+Math.abs(distance-65)+travel*.01});
          }
          if(route.length>=8 || after+toS>=125) return;
          const node=startNode(edge,direction);
          for(const link of incomingByNode.get(node)??[]) {
            const previous=graph.edges[link.edge]!,incoming=link.dir;
            if(seen.has(previous.index) || !canDrive(previous,incoming)) continue;
            for(let previousLane=0;previousLane<previous.laneCount[dirIndex(incoming)];previousLane++) {
              if(!previous.laneClear[dirIndex(incoming)][previousLane]) continue;
              const upstream=lanePath(previous,incoming,previousLane),join=connectorPath(makeConnector(upstream,current,.56));
              // A graph connection is not permission to cut a corner through a real building.
              let clear=true;
              for(let at=0;at<=join.len;at+=Math.max(1,join.len/8)) {
                const point=pathPoint(join,at);
                if(bodyBlocked(world,"robotaxi",point.x,point.z,datan2(point.tx,-point.tz))) {clear=false;break;}
              }
              if(!clear) continue;
              const leg={edge:previous.id,dir:incoming,lane:previousLane};
              extend(previous,incoming,previousLane,upstream.len,after+toS+join.len,[leg,...route],new Set([...seen,previous.index]));
            }
          }
        };
        extend(frontage,dir,lane,near.s,0,[{edge:frontage.id,dir,lane}],new Set([frontage.index]));
      }
    }
  }
  return choices.sort((a,b)=>a.score-b.score || a.route.length-b.route.length || a.edge.index-b.edge.index || b.dir-a.dir || a.lane-b.lane);
}

/** IDs whose current task or interaction must survive ambient population replacement. */
function protectedTrafficIds(state:Readonly<SimState>):ReadonlySet<number> {
  const protectedIds=new Set([...ridesByAgent(state).keys(),...hailsByAgent(state).keys()]);
  const runtime=state.ext.robots as unknown as {actors?:Record<string,{legacyId:number|null;numericId:number;significant?:boolean;ownerId?:string;model?:string}>;missionBindings?:Record<string,string>}|undefined;
  const bindings=runtime?.missionBindings??{},players=state.ext.player?.players??{},actors=runtime?.actors??{};
  const bound=new Set(sortedIds(bindings).map(id=>bindings[id]!));
  const watched=new Set(sortedIds(players).map(id=>players[id]!.watchingActorId).filter(Boolean));
  for(const id of sortedIds(actors)) {
    const actor=actors[id]!;
    if(actor.significant || actor.ownerId!==undefined || bound.has(id) || watched.has(id) || actor.model==="van" || actor.model==="bus") protectedIds.add(actor.legacyId??actor.numericId);
  }
  for(const agent of state.ext.agents?.list??[]) if(agent.manualCar || watched.has(agentActorId(agent.id)) || state.ext.combat?.targets[agentActorId(agent.id)]) protectedIds.add(agent.id);
  return protectedIds;
}

/** Admit an ordinary car every thirty simulation seconds when a safe connected approach has room. */
export function admitPassingCars(world: World, state: Readonly<SimState>, tick: number, ext: AgentsExt): AgentsExt {
  if (tick % CIVILIAN_PASS_INTERVAL_TICKS !== 0 || !world.roads) return ext;
  const graph=world.roads,bodies=playerBodies(state),cars=playerCars(state),protectedIds=protectedTrafficIds(state);
  if(!bodies.length) return ext;
  let list=ext.list.slice(),nextId=ext.nextId;
  for(let owner=0;owner<bodies.length;owner++) {
    const body=bodies[owner]!;
    if(list.filter(a=>{
      if(!isCivilianTraffic(a)) return false;
      const dx=a.x-body.x,dz=a.z-body.z;
      return dx*dx+dz*dz<100*100;
    }).length>=4) continue;
    for(const choice of civilianApproaches(world,body)) {
      const point=pathPoint(lanePath(choice.edge,choice.dir,choice.lane),choice.s),heading=datan2(point.tx,-point.tz);
      // The budget belongs to the owner of the admitted body, even near an ownership boundary.
      if(nearestBody(bodies,point.x,point.z)!==owner) continue;
      if(bodyBlocked(world,"robotaxi",point.x,point.z,heading)||!spawnClearOfVehicles("robotaxi",point.x,point.z,point.tx,point.tz,list,cars)) continue;
      if(list.some(other=>{
        const dx=other.x-point.x,dz=other.z-point.z,clear=AGENT_SPEC[other.kind].road?10:4;
        return dx*dx+dz*dz<clear*clear;
      })) continue;
      const ownerFull=list.filter(a=>nearestBody(bodies,a.x,a.z)===owner).length>=MAX_AGENTS;
      if(list.length>=MAX_AGENTS_TOTAL || ownerFull) {
        const removable=list.filter(a=>a.kind==="robotaxi"&&a.runtimeId===undefined&&a.runtimeLegacy!==true&&a.vehicle===undefined&&!protectedIds.has(a.id)
          &&(!ownerFull||nearestBody(bodies,a.x,a.z)===owner)&&minDist2(bodies,a.x,a.z)>150*150)
          .sort((a,b)=>minDist2(bodies,b.x,b.z)-minDist2(bodies,a.x,a.z)||a.id-b.id)[0];
        if(!removable) break;
        list=list.filter(a=>a.id!==removable.id);
      }
      while(nextId%8!==7) nextId++;
      const id=nextId++,rng=hash32(state.seed,id,tick),planned=choice.route[0];
      const [next,ndir,nlane,arng]=planned?[planned.edge,planned.dir,planned.lane,rng] as const:chooseNext(graph,choice.edge,choice.dir,choice.lane,true,rng);
      list.push({id,kind:"robotaxi",x:point.x,y:meshGroundHeight(world,point.x,point.z),z:point.z,heading,pitch:bodyPitch(world,point.x,point.z,heading),speed:0,vmax:10,
        edge:choice.edge.id,dir:choice.dir,lane:choice.lane,s:choice.s,next,ndir,nlane,conn:null,node:"",resume:0,lat:0,wait:0,dwell:0,ghost:0,mode:"go",rng:arng,dodge:null,
        ...(choice.route.length?{trafficRoute:choice.route}:{})});
      break;
    }
  }
  return {nextId,list:list.sort((a,b)=>a.id-b.id)};
}

/** Every vehicle and everyone on foot as of the previous tick, for planning passes (passClear). */
function passBodies(state: Readonly<SimState>, list: readonly AgentState[]): { vehicles: PassVehicle[]; feet: PassFoot[] } {
  const vehicles: PassVehicle[] = [];
  const feet: PassFoot[] = [];
  for (const id of sortedIds(state.players)) {
    const p = state.players[id]!;
    const c = p.car;
    vehicles.push({ key: `p:${id}`, id: -1, rect: rectAt(c.x, c.z, c.heading, CAR.halfLength, CAR.halfWidth), speed: c.speed });
    if (p.mode === "foot" && p.foot) {
      const f = p.foot;
      feet.push({ x: f.x, z: f.z, vx: dsin(f.heading) * f.speed, vz: -dcos(f.heading) * f.speed, r: FOOT.radius, child: false });
    }
  }
  for (const a of list) {
    if (AGENT_SPEC[a.kind].road) vehicles.push({ key: `a:${a.id}`, id: a.id, rect: vehicleRect(a), speed: a.speed });
    else feet.push({ x: a.x, z: a.z, vx: dsin(a.heading) * a.speed, vz: -dcos(a.heading) * a.speed, r: a.radius ?? AGENT_SPEC[a.kind].radius, child: a.child === true || (a.kind === "person" && personIsChild(a.id)) });
  }
  return { vehicles, feet };
}

/** Initial ambient population for a new state (empty when the world has no roads). */
export function initialAgents(world: World, state: Readonly<SimState>): { ext: AgentsExt; rng: RngState } {
  return populate(world, { nextId: 1, list: [] }, state.rng, playerBodies(state), state.seed, true, playerCars(state));
}

/**
 * Advance every agent one tick. Reads `prev` only (players and agents as of the previous
 * tick); returns the new agents and the new global RNG state.
 */
export function stepAgents(world: World, prev: Readonly<SimState>, tick: number, controlled: ReadonlySet<number> = new Set()): { ext: AgentsExt; rng: RngState } | null {
  const g = world.roads;
  if (!g) return null;
  const signals = prev.version >= 20 ? world.signals : undefined;
  const amberCommit = prev.version >= 21;
  let ext = (prev.ext[AGENTS_EXT_KEY] as AgentsExt | undefined) ?? { nextId: 1, list: [] };
  if (signals) {
    // A green winner can be held behind the stop line by a pedestrian. Its reservation
    // expires on amber/red; it must not block other phases or enter when the person moves.
    // Copy only when a reservation actually expires, leaving previous state untouched.
    let released: AgentState[] | undefined;
    for (let i = 0; i < ext.list.length; i++) {
      const a = ext.list[i]!;
      if (!AGENT_SPEC[a.kind].road || a.manualCar || a.node === "" || enteredJunction(g, a, a.node)) continue;
      const aspect = signalAspect(signals, a.node, a.edge, tick);
      if (aspect === null || aspect === "green") continue;
      if (amberCommit && committedOnAmber(g, signals, tick, a, a.node)) continue;
      released ??= ext.list.slice(); released[i] = { ...a, node: "" };
    }
    if (released) ext = { ...ext, list: released };
  }
  const bodies = playerBodies(prev);
  if (bodies.length === 0) return { ext, rng: prev.rng };
  // v26: ambient Trundles leave the street on the state's first step (the starting street drawn
  // while a new game loads still shows them). One diving out of a vehicle's way, or knocked flying,
  // goes once that is over; one a v25 save left in a story (rusting, seized, in a fight, bound to a
  // mission: protectedTrafficIds) once the story lets it go. No RNG is drawn.
  const trundleGoes = (a: Readonly<AgentState>): boolean => a.kind === "sidewalkBot" && a.dodge === null && a.knock === undefined;
  if (prev.version >= TRUNDLE_FREE_VERSION && ext.list.some(trundleGoes)) {
    const keep = protectedTrafficIds(prev);
    if (ext.list.some((a) => trundleGoes(a) && !keep.has(a.id))) ext = { ...ext, list: ext.list.filter((a) => !trundleGoes(a) || keep.has(a.id)) };
  }

  // Seized robotaxis stand where they stopped: others may go round them.
  const passable = new Set<number>();
  if (prev.ext.combat) {
    for (const a of ext.list) {
      if (!AGENT_SPEC[a.kind].road || a.runtimeId !== undefined) continue;
      const limit = movementLimit(prev.ext.combat, { id: `agent:${a.id}` });
      if (limit.maxSpeed === 0 || limit.scale <= 0) passable.add(a.id);
    }
  }
  const obs = [...playerObstacles(prev), ...agentObstacles(ext.list, g, passable)];
  const { hash, footHash, boxHash } = buildHashes(obs);
  const routes = new Map<number, Route>();

  // Who steps this tick, and by how much.
  const stepDt = new Map<number, number>();
  for (const a of ext.list) {
    if (controlled.has(a.id) || a.manualCar || a.runtimeId !== undefined) continue;
    const near = minDist2(bodies, a.x, a.z) <= NEAR_RANGE_M * NEAR_RANGE_M;
    if (near) stepDt.set(a.id, DT);
    else if ((tick + a.id) % LOD_STRIDE === 0) stepDt.set(a.id, DT * LOD_STRIDE);
  }

  // Look-ahead for everyone who steps (pass 1), so mutual blocks can be resolved fairly.
  const probes = new Map<number, ProbeResult>();
  const scratch: Obs[] = [];
  for (const a of ext.list) {
    if (!stepDt.has(a.id) || a.dwell > 0 || a.dodge !== null) continue;
    probes.set(a.id, probe(g, a, hash, a.ghost > 0 && prev.version < 18, scratch, routes));
  }

  // Junctions (nodes with 3+ streets): who holds each one (claimed at the line, crossing, or
  // with its tail still inside), and who may claim it this tick: longest wait first, then
  // lowest id, as long as its path through the junction keeps clear of every holder's.
  // Nobody enters toward a lane whose start is full (no blocking the box).
  const holders = new Map<string, Hold[]>();
  const fullStart = new Set<string>();
  // Short links (SHORT_LINK_M) by edge|dir that a robotaxi is on, turning onto, or holds the
  // junction at their start to come down: nobody enters one against such traffic.
  const linked = new Set<string>();
  for (const a of ext.list) {
    if (!AGENT_SPEC[a.kind].road || a.manualCar) continue;
    linked.add(`${a.edge}|${a.dir}`);
    if (a.node !== "" && a.conn === null) {
      const ei = g.edgeIndex.get(a.edge);
      if (ei !== undefined && g.nodes[endNode(g.edges[ei]!, a.dir)]!.id === a.node) {
        const plan = planNext(g, a);
        if (plan) linked.add(`${plan.edge.id}|${plan.dir}`);
      }
    }
    if (a.node !== "") {
      const ni = g.nodeIndex.get(a.node);
      if (ni !== undefined && (g.nodes[ni]!.degree >= 3 || signals?.has(a.node))) {
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
    if (!spec.road || a.manualCar) continue;
    // On a short link with its tail still in the junction behind (rearHold): it contends for the
    // junction ahead from wherever it waits, or it would hold the one behind while every other
    // approach takes the one ahead.
    const rear = rearHold(g, a, signals);
    if (a.node !== "" && !rear) continue;
    const rem = remainingOnPath(g, a);
    if (!rem) continue;
    const nd = g.nodes[rem.node]!;
    const aspect = signalAspect(signals, nd.id, a.edge, tick);
    if ((nd.degree < 3 || a.ghost > 0) && aspect === null) continue;
    if (rem.dist > spec.halfLength + STOPLINE_M + 9 && !rear) continue;
    let w = waiters.get(nd.id);
    if (!w) waiters.set(nd.id, (w = []));
    w.push({ a, path: plannedConnector(g, a) });
    if (aspect !== null && aspect !== "green" && !(amberCommit && committedOnAmber(g, signals, tick, a, nd.id))) continue;
    const dt = stepDt.get(a.id) ?? DT;
    if (rem.dist > spec.halfLength + STOPLINE_M + 1 + a.speed * dt && !(rear && a.speed < 0.05)) continue;
    const plan = planNext(g, a);
    if (plan && fullStart.has(`${plan.edge.id}|${plan.dir}|${plan.lane}`)) continue;
    // Down a short link against a robotaxi coming up it (or holding its far junction to): each
    // would hold the junction the other waits for, for good (Fillmore St between Retiro Way and
    // Marina Blvd, 15.7 m: the Fleet Week getaway jam, 2026-10-24).
    if (plan && shortLink(g, plan, signals) && linked.has(`${plan.edge.id}|${-plan.dir}`)) continue;
    let l = contenders.get(nd.id);
    if (!l) contenders.set(nd.id, (l = []));
    l.push(a);
  }
  const winners = new Set<number>();
  const entering = new Set<string>(); // short links winners turn onto this tick, by edge|dir
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
      const plan = planNext(g, a);
      const link = plan && shortLink(g, plan, signals) ? plan : null;
      if (link && entering.has(`${link.edge.id}|${-link.dir}`)) continue;
      if (!ok) continue;
      if (link) entering.add(`${link.edge.id}|${link.dir}`);
      winners.add(a.id);
      hs.push({ id: a.id, path, x: a.x, z: a.z, heading: a.heading });
    }
  }

  const holding = new Set<number>();
  const road = new Set<number>();
  for (const a of ext.list) {
    if (!AGENT_SPEC[a.kind].road || a.manualCar) continue;
    road.add(a.id);
    if (a.node !== "") holding.add(a.id);
  }
  const byId = new Map<number, AgentState>();
  for (const a of ext.list) byId.set(a.id, a);
  const rides = ridesByAgent(prev);
  const { vehicles, feet } = passBodies(prev, ext.list);
  const ctx: Ctx = { signals, amberCommit, unstick: prev.version >= UNSTICK_VERSION, solidVehicles: prev.version >= 18, world, g, hash, footHash, boxHash, routes, probes, byId, scratch, holders, holding, road, winners, tick, vehicles, feet, rides, hailed: hailsByAgent(prev) };
  const list: AgentState[] = [];
  for (const a of ext.list) {
    const dt = stepDt.get(a.id);
    // Not stepping this tick, or diving out of a vehicle's way (dodge.ts moves it).
    if (dt === undefined || a.dodge !== null) {
      list.push(a);
      continue;
    }
    const limit = prev.ext.combat ? movementLimit(prev.ext.combat, { id: a.runtimeId ?? agentActorId(a.id) }) : undefined;
    const n = stepAgent(ctx, a, dt, limit);
    if (!n) continue;
    // Out of view and stuck for good (a standoff in a tangle of real-world junctions): retire it.
    if (n.wait > STUCK_REMOVE_TICKS && !rides.has(n.id) && minDist2(bodies, n.x, n.z) > SPAWN_MIN_PLAYER_M * SPAWN_MIN_PLAYER_M) continue;
    list.push(n);
  }

  let out: AgentsExt = { nextId: ext.nextId, list };
  let rng = prev.rng;
  if (tick % POP_INTERVAL === 0) {
    // Claimed legacy bodies still occupy the ambient population budget. Counting
    // only unclaimed rows refills the same slots every population tick. They must
    // also obey the same distance cull: restoring every claimed body afterwards
    // leaves a trail of frozen pedestrians as the player travels across the city.
    const p = populate(world, out, rng, bodies, prev.seed, false, playerCars(prev), populationScales(prev), prev.version);
    out = p.ext;
    rng = p.rng;
  }
  out = admitPassingCars(world,prev,tick,out);
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
  const hash = buildHash([...playerObstacles(state), ...agentObstacles(ext.list, g)]);
  const pr = probe(g, a, hash, a.ghost > 0 && state.version < 18, []);
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
