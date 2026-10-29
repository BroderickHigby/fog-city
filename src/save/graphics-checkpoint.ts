// A one-shot renderer restart checkpoint. Unlike a campaign save this retains every
// current simulation field, including actors, traffic, active missions and mode state.
import { SIM_VERSION, type SimEvent, type SimState } from "../sim/contract.ts";
import { hashState } from "../sim/serialize.ts";

export const GRAPHICS_CHECKPOINT_KEY = "fogcity.graphics-restart.v1";
export const GRAPHICS_CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024;
export interface GraphicsCheckpoint {
  world: string;
  wave: number;
  state: SimState;
  queuedEvents: SimEvent[];
  recordedCommands: SimEvent[];
  requestedMission: string;
  waypoint?: { x: number; z: number };
  /** Independently checksummed isolated mode, including its exact entry campaign. */
  taxiSession?: string;
}
interface Envelope { schema: 1; checksum: string; data: GraphicsCheckpoint }
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const WORLD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value) && !BAD_KEYS.has(value);

/** Reject non-JSON values before serialization can silently drop or reshape them. */
function plainJson(value: unknown): void {
  let nodes = 0;
  const parents = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > 500_000 || depth > 64) throw new Error("Graphics checkpoint exceeds structural limits");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      if (item.length > GRAPHICS_CHECKPOINT_MAX_BYTES) throw new Error("Graphics checkpoint is too large");
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object") throw new Error("Graphics checkpoint must contain plain JSON");
    if (parents.has(item)) throw new Error("Graphics checkpoint cannot contain a cycle");
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("Graphics checkpoint must contain plain objects");
    if (Object.getOwnPropertySymbols(item).length) throw new Error("Graphics checkpoint cannot contain symbol fields");
    parents.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item)) {
      if (Object.keys(descriptors).some(key => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) throw new Error("Invalid graphics checkpoint array field");
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new Error("Invalid graphics checkpoint array item");
        visit(descriptor.value, depth + 1);
      }
    } else for (const [key, descriptor] of Object.entries(descriptors)) {
      if (BAD_KEYS.has(key) || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new Error("Invalid graphics checkpoint field");
      visit(descriptor.value, depth + 1);
    }
    parents.delete(item);
  }
  visit(value, 0);
}
function fields(value: Record<string, unknown>, names: readonly string[], predicate: (field: unknown) => boolean): boolean {
  return names.every(name => predicate(value[name]));
}
function pose(value: unknown): value is Record<string, unknown> {
  return record(value) && fields(value, ["x", "y", "z", "heading", "speed"], finite);
}
function player(value: unknown, playerId: string): boolean {
  if (!record(value) || value.id !== playerId || !["foot", "vehicle"].includes(String(value.mode)) || typeof value.exitPending !== "boolean") return false;
  const car = value.car;
  if (!pose(car) || !fields(car, ["steer", "lateral", "yawRate", "vy", "grip", "pitch", "roll", "impactSpeed", "landingSpeed"], finite)
    || !fields(car, ["hits", "airTicks", "sinceContact", "personBumps", "nearMisses"], integer) || typeof car.grounded !== "boolean") return false;
  const foot = value.foot;
  if (value.mode === "foot" && !pose(foot)) return false;
  if (foot !== null) {
    if (!pose(foot) || !finite(foot.vy) || typeof foot.grounded !== "boolean" || typeof foot.sprint !== "boolean") return false;
    if (foot.dodge !== null) {
      const dodge = foot.dodge;
      if (!record(dodge) || !["dive", "recover"].includes(String(dodge.phase)) || typeof dodge.leap !== "boolean"
        || !fields(dodge, ["sx", "sz", "tx", "tz", "peak", "hop", "vx", "vz", "vmax"], finite) || !fields(dodge, ["t", "dur"], integer)) return false;
    }
  }
  const ride = value.ride;
  if (ride !== undefined && ride !== null) {
    if (!pose(ride) || !integer(ride.agentId) || typeof ride.exitPending !== "boolean" || ride.manual !== undefined && ride.manual !== true) return false;
    if (ride.goal !== null && (!record(ride.goal) || !fields(ride.goal, ["x", "z"], finite))) return false;
  }
  const hail = value.hail;
  return hail === undefined || hail === null || record(hail) && integer(hail.agentId) && integer(hail.untilTick);
}
function eventList(value: unknown, minTick: number): value is SimEvent[] {
  return Array.isArray(value) && value.length <= 100_000 && value.every(event => record(event)
    && integer(event.tick, minTick) && id(event.kind) && (event.playerId === undefined || id(event.playerId))
    && Object.keys(event).every(key => ["tick", "kind", "playerId", "payload"].includes(key)));
}
function validCheckpoint(value: unknown): value is GraphicsCheckpoint {
  if (!record(value) || typeof value.world !== "string" || !WORLD.test(value.world) || !integer(value.wave, 1, 8)
    || typeof value.requestedMission !== "string" || value.requestedMission !== "" && !id(value.requestedMission)
    || Object.keys(value).some(key => !["world", "wave", "state", "queuedEvents", "recordedCommands", "requestedMission", "waypoint", "taxiSession"].includes(key))) return false;
  if(value.taxiSession!==undefined&&(typeof value.taxiSession!=="string"||!value.taxiSession.length||value.taxiSession.length>3*1024*1024))return false;
  const state = value.state;
  if (!record(state) || state.version !== SIM_VERSION || !integer(state.tick, 0, Number.MAX_SAFE_INTEGER - 1)
    || !Number.isSafeInteger(state.seed) || !Array.isArray(state.rng) || state.rng.length !== 4
    || !state.rng.every(word => integer(word, 0, 0xffffffff)) || !record(state.players) || !record(state.ext)) return false;
  const players = Object.keys(state.players);
  if (!players.length || players.length > 64 || players.some(key => !id(key) || !player((state.players as Record<string, unknown>)[key], key))) return false;
  if (!eventList(value.queuedEvents, state.tick + 1) || !eventList(value.recordedCommands, 0)) return false;
  return value.waypoint === undefined || record(value.waypoint) && fields(value.waypoint, ["x", "z"], finite)
    && Object.keys(value.waypoint).every(key => key === "x" || key === "z");
}
function boundedText(text: string): boolean {
  return text.length <= GRAPHICS_CHECKPOINT_MAX_BYTES && new TextEncoder().encode(text).length <= GRAPHICS_CHECKPOINT_MAX_BYTES;
}

/** A blocked/full store throws: callers must keep the current game running instead of reloading. */
export function writeGraphicsCheckpoint(storage: Pick<Storage, "setItem">, data: GraphicsCheckpoint): void {
  plainJson(data);
  if (!validCheckpoint(data)) throw new Error("Invalid graphics checkpoint");
  const envelope: Envelope = { schema: 1, checksum: hashState(data), data };
  const text = JSON.stringify(envelope);
  if (!boundedText(text)) throw new Error("Graphics checkpoint is too large");
  storage.setItem(GRAPHICS_CHECKPOINT_KEY, text);
}

/** Consume once, even when corrupt or for another world. Never touches campaign-save keys. */
export function takeGraphicsCheckpoint(storage: Pick<Storage, "getItem" | "removeItem">, world: string, wave: number): GraphicsCheckpoint | null {
  try {
    const text = storage.getItem(GRAPHICS_CHECKPOINT_KEY);
    if (text === null) return null;
    // Delete before accepting it so a failed subsequent boot cannot replay a checkpoint twice.
    storage.removeItem(GRAPHICS_CHECKPOINT_KEY);
    if (!boundedText(text)) return null;
    const raw: unknown = JSON.parse(text);
    plainJson(raw);
    if (!record(raw) || raw.schema !== 1 || typeof raw.checksum !== "string" || !/^[a-f0-9]{8}$/.test(raw.checksum)
      || Object.keys(raw).some(key => !["schema", "checksum", "data"].includes(key)) || !validCheckpoint(raw.data)) return null;
    if (raw.data.world !== world || raw.data.wave !== wave || hashState(raw.data) !== raw.checksum) return null;
    return raw.data;
  } catch { return null; }
}
