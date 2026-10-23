import { personIsChild, type AgentState } from "../sim/agents.ts";
import type { RuntimePhysicalBody } from "../sim/agents/runtime-state.ts";
import type { TargetCombat } from "../sim/combat-contract.ts";
import type { DodgeState, SimState } from "../sim/contract.ts";
import type { RuntimeVisualActor, RuntimeVisualLink, RuntimeVisualSnapshot } from "./agent-runtime.ts";
import { newPersonPose, newRobotPose, rigidDodgePose, robotDodgePose } from "./dodge-pose.ts";

export interface RuntimeSnapshotResult {
  readonly snapshot: RuntimeVisualSnapshot;
  /** Filter these only in render copies; original sim states remain untouched. */
  readonly legacyIdsToHide: ReadonlySet<number>;
  readonly playerIdsToHide: ReadonlySet<string>;
  readonly physicalCount: number;
  readonly dodging: number;
}

interface RobotMetadata { agentId: number; mode?: string | null; phase?: string | null; rust?: number | null }
interface RobotActor { id: string; model?: string }
interface WeakPoint { id: string; x: number; y: number; z: number; heading: number; radius: number }
type ObjectRecord = Record<string, unknown>;

function record(value: unknown): ObjectRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectRecord : null;
}
function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? value.slice(0, 8192) : []; }
function number(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function angle(a: number, b: number, alpha: number): number {
  const turn = Math.atan2(Math.sin(b - a), Math.cos(b - a)); return a + turn * alpha;
}
function finitePose(value: { x: number; y: number; z: number; heading: number }): boolean {
  return [value.x, value.y, value.z, value.heading].every(Number.isFinite);
}
function extras(state: Readonly<SimState>): readonly RuntimePhysicalBody[] {
  const runtime = record(record(state.ext.agents)?.runtime);
  return list(runtime?.bodies).filter((value): value is RuntimePhysicalBody => {
    const body = record(value);
    return !!body && typeof body.id === "string" && typeof body.model === "string" &&
      typeof body.x === "number" && typeof body.y === "number" && typeof body.z === "number" && typeof body.heading === "number";
  });
}
/** A small explicit cap protects render work even if malformed saved data grows this list. */
export const MAX_RENDER_WEAK_POINTS = 32;
function weakPoints(state: Readonly<SimState>): WeakPoint[] {
  const runtime = record(record(state.ext.agents)?.runtime);
  const output: WeakPoint[] = [], seen = new Set<string>();
  for (const value of list(record(runtime?.routineOutput)?.finaleWeakPoints).slice(0, MAX_RENDER_WEAK_POINTS)) {
    const point = record(value);
    if (!point || typeof point.id !== "string" || !point.id || seen.has(point.id) ||
        typeof point.x !== "number" || typeof point.y !== "number" || typeof point.z !== "number" ||
        typeof point.heading !== "number" || !finitePose(point as unknown as WeakPoint) ||
        typeof point.radius !== "number" || !Number.isFinite(point.radius) || point.radius <= 0) continue;
    seen.add(point.id);
    output.push({ id: point.id, x: point.x, y: point.y, z: point.z, heading: point.heading,
      radius: Math.min(32, point.radius) });
  }
  return output;
}
function target(state: Readonly<SimState>, id: string): Partial<TargetCombat> | null {
  return record(record(record(state.ext.combat)?.targets)?.[id]) as Partial<TargetCombat> | null;
}
function phaseOf(combat: Partial<TargetCombat> | null, metadata?: RobotMetadata): string {
  return typeof combat?.phase === "string" ? combat.phase : metadata?.phase ?? "active";
}

function pose(
  body: { x: number; y: number; z: number; heading: number; speed?: number; dodge?: DodgeState | null },
  previous: { x: number; y: number; z: number; heading: number } | undefined,
  alpha: number, model: string, tick: number,
): Pick<RuntimeVisualActor, "x" | "y" | "z" | "heading" | "pitch" | "roll" | "pivotY" | "speed"> {
  const from = previous && finitePose(previous) ? previous : body;
  let x = from.x + (body.x - from.x) * alpha, y = from.y + (body.y - from.y) * alpha;
  let z = from.z + (body.z - from.z) * alpha, heading = angle(from.heading, body.heading, alpha);
  let pitch = 0, roll = 0, pivotY = 0;
  if (body.dodge) {
    if (model === "associate" || model === "person") {
      const dodge = rigidDodgePose(body.dodge, body.heading, alpha, tick / 60, newPersonPose());
      x = dodge.x ?? x; z = dodge.z ?? z; y += dodge.lift; heading = dodge.heading;
      pitch = dodge.pitch; roll = dodge.roll; pivotY = dodge.pivot;
    } else {
      const dodge = robotDodgePose(model === "trundle" || model === "tidy" ? "sidewalkBot" : "errandRobot", body.dodge, body.heading, alpha, newRobotPose());
      x = dodge.x ?? x; z = dodge.z ?? z; heading = dodge.heading; pitch = dodge.pitch; roll = dodge.roll;
    }
  }
  return { x, y, z, heading, pitch, roll, pivotY, speed: body.speed ?? 0 };
}

function visualParts(
  id: string, model: string, base: ReturnType<typeof pose>, combat: Partial<TargetCombat> | null,
  mode: string, metadata?: RobotMetadata,
): RuntimeVisualActor[] {
  const phase = phaseOf(combat, metadata);
  if (phase === "cleared") return [];
  const rust = number(combat?.rust, number(metadata?.rust));
  const heightScale = Math.max(0, Math.min(1, number(combat?.heightScale, phase === "heap" ? 0.2 : 1)));
  const heap = phase === "heap";
  const result: RuntimeVisualActor[] = [{ id, kind: heap ? "heap" : model, ...base,
    speed: phase === "active" ? base.speed : 0, mode: phase === "active" ? mode : phase,
    heightScale: heap ? 1 : heightScale, rust }];
  if (combat?.puddle) result.push({ id: `${id}:puddle`, kind: "puddle", x: base.x, y: base.y + 0.005,
    z: base.z, heading: 0, speed: 0, mode: "idle" });
  return result;
}

/**
 * Build a deterministic render snapshot from authoritative poses. Newly spawned bodies use
 * their current pose immediately; absent bodies are not invented or extrapolated. Combat's
 * current targets override one-tick-old robot metadata so a melt is visible on its first tick.
 */
export function runtimeVisualSnapshot(
  previous: Readonly<SimState>, current: Readonly<SimState>, interpolation: number,
  viewer?: RuntimeVisualSnapshot["viewer"],
): RuntimeSnapshotResult {
  const alpha = Math.max(0, Math.min(1, number(interpolation)));
  const robotState = record(current.ext.robots);
  const legacyIdsToHide = new Set<number>();
  const playerIdsToHide = new Set<string>();
  if (robotState?.enabled !== true) return { snapshot: { actors: [], ...(viewer ? { viewer } : {}) }, legacyIdsToHide, playerIdsToHide, physicalCount: 0, dodging: 0 };
  const metadata = new Map<number, RobotMetadata>();
  for (const value of list(robotState.metadata)) {
    const item = record(value);
    if (item && Number.isSafeInteger(item.agentId)) metadata.set(item.agentId as number, item as unknown as RobotMetadata);
  }
  const models = new Map<string, string>();
  for (const value of list(robotState.actors)) {
    const item = record(value) as RobotActor | null;
    if (item && typeof item.id === "string" && typeof item.model === "string") models.set(item.id, item.model);
  }
  const windups = new Map<string, string>();
  for (const value of list(record(current.ext.combat)?.attacks)) {
    const item = record(value);
    if (item && typeof item.attackerId === "string" && item.active !== true) windups.set(item.attackerId, item.kind === "forced-update" ? "forced-update" : "windup");
  }
  const actors: RuntimeVisualActor[] = [];
  const links: RuntimeVisualLink[] = [];
  const runtime = record(record(current.ext.agents)?.runtime);
  const bodyMetadata = record(record(runtime?.routineOutput)?.actorMetadata);
  let physicalCount = 0, dodging = 0;
  const priorExtras = new Map(extras(previous).map(body => [body.id, body]));
  for (const body of extras(current)) {
    if (!finitePose(body)) continue;
    const model = body.model === "person" ? "associate" : body.model;
    const transformed = pose(body, priorExtras.get(body.id), alpha, model, current.tick);
    const combat = target(current, body.id);
    const mode = record(bodyMetadata?.[body.id])?.honking === true ? "honk" : windups.get(body.id) ?? "idle";
    actors.push(...visualParts(body.id, model, transformed, combat, body.dodge?.phase === "dive" && body.kind === "animal" ? "fly" : mode));
    physicalCount++; if (body.dodge) dodging++;
  }
  const beforeWeakPoints = new Map(weakPoints(previous).map(point => [point.id, point]));
  for (const point of weakPoints(current)) {
    const combat = target(current, point.id);
    if (combat?.phase === "cleared") continue;
    actors.push({ id: point.id, kind: "weak-point", ...pose(point, beforeWeakPoints.get(point.id), alpha, "weak-point", current.tick),
      scale: point.radius * 2, rust: Math.max(0, Math.min(1, number(combat?.rust))), mode: "weak-point" });
  }
  for (const playerId of Object.keys(current.players).sort()) {
    const id = `player:${playerId}`, data = record(bodyMetadata?.[id]);
    const player = current.players[playerId]!;
    if (data?.robotBody !== true || data.kind !== "robot" || (data.model !== "footman" && data.model !== "trundle") ||
        player.mode !== "foot" || !player.foot || !finitePose(player.foot)) continue;
    const before = previous.players[playerId];
    const combat = target(current, id) ?? target(current, playerId);
    const emote = typeof data.robotEmote === "string" ? data.robotEmote : "none";
    const tells = list(data.robotTells).filter((tell): tell is string => typeof tell === "string").slice(0, 8);
    actors.push(...visualParts(id, data.model, pose(player.foot, before?.mode === "foot" ? before.foot ?? undefined : undefined,
      alpha, data.model, current.tick), combat, windups.get(id) ?? "idle").map(actor => actor.kind === data.model ? { ...actor, emote, tells } : actor));
    playerIdsToHide.add(playerId);
  }
  const beforeAgents = new Map((previous.ext.agents?.list ?? []).map(agent => [agent.id, agent]));
  for (const agent of current.ext.agents?.list ?? []) {
    if (agent.kind === "person" || agent.kind === "robotaxi" || !finitePose(agent)) continue;
    const id = `agent:${agent.id}`, own = metadata.get(agent.id), combat = target(current, id);
    const phase = phaseOf(combat, own), rust = number(combat?.rust, number(own?.rust));
    const mode = windups.get(id) ?? own?.mode ?? "idle";
    if (phase === "active" && rust <= 0 && !["attack", "alerted", "flee", "windup", "forced-update"].includes(mode)) continue;
    legacyIdsToHide.add(agent.id);
    const model = models.get(id) ?? (agent.kind === "sidewalkBot" ? "trundle" : "footman");
    actors.push(...visualParts(id, model, pose(agent, beforeAgents.get(agent.id), alpha, model, current.tick), combat, mode, own));
    physicalCount++; if (agent.dodge) dodging++;
  }
  const visualById = new Map(actors.map((actor, index) => [actor.id, { actor, index }]));
  const carriedPuddles = new Set<string>();
  for (const value of list(record(runtime?.effectState)?.bindings).slice(0, 128)) {
    const binding = record(value);
    if (typeof binding?.heapId !== "string" || typeof binding.tidyId !== "string") continue;
    const heap = visualById.get(binding.heapId), carrier = visualById.get(binding.tidyId);
    if (!heap || !carrier || heap.actor.kind !== "heap" || carrier.actor.kind !== "tidy" || target(current, binding.heapId)?.phase !== "heap") continue;
    const at = carrier.actor;
    actors[heap.index] = { ...heap.actor, x: at.x + Math.sin(at.heading) * 0.55,
      y: at.y + 0.4, z: at.z - Math.cos(at.heading) * 0.55, heading: at.heading, speed: at.speed };
    actors[carrier.index] = { ...carrier.actor, mode: "hauling" };
    carriedPuddles.add(`${binding.heapId}:puddle`);
  }
  const people = new Map((current.ext.agents?.list ?? []).filter(agent => agent.kind === "person").map(agent => [agent.id, agent]));
  for (const value of list(record(runtime?.spatial)?.animals).slice(0, 256)) {
    const animal = record(value);
    if (animal?.kind !== "dog" || typeof animal.id !== "string" || !Number.isSafeInteger(animal.ownerId)) continue;
    const dog = visualById.get(animal.id)?.actor, owner = people.get(animal.ownerId as number);
    if (!dog || !owner) continue;
    const hand = pose(owner, beforeAgents.get(owner.id), alpha, "associate", current.tick);
    const childScale = personIsChild(owner.id) ? 0.66 : 1;
    links.push({ id: `${animal.id}:leash`, from: { x: dog.x + Math.sin(dog.heading) * 0.27, y: dog.y + 0.5, z: dog.z - Math.cos(dog.heading) * 0.27 },
      to: { x: hand.x + Math.cos(hand.heading) * 0.22 * childScale, y: hand.y + 1.02 * childScale, z: hand.z + Math.sin(hand.heading) * 0.22 * childScale } });
  }
  for (const id of list(runtime?.lanyardPersonIds).slice(0, 512)) {
    if (typeof id !== "number") continue;
    const person = people.get(id); if (!person) continue;
    const at = pose(person, beforeAgents.get(id), alpha, "associate", current.tick);
    actors.push({ id: `agent:${id}:lanyard`, kind: "lanyard", ...at, scale: personIsChild(id) ? 0.66 : 1 });
  }
  const renderedActors = actors.filter(actor => !carriedPuddles.has(actor.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  links.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { snapshot: { actors: renderedActors, ...(links.length ? { links } : {}), ...(viewer ? { viewer } : {}) }, legacyIdsToHide, playerIdsToHide, physicalCount, dodging };
}

/** Make a shallow render-only view. The authoritative state and every actor object survive unchanged. */
export function hideRuntimeReplacements(state: Readonly<SimState>, ids: ReadonlySet<number>): SimState {
  if (!ids.size || !state.ext.agents) return state as SimState;
  return { ...state, ext: { ...state.ext, agents: { ...state.ext.agents,
    list: state.ext.agents.list.filter((agent: AgentState) => !ids.has(agent.id)),
  } } };
}
