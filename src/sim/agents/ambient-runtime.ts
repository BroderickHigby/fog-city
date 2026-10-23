// Disposable population provenance. Numeric IDs identify a live incarnation; the tuple
// (world seed, 100 m square, visit epoch, slot) identifies its repeatable phenotype.
import { AGENT_SPEC, ROBOTAXI_BODY, type AgentKind, type AgentState } from "../agents.ts";
import { circleHitsWall } from "../boundary.ts";
import { boxBlocked } from "../collide.ts";
import { sortedIds, type SimState } from "../contract.ts";
import { datan2, dcos, dsin } from "../dmath.ts";
import { hash32 } from "../rng.ts";
import { lanePath, pathPoint, projectOnPath, walkPath, type Dir, type Path, type RoadEdgeInfo } from "../roads.ts";
import { circleBlockedBand, meshGroundHeight, type World } from "../world.ts";
import { activeSpawnSquares, AMBIENT_BUCKET_TICKS, MAX_AMBIENT_AGENTS, MAX_AMBIENT_PER_ANCHOR, SPAWN_SQUARE_M, type FidelityAnchor, type SquareEpoch } from "./fidelity.ts";
import type { SidewalkGraph } from "./navigation.ts";
import { IDLE_REACTION } from "./reactions.ts";
import type { RuntimeWalkerTrack } from "./runtime-spatial.ts";
import type { RuntimePhysicalBody } from "./runtime-state.ts";

export interface RuntimeAmbientProfile {
  readonly id: number;
  readonly key: string;
  readonly squareKey: string;
  readonly slot: number;
  readonly timeBucket: number;
  readonly seed: number;
  readonly firmware: "good" | "bad" | "none";
  readonly phaseTicks: number;
}
export interface RuntimeAmbientState {
  readonly version: 1;
  readonly squares: readonly SquareEpoch[];
  /** Compact provenance only; phenotype and canonical key derive from the world seed. */
  readonly profiles: readonly { readonly id: number; readonly origin: readonly [number, number, number, number] }[];
  /** Bounded scan cursor, not a random stream or a historical identity registry. */
  readonly cursor: number;
}
export const AMBIENT_SLOTS_PER_SQUARE = 8;
export const AMBIENT_ATTEMPTS_PER_TICK = 32;
export const AMBIENT_SPAWNS_PER_TICK = 8;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function readAmbientState(value: unknown): RuntimeAmbientState | null {
  if (value === undefined || value === null) return null;
  const state = object(value);
  if (state?.version !== 1 || !Number.isSafeInteger(state.cursor) || (state.cursor as number) < 0 ||
      !Array.isArray(state.squares) || !Array.isArray(state.profiles) || state.squares.length > 1600 || state.profiles.length > 2800) throw new Error("Invalid ambient provenance state");
  const keys = new Set<string>(), ids = new Set<number>(), profiles = new Set<string>();
  for (const raw of state.squares) {
    const square = object(raw);
    if (!square || !Number.isSafeInteger(square.sx) || !Number.isSafeInteger(square.sz) || square.key !== `${square.sx},${square.sz}` ||
        !Number.isSafeInteger(square.timeBucket) || (square.timeBucket as number) < 0 || keys.has(square.key as string)) throw new Error("Invalid ambient square");
    keys.add(square.key as string);
  }
  for (const raw of state.profiles) {
    const profile = object(raw);
    if (!profile || !Number.isSafeInteger(profile.id) || (profile.id as number) < 0 || ids.has(profile.id as number) ||
        !Array.isArray(profile.origin) || profile.origin.length !== 4 || !profile.origin.every(Number.isSafeInteger) ||
        profile.origin[2] < 0 || profile.origin[3] < 0 || profile.origin[3] >= AMBIENT_SLOTS_PER_SQUARE ||
        profiles.has(JSON.stringify(profile.origin))) throw new Error("Invalid ambient profile");
    ids.add(profile.id as number); profiles.add(JSON.stringify(profile.origin));
  }
  return state as unknown as RuntimeAmbientState;
}

export function ambientProfilesOf(state: Readonly<SimState>): readonly RuntimeAmbientProfile[] {
  return expandAmbientProfiles(readAmbientState(object(object(state.ext.agents)?.runtime)?.ambient), state.seed);
}

export function expandAmbientProfiles(state: RuntimeAmbientState | null, worldSeed: number): RuntimeAmbientProfile[] {
  return (state?.profiles ?? []).map(({ id, origin: [sx, sz, timeBucket, slot] }) => {
    const squareKey = `${sx},${sz}`, seed = hash32(worldSeed, sx, sz, timeBucket, slot);
    return { id, key: JSON.stringify(["ambient", worldSeed, squareKey, timeBucket, slot]), squareKey, slot, timeBucket, seed,
      firmware: slot !== 7 && slot % 2 === 0 ? "none" : hash32(seed, 4) % 100 < 35 ? "bad" : "good", phaseTicks: seed % 60 };
  });
}

interface SpawnPiece { edge: RoadEdgeInfo; path: Path; dir: Dir; lane: number; road: boolean; start: number; end: number }
const indices = new WeakMap<World, ReadonlyMap<string, readonly SpawnPiece[]>>();

/** Split actual paths at grid boundaries; sampling a cell never borrows a neighbour's road. */
function spawnIndex(world: World): ReadonlyMap<string, readonly SpawnPiece[]> {
  const cached = indices.get(world); if (cached) return cached;
  const result = new Map<string, SpawnPiece[]>();
  const add = (piece: Omit<SpawnPiece, "start" | "end">): void => {
    const path = piece.path;
    for (let i = 1; i < path.xs.length; i++) {
      const ax = path.xs[i - 1]!, az = path.zs[i - 1]!, bx = path.xs[i]!, bz = path.zs[i]!;
      const cuts = [0, 1];
      for (const [a, b] of [[ax, bx], [az, bz]]) {
        if (a === b) continue;
        for (let grid = Math.floor(Math.min(a!, b!) / SPAWN_SQUARE_M) + 1; grid * SPAWN_SQUARE_M < Math.max(a!, b!); grid++) {
          cuts.push((grid * SPAWN_SQUARE_M - a!) / (b! - a!));
        }
      }
      cuts.sort((a, b) => a - b);
      for (let j = 1; j < cuts.length; j++) {
        const from = cuts[j - 1]!, to = cuts[j]!; if (to - from < 1e-10) continue;
        const middle = (from + to) / 2;
        const key = `${Math.floor((ax + (bx - ax) * middle) / SPAWN_SQUARE_M)},${Math.floor((az + (bz - az) * middle) / SPAWN_SQUARE_M)}`;
        const segment = path.cum[i]! - path.cum[i - 1]!;
        const value = { ...piece, start: path.cum[i - 1]! + segment * from, end: path.cum[i - 1]! + segment * to };
        if (value.end - value.start < 0.05) continue;
        const list = result.get(key) ?? []; list.push(value); result.set(key, list);
      }
    }
  };
  for (const edge of [...(world.roads?.edges ?? [])].sort((a, b) => compare(a.id, b.id))) {
    if (edge.walkable) for (const side of [1, -1]) {
      const index = side === 1 ? 0 : 1;
      if (edge.walkClear[0][index] && edge.walkClear[1][index]) add({ edge, path: walkPath(edge, 1, side), dir: 1, lane: side, road: false });
    }
    if (edge.drivable) for (const dir of [1, -1] as const) {
      const index = dir === 1 ? 0 : 1;
      for (let lane = 0; lane < edge.laneCount[index]; lane++) if (edge.laneSafe[index][lane]) {
        add({ edge, path: lanePath(edge, dir, lane), dir, lane, road: true });
      }
    }
  }
  indices.set(world, result); return result;
}

function covered(point: { x: number; z: number }, anchor: FidelityAnchor): boolean {
  const radius = Math.max(0, Math.min(300, anchor.radiusM ?? 300));
  const dx = point.x - anchor.x, dz = point.z - anchor.z;
  return dx * dx + dz * dz <= radius * radius;
}

function safeSpawn(world: World, actor: AgentState, state: Readonly<SimState>, others: readonly AgentState[], extras: readonly RuntimePhysicalBody[]): boolean {
  const spec = AGENT_SPEC[actor.kind], road = spec.road;
  const radius = road ? Math.sqrt(ROBOTAXI_BODY.halfLength * ROBOTAXI_BODY.halfLength + ROBOTAXI_BODY.halfWidth * ROBOTAXI_BODY.halfWidth) : spec.radius;
  if (road ? boxBlocked(world, { x: actor.x, z: actor.z, heading: actor.heading, hl: ROBOTAXI_BODY.halfLength, hw: ROBOTAXI_BODY.halfWidth }, actor.y, [], actor.y + ROBOTAXI_BODY.height) :
    circleBlockedBand(world, actor.x, actor.z, radius, actor.y + 0.2, actor.y + 1.8) || circleHitsWall(world.walls ?? null, actor.x, actor.z, radius)) return false;
  const clear = (point: { x: number; y: number; z: number }, r: number): boolean => {
    if (Math.abs(point.y - actor.y) > 3) return true;
    const dx = point.x - actor.x, dz = point.z - actor.z, gap = radius + r + 0.8;
    return dx * dx + dz * dz >= gap * gap;
  };
  for (const id of sortedIds(state.players)) {
    const player = state.players[id]!, point = player.mode === "foot" && player.foot ? player.foot : player.car;
    const dx = point.x - actor.x, dz = point.z - actor.z;
    if (dx * dx + dz * dz < 20 * 20 || !clear(player.car, 3) || (player.mode === "foot" && player.foot && !clear(player.foot, 0.4))) return false;
  }
  for (const other of others) {
    const shape = AGENT_SPEC[other.kind];
    if (!clear(other, shape.road ? 2.7 : shape.radius)) return false;
  }
  for (const body of extras) if (!clear(body, body.kind === "vehicle" ? Math.sqrt(body.halfLength * body.halfLength + body.halfWidth * body.halfWidth) : body.radius)) return false;
  return true;
}

const graphRoadEdges = new WeakMap<SidewalkGraph, ReadonlyMap<string, readonly SidewalkGraph["edges"][number][]>>();
function freshTrack(graph: SidewalkGraph, actor: AgentState, profile: RuntimeAmbientProfile, tick: number): RuntimeWalkerTrack {
  let roadEdges = graphRoadEdges.get(graph);
  if (!roadEdges) {
    const next = new Map<string, SidewalkGraph["edges"][number][]>();
    for (const edge of graph.edges) if (edge.kind === "sidewalk" && edge.roadId !== null) { const list = next.get(edge.roadId) ?? []; list.push(edge); next.set(edge.roadId, list); }
    roadEdges = next; graphRoadEdges.set(graph, next);
  }
  let best: { edge: SidewalkGraph["edges"][number]; s: number; distance: number } | null = null;
  for (const edge of roadEdges.get(actor.edge) ?? []) {
    const projection = projectOnPath(edge.path, actor.x, actor.z);
    if (!best || projection.dist < best.distance || (projection.dist === best.distance && compare(edge.id, best.edge.id) < 0)) best = { edge, s: projection.s, distance: projection.dist };
  }
  const base = { id: actor.id, goalKey: "", decisions: 0, phaseTicks: profile.phaseTicks, lastTick: tick, reaction: IDLE_REACTION };
  if (!best || best.distance > 0.05) return { ...base, route: null, cursor: { stepIndex: 0, distanceM: 0 }, joining: true };
  const point = pathPoint(best.edge.path, best.s);
  const reverse = point.tx * dsin(actor.heading) - point.tz * dcos(actor.heading) < 0;
  const step = { edgeId: best.edge.id, from: reverse ? best.edge.b : best.edge.a, to: reverse ? best.edge.a : best.edge.b, reverse };
  return { ...base, route: { nodeIds: [step.from, step.to], steps: [step], lengthM: best.edge.path.len }, cursor: { stepIndex: 0, distanceM: reverse ? best.edge.path.len - best.s : best.s }, joining: false };
}

export interface AmbientRuntimeInput {
  world: World; state: Readonly<SimState>; previous: RuntimeAmbientState | null;
  anchors: readonly FidelityAnchor[]; actors: readonly AgentState[]; significant: ReadonlySet<number>;
  extras: readonly RuntimePhysicalBody[]; nextId: number; ambientLimit: number; reserved: readonly { x: number; z: number }[];
  navigation: SidewalkGraph;
}
export interface AmbientRuntimeResult { state: RuntimeAmbientState; actors: AgentState[]; freshIds: number[]; freshTracks: RuntimeWalkerTrack[]; nextId: number }

export function stepAmbientRuntime(input: AmbientRuntimeInput): AmbientRuntimeResult {
  const { world, state, anchors } = input;
  const old = input.previous;
  const oldSquares = new Map(old?.squares.map(square => [square.key, square]) ?? []);
  const squares = activeSpawnSquares(anchors).map(square => oldSquares.get(square.key) ?? { ...square, timeBucket: Math.floor(state.tick / AMBIENT_BUCKET_TICKS) });
  const live = new Set(input.actors.map(actor => actor.id));
  const profiles = (old?.profiles ?? []).filter(profile => live.has(profile.id));
  const keys = new Set(expandAmbientProfiles(old, state.seed).filter(profile => live.has(profile.id)).map(profile => profile.key));
  const actors = [...input.actors], freshIds: number[] = [], freshTracks: RuntimeWalkerTrack[] = [];
  const counts = anchors.map(anchor => [...actors.filter(actor => !input.significant.has(actor.id)), ...input.reserved].filter(point => covered(point, anchor)).length);
  let ambientCount = actors.filter(actor => !input.significant.has(actor.id)).length + input.reserved.length;
  const limit = Math.max(0, Math.min(MAX_AMBIENT_AGENTS, Math.floor(input.ambientLimit)));
  const sameSquares = old?.squares.length === squares.length && squares.every((square, i) => old.squares[i]?.key === square.key);
  let nextId = input.nextId, cursor = sameSquares ? old?.cursor ?? 0 : 0;
  const total = squares.length * AMBIENT_SLOTS_PER_SQUARE, index = spawnIndex(world);
  for (let attempt = 0; total > 0 && attempt < Math.min(total, AMBIENT_ATTEMPTS_PER_TICK) && freshIds.length < AMBIENT_SPAWNS_PER_TICK && ambientCount < limit; attempt++) {
    const current = cursor % total; cursor = (current + 1) % total;
    const square = squares[Math.floor(current / AMBIENT_SLOTS_PER_SQUARE)]!, slot = current % AMBIENT_SLOTS_PER_SQUARE;
    const key = JSON.stringify(["ambient", state.seed, square.key, square.timeBucket, slot]);
    if (keys.has(key)) continue;
    const seed = hash32(state.seed, square.sx, square.sz, square.timeBucket, slot);
    const kind: AgentKind = slot === 7 ? "robotaxi" : slot % 2 === 0 ? "person" : slot % 4 === 1 ? "errandRobot" : "sidewalkBot";
    const spec = AGENT_SPEC[kind];
    const pieces = (index.get(square.key) ?? []).filter(piece => piece.road === spec.road);
    const length = pieces.reduce((sum, piece) => sum + piece.end - piece.start, 0);
    if (length <= 0) continue;
    let distance = (hash32(seed, 1) + 0.5) / 4294967296 * length, selected = pieces[pieces.length - 1]!;
    for (const piece of pieces) { if (distance < piece.end - piece.start) { selected = piece; break; } distance -= piece.end - piece.start; }
    const s = selected.start + Math.min(selected.end - selected.start - 1e-7, Math.max(1e-7, distance));
    const point = pathPoint(selected.path, s);
    if (Math.floor(point.x / SPAWN_SQUARE_M) !== square.sx || Math.floor(point.z / SPAWN_SQUARE_M) !== square.sz) continue;
    const coveredIndices = anchors.map((anchor, i) => covered(point, anchor) ? i : -1).filter(i => i >= 0);
    if (!coveredIndices.length || coveredIndices.some(i => counts[i]! >= MAX_AMBIENT_PER_ANCHOR) || nextId >= Number.MAX_SAFE_INTEGER) continue;
    const actor: AgentState = { id: nextId, identitySeed: seed, kind, x: point.x, y: meshGroundHeight(world, point.x, point.z), z: point.z, heading: datan2(point.tx, -point.tz), pitch: 0,
      speed: 0, vmax: spec.vmin + (spec.vmax - spec.vmin) * hash32(seed, 2) / 4294967296,
      edge: selected.edge.id, dir: selected.dir, lane: selected.lane, s, next: "", ndir: selected.dir, nlane: selected.lane,
      conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: hash32(seed, 3), dodge: null };
    if (!safeSpawn(world, actor, state, actors, input.extras)) continue;
    const profile: RuntimeAmbientProfile = { id: nextId, key, squareKey: square.key, slot, timeBucket: square.timeBucket, seed,
      firmware: kind === "person" ? "none" : hash32(seed, 4) % 100 < 35 ? "bad" : "good", phaseTicks: seed % 60 };
    actors.push(actor); profiles.push({ id: profile.id, origin: [square.sx, square.sz, square.timeBucket, slot] }); keys.add(key); freshIds.push(nextId++); ambientCount++;
    for (const i of coveredIndices) counts[i] = counts[i]! + 1;
    if (!spec.road) freshTracks.push(freshTrack(input.navigation, actor, profile, Math.max(0, state.tick - 1)));
  }
  return { state: { version: 1, squares, profiles: profiles.sort((a, b) => a.id - b.id), cursor: total > 0 ? cursor % total : 0 }, actors, freshIds, freshTracks, nextId };
}
