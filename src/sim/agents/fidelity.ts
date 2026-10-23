// Simulation anchors are inputs recorded in the sim. Rendering has no authority here.
import type { RngState } from "../contract.ts";
import { hash32, seedRng } from "../rng.ts";
import { advanceSidewalkRoute } from "./navigation.ts";
import type { SidewalkCursor, SidewalkGraph, SidewalkRoute } from "./navigation.ts";

export const FULL_FIDELITY_M = 150;
export const ACTIVE_FIDELITY_M = 300;
export const SPAWN_SQUARE_M = 100;
export const AMBIENT_BUCKET_TICKS = 1800;
export const MAX_FIDELITY_ANCHORS = 24;
export const MAX_AMBIENT_PER_ANCHOR = 60;
export const MAX_AMBIENT_AGENTS = 800;
export const MAX_SIGNIFICANT_AGENTS = 2000;

export interface FidelityAnchor {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Temporary sim anchors, such as the Coit viewer, may use a smaller radius. */
  readonly radiusM?: number;
}

export interface SpawnSquare { readonly key: string; readonly sx: number; readonly sz: number }
export interface SquareEpoch extends SpawnSquare { readonly timeBucket: number }
export type PromotionReason = "wet" | "rusted" | "scanned" | "recruited" | "converted" | "mission";

export interface FidelityAgent {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly significant: boolean;
  readonly promotionReason: PromotionReason | null;
  readonly squareKey: string;
  readonly route: SidewalkRoute;
  readonly cursor: SidewalkCursor;
  readonly speedMps: number;
  readonly rng: RngState;
  readonly phaseTicks: number;
  readonly lastAdvancedTick: number;
}

export interface FidelityDecision {
  readonly tier: "full" | "active" | "abstract" | "despawn";
  readonly cadenceTicks: number;
  readonly run: boolean;
  readonly allowCombat: boolean;
  readonly allowConversion: boolean;
}

const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function requireTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("Invalid fidelity tick");
}

function requireWorldSeed(worldSeed: number): void {
  // Both signed and unsigned 32-bit seeds are used by existing sim RNG callers.
  if (!Number.isInteger(worldSeed) || worldSeed < -2147483648 || worldSeed > 4294967295) {
    throw new Error("Invalid fidelity world seed");
  }
}

function requireAgentPosition(agent: Pick<FidelityAgent, "x" | "z">): void {
  if (!Number.isFinite(agent.x) || !Number.isFinite(agent.z)) throw new Error("Invalid fidelity agent position");
}

function requireCursor(cursor: SidewalkCursor, route: SidewalkRoute): void {
  if (!Number.isSafeInteger(cursor.stepIndex) || cursor.stepIndex < 0 || cursor.stepIndex > route.steps.length ||
    !Number.isFinite(cursor.distanceM) || cursor.distanceM < 0 ||
    (cursor.stepIndex === route.steps.length && cursor.distanceM !== 0) ||
    !Number.isFinite(route.lengthM) || route.lengthM < 0) throw new Error("Invalid fidelity route cursor");
}

function requireAgent(agent: FidelityAgent): void {
  requireAgentPosition(agent);
  requireTick(agent.lastAdvancedTick);
  requireCursor(agent.cursor, agent.route);
  if (!Number.isSafeInteger(agent.phaseTicks) || agent.phaseTicks < 0 ||
    !Number.isFinite(agent.speedMps) || agent.speedMps < 0 ||
    agent.rng.length !== 4 || agent.rng.some((word) => !Number.isInteger(word) || word < 0 || word > 4294967295)) {
    throw new Error("Invalid fidelity agent state");
  }
}

function stringHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

function anchorRadius(anchor: FidelityAnchor): number {
  return Math.max(0, Math.min(ACTIVE_FIDELITY_M, anchor.radiusM ?? ACTIVE_FIDELITY_M));
}

const preparedAnchors = new WeakSet<ReadonlyArray<FidelityAnchor>>();

/** Immutable validated snapshot shared by all bodies in one simulation frame. */
export function prepareFidelityAnchors(anchors: ReadonlyArray<FidelityAnchor>): ReadonlyArray<FidelityAnchor> {
  if (preparedAnchors.has(anchors)) return anchors;
  const result = sortedAnchors(anchors).map(anchor => Object.freeze({ ...anchor }));
  Object.freeze(result);
  preparedAnchors.add(result);
  return result;
}

function sortedAnchors(anchors: ReadonlyArray<FidelityAnchor>): ReadonlyArray<FidelityAnchor> {
  if (preparedAnchors.has(anchors)) return anchors;
  if (anchors.length > MAX_FIDELITY_ANCHORS) throw new Error("Fidelity anchor capacity exceeded");
  const result = [...anchors].sort((a, b) => compareId(a.id, b.id));
  for (let i = 0; i < result.length; i++) {
    const anchor = result[i]!;
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.z) ||
      (anchor.radiusM !== undefined && !Number.isFinite(anchor.radiusM)) || result[i - 1]?.id === anchor.id) {
      throw new Error(`Invalid fidelity anchor: ${anchor.id}`);
    }
    const radius = anchorRadius(anchor);
    if (![anchor.x - radius, anchor.x + radius, anchor.z - radius, anchor.z + radius]
      .every((coordinate) => Number.isSafeInteger(Math.floor(coordinate / SPAWN_SQUARE_M)))) {
      throw new Error(`Fidelity anchor outside supported square range: ${anchor.id}`);
    }
  }
  return result;
}

function inAnchor(x: number, z: number, anchor: FidelityAnchor, limitM = anchorRadius(anchor)): boolean {
  const dx = x - anchor.x;
  const dz = z - anchor.z;
  return dx * dx + dz * dz <= limitM * limitM;
}

/** Full at <=150 m, scheduled active simulation at <=300 m, otherwise abstract or disposable. */
export function planFidelity(
  agent: Pick<FidelityAgent, "id" | "x" | "z" | "significant"> & { readonly phaseTicks?: number },
  anchors: ReadonlyArray<FidelityAnchor>, tick: number,
): FidelityDecision {
  requireTick(tick);
  requireAgentPosition(agent);
  if (agent.phaseTicks !== undefined && (!Number.isSafeInteger(agent.phaseTicks) || agent.phaseTicks < 0)) {
    throw new Error("Invalid fidelity phase");
  }
  let active = false;
  for (const anchor of sortedAnchors(anchors)) {
    if (inAnchor(agent.x, agent.z, anchor, Math.min(FULL_FIDELITY_M, anchorRadius(anchor)))) {
      return { tier: "full", cadenceTicks: 1, run: true, allowCombat: true, allowConversion: true };
    }
    active ||= inAnchor(agent.x, agent.z, anchor);
  }
  const tier = active ? "active" : agent.significant ? "abstract" : "despawn";
  const cadenceTicks = active ? 4 : agent.significant ? 60 : 0;
  const phase = agent.phaseTicks ?? stringHash(agent.id);
  return { tier, cadenceTicks, run: cadenceTicks > 0 && tick % cadenceTicks === phase % cadenceTicks,
    allowCombat: active, allowConversion: active };
}

/** Include each square intersecting any anchor disk once; no seam depends on anchor order. */
export function activeSpawnSquares(anchors: ReadonlyArray<FidelityAnchor>): SpawnSquare[] {
  const result = new Map<string, SpawnSquare>();
  for (const anchor of sortedAnchors(anchors)) {
    const radius = anchorRadius(anchor);
    for (let sx = Math.floor((anchor.x - radius) / SPAWN_SQUARE_M);
      sx <= Math.floor((anchor.x + radius) / SPAWN_SQUARE_M); sx++) {
      for (let sz = Math.floor((anchor.z - radius) / SPAWN_SQUARE_M);
        sz <= Math.floor((anchor.z + radius) / SPAWN_SQUARE_M); sz++) {
        const nearX = Math.max(sx * SPAWN_SQUARE_M, Math.min(anchor.x, (sx + 1) * SPAWN_SQUARE_M));
        const nearZ = Math.max(sz * SPAWN_SQUARE_M, Math.min(anchor.z, (sz + 1) * SPAWN_SQUARE_M));
        if (!inAnchor(nearX, nearZ, anchor)) continue;
        const key = `${sx},${sz}`;
        result.set(key, { key, sx, sz });
      }
    }
  }
  return [...result.keys()].sort(compareId).map((key) => result.get(key)!);
}

/** Positions and routes come from the world sidewalk graph, never arbitrary scatter positions. */
export interface AmbientPlacement {
  readonly squareKey: string;
  readonly slot: number;
  readonly x: number;
  readonly z: number;
  readonly route: SidewalkRoute;
  readonly cursor: SidewalkCursor;
  readonly speedMps: number;
}

export function seedAmbientAgent(
  square: SquareEpoch, placement: AmbientPlacement, worldSeed: number, tick: number,
): FidelityAgent {
  requireTick(tick);
  requireWorldSeed(worldSeed);
  if (!Number.isSafeInteger(square.sx) || !Number.isSafeInteger(square.sz) ||
    square.key !== `${square.sx},${square.sz}` || !Number.isSafeInteger(square.timeBucket) || square.timeBucket < 0) {
    throw new Error("Invalid ambient square epoch");
  }
  requireCursor(placement.cursor, placement.route);
  if (placement.squareKey !== square.key || !Number.isSafeInteger(placement.slot) || placement.slot < 0 ||
    !Number.isFinite(placement.x) || !Number.isFinite(placement.z) ||
    !Number.isFinite(placement.speedMps) || placement.speedMps < 0 ||
    Math.floor(placement.x / SPAWN_SQUARE_M) !== square.sx ||
    Math.floor(placement.z / SPAWN_SQUARE_M) !== square.sz) throw new Error("Invalid ambient placement");
  const seed = hash32(worldSeed, square.sx, square.sz, square.timeBucket, placement.slot);
  return { id: JSON.stringify(["ambient", worldSeed, square.key, square.timeBucket, placement.slot]),
    x: placement.x, z: placement.z, significant: false, promotionReason: null, squareKey: square.key,
    route: placement.route, cursor: { ...placement.cursor }, speedMps: placement.speedMps, rng: seedRng(seed),
    phaseTicks: seed % 60, lastAdvancedTick: tick };
}

export interface FidelityPopulation {
  readonly agents: ReadonlyArray<FidelityAgent>;
  readonly squares: ReadonlyArray<SquareEpoch>;
}

export interface PopulationHandoff {
  readonly population: FidelityPopulation;
  readonly spawnedIds: ReadonlyArray<string>;
  readonly despawnedIds: ReadonlyArray<string>;
}

/**
 * Only live square epochs are retained. Epochs survive time-bucket changes while a square
 * remains active; an interacting ambient agent must be promoted before it leaves the radius.
 * Ambient overlap counts against every covering anchor, bounding both local and global load.
 */
export function handoffFidelityPopulation(
  previous: FidelityPopulation, anchors: ReadonlyArray<FidelityAnchor>, tick: number,
  worldSeed: number, placements: ReadonlyArray<AmbientPlacement>,
): PopulationHandoff {
  requireTick(tick);
  requireWorldSeed(worldSeed);
  previous.agents.forEach(requireAgent);
  for (const square of previous.squares) {
    if (!Number.isSafeInteger(square.sx) || !Number.isSafeInteger(square.sz) ||
      square.key !== `${square.sx},${square.sz}` || !Number.isSafeInteger(square.timeBucket) || square.timeBucket < 0) {
      throw new Error("Invalid ambient square epoch");
    }
  }
  const orderedAnchors = sortedAnchors(anchors);
  const significant = previous.agents.filter((agent) => agent.significant);
  if (significant.length > MAX_SIGNIFICANT_AGENTS) throw new Error("Significant agent capacity exceeded");
  const oldEpochs = new Map(previous.squares.map((square) => [square.key, square]));
  const squares = activeSpawnSquares(orderedAnchors).map((square) =>
    oldEpochs.get(square.key) ?? { ...square, timeBucket: Math.floor(tick / AMBIENT_BUCKET_TICKS) });
  const epochs = new Map(squares.map((square) => [square.key, square]));
  const priorById = new Map(previous.agents.map((agent) => [agent.id, agent]));
  if (priorById.size !== previous.agents.length) throw new Error("Duplicate fidelity agent identity");
  const candidates = new Map<string, FidelityAgent>();
  for (const agent of previous.agents) {
    if (!agent.significant && planFidelity(agent, orderedAnchors, tick).tier !== "despawn") {
      candidates.set(agent.id, agent);
    }
  }
  const slots = new Set<string>();
  for (const placement of [...placements].sort((a, b) => compareId(a.squareKey, b.squareKey) || a.slot - b.slot)) {
    const slotId = JSON.stringify([placement.squareKey, placement.slot]);
    if (slots.has(slotId)) throw new Error("Duplicate ambient placement slot");
    slots.add(slotId);
    const square = epochs.get(placement.squareKey);
    if (!square) continue;
    const agent = seedAmbientAgent(square, placement, worldSeed, tick);
    if (priorById.get(agent.id)?.significant || candidates.has(agent.id)) continue;
    if (planFidelity(agent, orderedAnchors, tick).tier !== "despawn") candidates.set(agent.id, agent);
  }
  const counts = orderedAnchors.map(() => 0);
  const ambient: FidelityAgent[] = [];
  for (const id of [...candidates.keys()].sort(compareId)) {
    if (ambient.length === MAX_AMBIENT_AGENTS) break;
    const agent = candidates.get(id)!;
    const covering = orderedAnchors.map((anchor, i) => inAnchor(agent.x, agent.z, anchor) ? i : -1).filter((i) => i >= 0);
    if (covering.some((i) => counts[i]! >= MAX_AMBIENT_PER_ANCHOR)) continue;
    covering.forEach((i) => { counts[i] = counts[i]! + 1; });
    ambient.push(agent);
  }
  const agents = [...significant, ...ambient].sort((a, b) => compareId(a.id, b.id));
  const nextIds = new Set(agents.map((agent) => agent.id));
  return { population: { agents, squares },
    spawnedIds: agents.filter((agent) => !priorById.has(agent.id)).map((agent) => agent.id),
    despawnedIds: previous.agents.filter((agent) => !nextIds.has(agent.id)).map((agent) => agent.id).sort(compareId) };
}

export interface PromotionResult {
  readonly population: FidelityPopulation;
  readonly status: "promoted" | "already-significant" | "not-found" | "capacity";
}

/** Promotion preserves identity, route progress, RNG stream, speed and scheduling phase. */
export function promoteAmbientAgent(
  population: FidelityPopulation, id: string, reason: PromotionReason,
): PromotionResult {
  const agent = population.agents.find((value) => value.id === id);
  if (!agent) return { population, status: "not-found" };
  if (agent.significant) return { population, status: "already-significant" };
  if (population.agents.filter((value) => value.significant).length >= MAX_SIGNIFICANT_AGENTS) {
    return { population, status: "capacity" };
  }
  return { population: { ...population, agents: population.agents.map((value) => value.id === id ?
    { ...value, significant: true, promotionReason: reason } : value).sort((a, b) => compareId(a.id, b.id)) }, status: "promoted" };
}

/** Abstract travel follows the same graph and has no combat, conversion, or perception effects. */
export function advanceAbstractAgent(graph: SidewalkGraph, agent: FidelityAgent, tick: number): FidelityAgent {
  requireTick(tick);
  requireAgent(agent);
  if (!agent.significant || !Number.isInteger(tick) || tick < agent.lastAdvancedTick) {
    throw new Error("Invalid abstract advance");
  }
  const travel = advanceSidewalkRoute(graph, agent.route, agent.cursor, agent.speedMps * (tick - agent.lastAdvancedTick) / 60);
  return { ...agent, x: travel.point.x, z: travel.point.z, cursor: travel.cursor, lastAdvancedTick: tick };
}
