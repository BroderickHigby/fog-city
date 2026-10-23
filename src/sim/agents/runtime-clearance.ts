/** The one final dodge pass, with runtime bodies temporarily sharing legacy geometry. */
import { type AgentState, type AgentsExt } from "../agents.ts";
import { DT, type DodgeState, type SimState } from "../contract.ts";
import { wrapAngle } from "../dmath.ts";
import { stepDodge, type AgentDodgeGeometry } from "../dodge.ts";
import { FOOT } from "../foot.ts";
import type { World } from "../world.ts";
import type { RuntimePhysicalBody } from "./runtime-state.ts";

/** Matches the bounded actor input accepted by the runtime orchestration layer. */
export const MAX_CLEARANCE_BODIES = 2800;
export const MAX_RUNTIME_VEHICLE_SPEED = 80;
export const RUNTIME_VEHICLE_ACCELERATION = 20;

/** A carried dog remains inside its owner's protected envelope for this tick. */
export type ClearedRuntimeBody = RuntimePhysicalBody & { pairedCarry?: boolean };

interface AnimalPose {
  id: string;
  ownerId?: number | null;
  leashM?: number | null;
  x: number; y: number; z: number; heading: number; speed: number;
  pairedCarry?: boolean;
}
interface FleetPose { id: number; x: number; y: number; z: number; heading: number; speed: number }
interface RuntimeStore {
  bodies: readonly ClearedRuntimeBody[];
  spatial?: { animals: readonly AnimalPose[] };
  fleet?: { vehicles: readonly FleetPose[] };
}
type RuntimeExt = AgentsExt & { runtime?: RuntimeStore };

function runtime(state: Readonly<SimState>): RuntimeStore | undefined {
  return (state.ext.agents as RuntimeExt | undefined)?.runtime;
}
function finite(value: number, limit = 10_000_000): boolean {
  return Number.isFinite(value) && Math.abs(value) <= limit;
}
function validDodge(dodge: DodgeState | null): boolean {
  return dodge === null || (typeof dodge === "object" && (dodge.phase === "dive" || dodge.phase === "recover") &&
    [dodge.sx, dodge.sz, dodge.tx, dodge.tz].every((n) => finite(n)) &&
    Number.isSafeInteger(dodge.t) && dodge.t >= 0 && Number.isSafeInteger(dodge.dur) && dodge.dur > 0 && dodge.dur <= 100_000 &&
    finite(dodge.peak, 128) && dodge.peak >= 0 && finite(dodge.hop, 128) && dodge.hop >= 0 && typeof dodge.leap === "boolean");
}
function validateBodies(bodies: readonly ClearedRuntimeBody[], legacy: readonly AgentState[]): void {
  if (!Array.isArray(bodies) || bodies.length > MAX_CLEARANCE_BODIES) throw new RangeError("Invalid runtime clearance body count");
  const ids = new Set(legacy.map((body) => body.id));
  const keys = new Set<string>();
  for (const body of bodies) {
    if (!body || typeof body !== "object" || typeof body.id !== "string" || body.id.length === 0 || body.id.length > 128 || keys.has(body.id) ||
        !Number.isSafeInteger(body.numericId) || body.numericId < 0 || ids.has(body.numericId)) {
      throw new RangeError("Invalid or duplicate runtime clearance body identity");
    }
    keys.add(body.id); ids.add(body.numericId);
    if (!["person", "animal", "robot", "vehicle"].includes(body.kind) || typeof body.model !== "string" || body.model.length > 128 ||
        ![body.x, body.y, body.z, body.previousX, body.previousZ, body.heading, body.previousHeading].every((n) => finite(n)) ||
        !finite(body.speed, MAX_RUNTIME_VEHICLE_SPEED) ||
        ![body.radius, body.halfLength, body.halfWidth].every((n) => finite(n, 128) && n > 0) ||
        !finite(body.height, 1024) || body.height <= 0 || !validDodge(body.dodge)) {
      throw new RangeError(`Invalid runtime clearance geometry: ${body.id}`);
    }
  }
}

function synthetic(body: Readonly<RuntimePhysicalBody>, previous = false): AgentState {
  const kind = body.kind === "vehicle" ? "robotaxi" : body.kind === "robot" ? "errandRobot" : "person";
  return {
    id: body.numericId, kind,
    x: previous ? body.previousX : body.x, y: body.y, z: previous ? body.previousZ : body.z,
    heading: previous ? body.previousHeading : body.heading, pitch: 0, speed: body.speed, vmax: Math.abs(body.speed),
    // Deliberately no route. Runtime movement owns its path; clearance observes only its real poses.
    edge: "", dir: 1, lane: 0, s: 0, next: "", ndir: 1, nlane: 0,
    conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0,
    mode: body.dodge?.phase ?? "go", rng: body.numericId >>> 0, dodge: body.dodge,
    ...((body as ClearedRuntimeBody).pairedCarry ? { pairedCarry: true } : {}),
  };
}

/** Legacy lists and synthetic extras are normally already ordered; preserve fallback input semantics. */
function mergeAgents(legacy: readonly AgentState[], extra: readonly AgentState[]): AgentState[] {
  for (let i = 1; i < legacy.length; i++) {
    if (legacy[i - 1]!.id > legacy[i]!.id) return [...legacy, ...extra].sort((a, b) => a.id - b.id);
  }
  const result: AgentState[] = [];
  let li = 0, ei = 0;
  while (li < legacy.length && ei < extra.length) {
    if (legacy[li]!.id <= extra[ei]!.id) result.push(legacy[li++]!);
    else result.push(extra[ei++]!);
  }
  while (li < legacy.length) result.push(legacy[li++]!);
  while (ei < extra.length) result.push(extra[ei++]!);
  return result;
}

/**
 * Called instead of stepDodge, once, after every motion/exit system. Returned poses are final.
 * Runtime vehicles must not accelerate above 20 m/s² or exceed 80 m/s: their next-step reach
 * includes every possible heading and this bounded translation, without inventing a route.
 * Invalid identities/geometry fail explicitly before calling the shared pass.
 */
export function stepAgentRuntimeDodge(world: World, before: Readonly<SimState>, after: SimState): SimState {
  const store = runtime(after);
  if (!store) return stepDodge(world, before, after);
  if (!Array.isArray(store.bodies)) throw new RangeError("Invalid runtime clearance bodies");
  if (store.bodies.length === 0) return stepDodge(world, before, after);
  const base = after.ext.agents as RuntimeExt;
  const previousBase = before.ext.agents as RuntimeExt | undefined;
  const previousLegacyIds = new Set((previousBase?.list ?? []).map(body => body.id));
  const oldBodies = runtime(before)?.bodies ?? [];
  validateBodies(store.bodies, base.list);
  validateBodies(oldBodies, previousBase?.list ?? []);
  const oldByKey = new Map(oldBodies.map((body) => [body.id, body]));
  const geometry = new Map<number, AgentDodgeGeometry>();
  const previousSynthetic: AgentState[] = [];
  const nextSynthetic: AgentState[] = [];
  const sorted = [...store.bodies].sort((a, b) => a.numericId - b.numericId);
  for (const body of sorted) {
    const old = oldByKey.get(body.id);
    if (old && (old.numericId !== body.numericId || old.kind !== body.kind)) throw new RangeError(`Runtime body changed identity: ${body.id}`);
    const previous = old ? synthetic(old) : synthetic(body, true);
    if (old && (Math.abs(body.previousX - old.x) > 1e-6 || Math.abs(body.previousZ - old.z) > 1e-6 || Math.abs(wrapAngle(body.previousHeading - old.heading)) > 1e-6)) {
      throw new RangeError(`Runtime body has stale previous position: ${body.id}`);
    }
    if (body.kind === "vehicle") {
      const dx = body.x - previous.x, dz = body.z - previous.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance > MAX_RUNTIME_VEHICLE_SPEED * DT + 1e-6) throw new RangeError(`Runtime vehicle exceeded bounded step: ${body.id}`);
      if (old && Math.abs(body.speed) > Math.abs(old.speed) + RUNTIME_VEHICLE_ACCELERATION * DT + 1e-6) {
        throw new RangeError(`Runtime vehicle exceeded bounded acceleration: ${body.id}`);
      }
    }
    const airborne = body.kind === "robot" && /drone|flying|airborne|parrot/i.test(body.model) || body.kind === "animal" && body.model === "parrot";
    // Their bounded footfall policy owns movement; a giant must never acquire a ground hop.
    const finale = body.kind === "robot" && (body.model === "elizabeth" || body.model === "walker");
    const animal = body.kind === "animal" ? store.spatial?.animals.find((entry) => entry.id === body.id) : undefined;
    const leash = animal?.ownerId != null && body.model === "dog" ? { ownerId: animal.ownerId, lengthM: animal.leashM ?? 2.2 } : undefined;
    if (leash) {
      const extraOwner = sorted.find((entry) => entry.numericId === leash.ownerId && entry.kind === "person");
      const hasOwner = extraOwner !== undefined || base.list.some((entry) => entry.id === leash.ownerId && entry.kind === "person");
      if (!Number.isSafeInteger(leash.ownerId) || !finite(leash.lengthM, 16) || leash.lengthM <= 0 ||
          !hasOwner || body.height > (extraOwner?.height ?? FOOT.height) - 0.2) {
        throw new RangeError(`Invalid runtime dog owner or leash: ${body.id}`);
      }
    }
    geometry.set(body.numericId, {
      vehicle: body.kind === "vehicle", radius: body.radius, halfLength: body.halfLength, halfWidth: body.halfWidth, height: body.height,
      dodgeClass: body.kind === "animal" || body.kind === "person" ? "person" : body.kind === "vehicle" || airborne || finale ? null : "errandRobot",
      fixedAltitude: airborne, acceleration: RUNTIME_VEHICLE_ACCELERATION, ...(leash ? { leash } : {}),
    });
    previousSynthetic.push(previous); nextSynthetic.push(synthetic(body));
  }
  // Reject a transient collision with a just-removed legacy identity too.
  if (sorted.some((body) => previousLegacyIds.has(body.numericId))) {
    throw new RangeError("Runtime body reused a legacy identity during the same tick");
  }
  const input: SimState = { ...after, ext: { ...after.ext, agents: { ...base, list: mergeAgents(base.list, nextSynthetic) } } };
  const previousInput: SimState = { ...before, ext: { ...before.ext, agents: { ...previousBase, nextId: previousBase?.nextId ?? base.nextId,
    list: mergeAgents(previousBase?.list ?? [], previousSynthetic) } } };
  const cleared = stepDodge(world, previousInput, input, geometry);
  const clearedExt = cleared.ext.agents as RuntimeExt;
  const byId = new Map(clearedExt.list.map((body) => [body.id, body]));
  const bodies = sorted.map((body): ClearedRuntimeBody => {
    const pose = byId.get(body.numericId)! as AgentState & { pairedCarry?: boolean };
    return { ...body, x: pose.x, y: pose.y, z: pose.z, heading: pose.heading, speed: pose.speed, dodge: pose.dodge,
      pairedCarry: pose.pairedCarry === true };
  });
  const byKey = new Map(bodies.map((body) => [body.id, body]));
  const numeric = new Map(bodies.map((body) => [body.numericId, body]));
  const finalStore: RuntimeStore = { ...store, bodies,
    ...(store.spatial ? { spatial: { ...store.spatial, animals: store.spatial.animals.map((animal) => {
      const body = byKey.get(animal.id);
      return body ? { ...animal, x: body.x, y: body.y, z: body.z, heading: body.heading, speed: body.speed, pairedCarry: body.pairedCarry } : animal;
    }) } } : {}),
    ...(store.fleet ? { fleet: { ...store.fleet, vehicles: store.fleet.vehicles.map((vehicle) => {
      const body = numeric.get(vehicle.id);
      return body?.kind === "vehicle" ? { ...vehicle, x: body.x, y: body.y, z: body.z, heading: body.heading, speed: body.speed } : vehicle;
    }) } } : {}),
  };
  const finalAgents: RuntimeExt = { ...base, list: base.list.map((body) => byId.get(body.id)!), runtime: finalStore };
  return { ...cleared, ext: { ...cleared.ext, agents: finalAgents } };
}

