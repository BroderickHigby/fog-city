import { TICK_HZ } from "../contract.ts";
import { hashState } from "../serialize.ts";

/** Finale decisions request movement/effects. The body owner still applies final clearance. */
export type FinaleKind = "walker" | "elizabeth";
export type FinalePhase = "patrol" | "entrance" | "march" | "pitch" | "bridge" | "reveal";
export interface FinalePoint { readonly x: number; readonly z: number }
export type FinaleFootprint =
  | { readonly kind: "circle"; readonly radius: number }
  | { readonly kind: "polygon"; readonly vertices: readonly (readonly [number, number])[] };
export interface FinaleWaypoint extends FinalePoint {
  readonly id: string;
  readonly phase: FinalePhase;
  /** Actual foot geometry, relative to this waypoint; not a centre-point proxy. */
  readonly footprint: FinaleFootprint;
  readonly windupTicks: number;
  readonly shedRobots: number;
}
export interface FinaleRoute { readonly id: string; readonly waypoints: readonly FinaleWaypoint[] }
export interface ProtectedFinaleBody extends FinalePoint { readonly id: string; readonly kind: "person" | "animal"; readonly radius: number }
export interface FinaleCoverage {
  readonly tick: number;
  /** True only after the body owner enumerates every person/animal in the swept footprint. */
  readonly complete: boolean;
  readonly bodies: readonly ProtectedFinaleBody[];
}
export interface FinaleRustHit {
  /** Stable combat emitter (normally a player ID), not a new ID per particle. */
  readonly sourceId: string;
  readonly sequence: number;
  readonly weakPointId: string;
  /** Authoritative combat result, after range/LOS/water checks. */
  readonly rust: number;
}
export interface FinaleLandingAck extends FinalePoint {
  readonly requestId: string;
  readonly tick: number;
  /** Set only after physical landing and the body's final clearance pass. */
  readonly clear: boolean;
}
export interface FinaleEffectAck { readonly id: string; readonly tick: number }
export type FinaleEffect =
  | { readonly kind: "impact"; readonly id: string; readonly waypointId: string; readonly x: number; readonly z: number; readonly footprint: FinaleFootprint }
  | { readonly kind: "shed-robots"; readonly id: string; readonly count: number; readonly x: number; readonly z: number }
  | { readonly kind: "restore-robots"; readonly id: string; readonly robotIds: readonly string[] }
  | { readonly kind: "finale-complete"; readonly id: string };
export type FinaleIntent = FinaleEffect
  | { readonly kind: "move"; readonly target: FinalePoint; readonly maxSpeedMps: number }
  | { readonly kind: "evacuate"; readonly waypointId: string; readonly target: FinalePoint; readonly footprint: FinaleFootprint; readonly marginM: number }
  | { readonly kind: "land-foot"; readonly id: string; readonly waypointId: string; readonly target: FinalePoint; readonly footprint: FinaleFootprint; readonly recheckClearance: true }
  | { readonly kind: "cancel-landing"; readonly id: string }
  | { readonly kind: "hold"; readonly reason: "missing-pose" | "phase-gate" | "evacuation" | "windup" | "effects" | "landing-ack" | "complete" };
export interface FinaleState {
  readonly version: 1;
  readonly kind: FinaleKind;
  readonly routeId: string;
  readonly routeHash: string;
  readonly tick: number;
  readonly phase: FinalePhase;
  readonly waypointIndex: number;
  readonly status: "approach" | "evacuate" | "landing" | "restoring" | "complete";
  readonly position: FinalePoint;
  readonly positionTick: number;
  readonly windupStartedTick: number | null;
  readonly landing: { readonly id: string; readonly requestedTick: number } | null;
  readonly nextLanding: number;
  readonly weakPoints: readonly { readonly id: string; readonly rust: number }[];
  readonly rustCursors: readonly { readonly sourceId: string; readonly sequence: number }[];
  readonly pitchResolved: boolean;
  readonly absorbedRobotIds: readonly string[];
  readonly pendingEffects: readonly FinaleEffect[];
  readonly restoreIssued: boolean;
  readonly completeIssued: boolean;
}
export interface FinaleInput {
  readonly tick: number;
  readonly route: FinaleRoute;
  /** Authoritative body pose sampled this tick, after movement, before effects. */
  readonly position: FinalePoint;
  readonly positionTick: number;
  readonly coverage: FinaleCoverage;
  readonly rustHits?: readonly FinaleRustHit[];
  readonly landingAcks?: readonly FinaleLandingAck[];
  readonly effectAcks?: readonly FinaleEffectAck[];
  /** Mission/combat owner confirms the Ferry pitch encounter is resolved. */
  readonly pitchResolved?: boolean;
}
export interface FinaleStep { readonly state: FinaleState; readonly intents: readonly FinaleIntent[] }
export const MAX_FINALE_WAYPOINTS = 128;
export const MAX_FINALE_PENDING_EFFECTS = 16;
export const MAX_ABSORBED_ROBOTS = 2000;
const MAX_RUST_SOURCES = 32;
const MAX_OBSERVATIONS = 4096;
const PHASES: readonly FinalePhase[] = ["entrance", "march", "pitch", "bridge", "reveal"];
const BOSS_POINTS = ["left-ankle", "right-ankle", "left-knee", "right-knee"];
const WALKER_POINTS = ["front-left", "front-right", "rear-left", "rear-right"];

const idValid = (id: string): boolean => typeof id === "string" && id.length > 0 && id.length <= 100;
const finitePoint = (point: FinalePoint): boolean => Number.isFinite(point.x) && Number.isFinite(point.z) && Math.abs(point.x) <= 1e7 && Math.abs(point.z) <= 1e7;
const tickValid = (tick: number): boolean => Number.isSafeInteger(tick) && tick >= 0;
const distance2 = (a: FinalePoint, b: FinalePoint): number => (((a.x - b.x)) * ((a.x - b.x))) + (((a.z - b.z)) * ((a.z - b.z)));
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function validFootprint(footprint: FinaleFootprint): boolean {
  if (footprint.kind === "circle") return Number.isFinite(footprint.radius) && footprint.radius > 0 && footprint.radius <= 200;
  if (footprint.kind !== "polygon" || footprint.vertices.length < 3 || footprint.vertices.length > 32) return false;
  if (footprint.vertices.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 200 || Math.abs(p[1]) > 200)) return false;
  let area = 0;
  let turnSign = 0;
  for (let i = 0; i < footprint.vertices.length; i++) {
    const a = footprint.vertices[i]!, b = footprint.vertices[(i + 1) % footprint.vertices.length]!;
    const c = footprint.vertices[(i + 2) % footprint.vertices.length]!;
    const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (turn === 0) return false;
    if (turnSign !== 0 && (turn > 0 ? 1 : -1) !== turnSign) return false;
    turnSign = turn > 0 ? 1 : -1;
    for (let j = 0; j < footprint.vertices.length; j++) {
      if (j === i || j === (i + 1) % footprint.vertices.length) continue;
      const point = footprint.vertices[j]!;
      const side = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
      if (side === 0 || (side > 0 ? 1 : -1) !== turnSign) return false;
    }
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Number.isFinite(area) && Math.abs(area) > 0.01;
}

function validateRoute(kind: FinaleKind, route: FinaleRoute): void {
  if (!idValid(route.id) || route.id.length > 60 || route.waypoints.length === 0 || route.waypoints.length > MAX_FINALE_WAYPOINTS) throw new RangeError("Invalid finale route");
  const seen = new Set<string>();
  let previousPhase = -1;
  for (const waypoint of route.waypoints) {
    if (!idValid(waypoint.id) || seen.has(waypoint.id) || !finitePoint(waypoint) || !validFootprint(waypoint.footprint) || !tickValid(waypoint.windupTicks) || waypoint.windupTicks < TICK_HZ || waypoint.windupTicks > 30 * TICK_HZ || !Number.isInteger(waypoint.shedRobots) || waypoint.shedRobots < 0 || waypoint.shedRobots > 8) throw new RangeError("Invalid finale waypoint");
    seen.add(waypoint.id);
    if (kind === "walker") {
      if (waypoint.phase !== "patrol") throw new RangeError("Walker route must patrol");
    } else {
      const phase = PHASES.indexOf(waypoint.phase);
      if (phase < 0 || phase < previousPhase || phase > previousPhase + 1) throw new RangeError("Boss route must visit all five phases in order");
      previousPhase = phase;
    }
  }
  if (kind === "elizabeth" && previousPhase !== PHASES.length - 1) throw new RangeError("Boss route must reach reveal");
}

function copyFootprint(footprint: FinaleFootprint): FinaleFootprint {
  return footprint.kind === "circle" ? { ...footprint } : { kind: "polygon", vertices: footprint.vertices.map(p => [p[0], p[1]]) };
}

export function createFinaleState(options: {
  readonly kind: FinaleKind;
  readonly route: FinaleRoute;
  readonly position: FinalePoint;
  readonly tick?: number;
  readonly absorbedRobotIds?: readonly string[];
}): FinaleState {
  const tick = options.tick ?? 0;
  if ((options.kind !== "walker" && options.kind !== "elizabeth") || !tickValid(tick) || !finitePoint(options.position)) throw new RangeError("Invalid finale start");
  validateRoute(options.kind, options.route);
  const absorbed = [...(options.absorbedRobotIds ?? [])].sort(compareId);
  if (absorbed.length > MAX_ABSORBED_ROBOTS || absorbed.some((id, i) => !idValid(id) || (i > 0 && id === absorbed[i - 1]))) throw new RangeError("Invalid absorbed robot IDs");
  return {
    version: 1, kind: options.kind, routeId: options.route.id, routeHash: hashState(options.route), tick,
    phase: options.route.waypoints[0]!.phase, waypointIndex: 0, status: "approach",
    position: { ...options.position }, positionTick: tick, windupStartedTick: null, landing: null, nextLanding: 1,
    weakPoints: (options.kind === "walker" ? WALKER_POINTS : BOSS_POINTS).map(id => ({ id, rust: 0 })),
    rustCursors: [], pitchResolved: false, absorbedRobotIds: absorbed, pendingEffects: [], restoreIssued: false, completeIssued: false,
  };
}

function pointSegmentDistance2(x: number, z: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length = dx * dx + dz * dz;
  const fraction = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / length));
  return (((x - a[0] - fraction * dx)) * ((x - a[0] - fraction * dx))) + (((z - a[1] - fraction * dz)) * ((z - a[1] - fraction * dz)));
}

/** Closed footprints: touching the requested clearance boundary is still unsafe. */
export function finaleFootfallClear(kind: FinaleKind, waypoint: FinaleWaypoint, coverage: FinaleCoverage, tick: number): boolean {
  if ((kind !== "walker" && kind !== "elizabeth") || !finitePoint(waypoint) || !tickValid(tick) || !coverage.complete || coverage.tick !== tick || coverage.bodies.length > MAX_OBSERVATIONS || !validFootprint(waypoint.footprint)) return false;
  const margin = kind === "walker" ? 3 : 0;
  for (const body of coverage.bodies) {
    if (!idValid(body.id) || !finitePoint(body) || !Number.isFinite(body.radius) || body.radius < 0 || body.radius > 10 || (body.kind !== "person" && body.kind !== "animal")) return false;
    const radius = body.radius + margin;
    const x = body.x - waypoint.x, z = body.z - waypoint.z;
    if (waypoint.footprint.kind === "circle") {
      const limit = radius + waypoint.footprint.radius;
      if (x * x + z * z <= limit * limit) return false;
    } else {
      const points = waypoint.footprint.vertices;
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[j]!, b = points[i]!;
        if (pointSegmentDistance2(x, z, a, b) <= radius * radius) return false;
        if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      if (inside) return false;
    }
  }
  return true;
}

function nextPhaseAllowed(state: FinaleState, phase: FinalePhase): boolean {
  const rust = (id: string): number => state.weakPoints.find(p => p.id === id)?.rust ?? 0;
  if (phase === "pitch") return rust("left-ankle") >= 0.6 && rust("right-ankle") >= 0.6;
  if (phase === "bridge") return state.pitchResolved;
  if (phase === "reveal") return rust("left-knee") >= 0.8 && rust("right-knee") >= 0.8;
  return true;
}

function applyRust(state: FinaleState, hits: readonly FinaleRustHit[]): Pick<FinaleState, "rustCursors" | "weakPoints"> {
  if (hits.length > 64) throw new RangeError("Too many finale rust observations");
  const cursors = state.rustCursors.map(cursor => ({ ...cursor }));
  const points = state.weakPoints.map(point => ({ ...point }));
  const sorted = [...hits].sort((a, b) => compareId(a.sourceId, b.sourceId) || a.sequence - b.sequence);
  for (const hit of sorted) {
    if (!idValid(hit.sourceId) || !tickValid(hit.sequence) || !idValid(hit.weakPointId) || !Number.isFinite(hit.rust) || hit.rust < 0 || hit.rust > 1) throw new RangeError("Invalid finale rust observation");
    let cursor = cursors.find(item => item.sourceId === hit.sourceId);
    if (!cursor) {
      if (cursors.length >= MAX_RUST_SOURCES) continue;
      cursor = { sourceId: hit.sourceId, sequence: -1 };
      cursors.push(cursor);
    }
    if (hit.sequence <= cursor.sequence) continue;
    // Conflicting duplicate observations cannot be resolved by input order.
    const duplicates = sorted.filter(item => item.sourceId === hit.sourceId && item.sequence === hit.sequence);
    cursor.sequence = hit.sequence;
    if (duplicates.some(item => item.weakPointId !== hit.weakPointId || item.rust !== hit.rust)) continue;
    const point = points.find(item => item.id === hit.weakPointId);
    const exposed = state.kind === "walker" || state.phase === "bridge" || (state.phase === "march" && hit.weakPointId.endsWith("ankle"));
    if (point && exposed) point.rust = Math.min(1, point.rust + hit.rust);
  }
  return { rustCursors: cursors.sort((a, b) => compareId(a.sourceId, b.sourceId)), weakPoints: points };
}

export function stepFinale(previous: FinaleState, input: FinaleInput): FinaleStep {
  if (previous.version !== 1 || (previous.kind !== "walker" && previous.kind !== "elizabeth") || !["approach", "evacuate", "landing", "restoring", "complete"].includes(previous.status) || (previous.kind === "walker" ? previous.phase !== "patrol" : !PHASES.includes(previous.phase)) || !tickValid(previous.tick) || !finitePoint(previous.position) || !tickValid(previous.positionTick) || previous.positionTick > previous.tick || !tickValid(previous.waypointIndex) || !tickValid(input.tick) || input.tick <= previous.tick || !tickValid(input.positionTick) || !finitePoint(input.position)) throw new RangeError("Invalid finale tick or pose");
  validateRoute(previous.kind, input.route);
  if (input.route.id !== previous.routeId || hashState(input.route) !== previous.routeHash) throw new Error("Finale route changed during encounter");
  if ((input.effectAcks?.length ?? 0) > MAX_FINALE_PENDING_EFFECTS || (input.landingAcks?.length ?? 0) > 16) throw new RangeError("Too many finale acknowledgements");
  if (previous.pendingEffects.length > MAX_FINALE_PENDING_EFFECTS || previous.rustCursors.length > MAX_RUST_SOURCES || previous.absorbedRobotIds.length > MAX_ABSORBED_ROBOTS || !Number.isSafeInteger(previous.nextLanding) || previous.nextLanding < 1 || previous.weakPoints.length !== 4 || previous.weakPoints.some(point => !idValid(point.id) || !Number.isFinite(point.rust) || point.rust < 0 || point.rust > 1) || previous.rustCursors.some(cursor => !idValid(cursor.sourceId) || !tickValid(cursor.sequence))) throw new RangeError("Invalid finale state budget");
  const effectAcks = input.effectAcks ?? [];
  for (const ack of effectAcks) if (!idValid(ack.id) || !tickValid(ack.tick) || ack.tick > input.tick) throw new RangeError("Invalid effect acknowledgement");
  for (const ack of input.landingAcks ?? []) if (!idValid(ack.requestId) || !tickValid(ack.tick) || !finitePoint(ack)) throw new RangeError("Invalid landing acknowledgement");
  const maxSpeedMps = previous.kind === "walker" ? 3 : 6;
  const elapsed = (input.positionTick - previous.positionTick) / TICK_HZ;
  const poseValid = input.positionTick === input.tick && elapsed > 0 && distance2(input.position, previous.position) <= (((maxSpeedMps * elapsed + 0.05)) * ((maxSpeedMps * elapsed + 0.05)));
  let state: FinaleState = {
    ...previous, ...applyRust(previous, input.rustHits ?? []), tick: input.tick,
    position: poseValid ? { ...input.position } : { ...previous.position }, positionTick: poseValid ? input.tick : previous.positionTick,
    pitchResolved: previous.pitchResolved || input.pitchResolved === true,
    pendingEffects: previous.pendingEffects.filter(effect => !effectAcks.some(ack => ack.id === effect.id && ack.tick >= previous.tick)),
  };
  const intents: FinaleIntent[] = [...state.pendingEffects];
  const hold = (reason: Extract<FinaleIntent, {kind:"hold"}>["reason"]): FinaleStep => ({ state, intents: [...intents, { kind: "hold", reason }] });
  if (state.status === "complete") return hold("complete");
  if (state.kind === "walker" && state.weakPoints.every(point => point.rust >= 1)) {
    if (state.pendingEffects.length >= MAX_FINALE_PENDING_EFFECTS) return hold("effects");
    const id = `${state.routeId}:complete`;
    const effect: FinaleEffect = { kind: "finale-complete", id };
    if (!state.completeIssued) {
      if (state.landing) intents.push({ kind: "cancel-landing", id: state.landing.id });
      state = { ...state, status: "complete", completeIssued: true, landing: null, pendingEffects: [...state.pendingEffects, effect] };
      intents.push(effect);
    }
    return hold("complete");
  }
  if (state.status === "restoring") {
    if (!state.restoreIssued) {
      if (state.pendingEffects.length >= MAX_FINALE_PENDING_EFFECTS) return hold("effects");
      const effect: FinaleEffect = { kind: "restore-robots", id: `${state.routeId}:restore`, robotIds: [...state.absorbedRobotIds] };
      state = { ...state, restoreIssued: true, pendingEffects: [...state.pendingEffects, effect] };
      intents.push(effect);
    } else if (state.pendingEffects.length === 0) {
      const effect: FinaleEffect = { kind: "finale-complete", id: `${state.routeId}:complete` };
      state = { ...state, status: "complete", completeIssued: true, pendingEffects: [...state.pendingEffects, effect] };
      intents.push(effect);
    }
    return hold("effects");
  }
  const waypoint = input.route.waypoints[state.waypointIndex];
  if (!waypoint) throw new RangeError("Invalid finale waypoint cursor");
  if (state.phase !== waypoint.phase) {
    if (!nextPhaseAllowed(state, waypoint.phase)) return hold("phase-gate");
    state = { ...state, phase: waypoint.phase };
  }
  if (!poseValid) return hold("missing-pose");
  if (state.status === "approach") {
    if (distance2(state.position, waypoint) > 1) return { state, intents: [...intents, { kind: "move", target: { x: waypoint.x, z: waypoint.z }, maxSpeedMps }] };
    state = { ...state, status: "evacuate", windupStartedTick: input.tick };
  }
  const clear = finaleFootfallClear(state.kind, waypoint, input.coverage, input.tick);
  const evacuate: FinaleIntent = { kind: "evacuate", waypointId: waypoint.id, target: { x: waypoint.x, z: waypoint.z }, footprint: copyFootprint(waypoint.footprint), marginM: state.kind === "walker" ? 3 : 0 };
  intents.push(evacuate);
  if (!clear) {
    if (state.landing) intents.push({ kind: "cancel-landing", id: state.landing.id });
    state = { ...state, status: "evacuate", landing: null };
    return hold("evacuation");
  }
  if (state.pendingEffects.length > MAX_FINALE_PENDING_EFFECTS - 2) return hold("effects");
  if (state.landing) {
    if (distance2(state.position, waypoint) > 1) {
      intents.push({ kind: "cancel-landing", id: state.landing.id });
      state = { ...state, status: "approach", landing: null, windupStartedTick: null };
      return hold("missing-pose");
    }
    // A physical owner records its receipt after the final clearance pass. The reducer
    // consumes that preceding tick's receipt while independently checking current clearance.
    const candidates = input.landingAcks?.filter(item => item.requestId === state.landing!.id && item.tick >= previous.tick && item.tick <= input.tick) ?? [];
    const first = candidates[0];
    const conflict = first && candidates.some(item => item.clear !== first.clear || item.x !== first.x || item.z !== first.z);
    const ack = !conflict && distance2(state.position, waypoint) <= 0.0001 && candidates.find(item => item.tick > state.landing!.requestedTick && item.clear && distance2(item, waypoint) <= 0.0001);
    if (!ack) return hold("landing-ack");
    const impact: FinaleEffect = { kind: "impact", id: `${state.landing.id}:impact`, waypointId: waypoint.id, x: waypoint.x, z: waypoint.z, footprint: copyFootprint(waypoint.footprint) };
    const effects: FinaleEffect[] = [impact];
    if (waypoint.shedRobots > 0 && (state.phase === "march" || state.phase === "bridge")) effects.push({ kind: "shed-robots", id: `${state.landing.id}:shed`, count: waypoint.shedRobots, x: waypoint.x, z: waypoint.z });
    intents.push(...effects);
    const next = state.waypointIndex + 1;
    state = { ...state, waypointIndex: state.kind === "walker" ? next % input.route.waypoints.length : next, status: next >= input.route.waypoints.length && state.kind === "elizabeth" ? "restoring" : "approach", windupStartedTick: null, landing: null, pendingEffects: [...state.pendingEffects, ...effects] };
    return { state, intents };
  }
  if (input.tick - (state.windupStartedTick ?? input.tick) < waypoint.windupTicks) return hold("windup");
  if (state.nextLanding === Number.MAX_SAFE_INTEGER) throw new RangeError("Finale landing IDs exhausted");
  const landing = { id: `${state.routeId}:land:${state.nextLanding}`, requestedTick: input.tick };
  state = { ...state, status: "landing", landing, nextLanding: state.nextLanding + 1 };
  intents.push({ kind: "land-foot", id: landing.id, waypointId: waypoint.id, target: { x: waypoint.x, z: waypoint.z }, footprint: copyFootprint(waypoint.footprint), recheckClearance: true });
  return { state, intents };
}
