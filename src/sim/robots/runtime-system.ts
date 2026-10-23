import { robotMetadata, storeRobotMetadata, type RobotRuntimeMetadata } from "./metadata.ts";
export type { RobotRuntimeMetadata } from "./metadata.ts";
import { runtimeReputations } from "../agents/runtime-economy.ts";
import { ambientProfilesOf } from "../agents/ambient-runtime.ts";
import type { RobotCatalogSource } from "./catalog.ts";
import { agentsOf, type AgentKind } from "../agents.ts";
import { sortedIds, type SimState } from "../contract.ts";
import type { JsonObject } from "../extensions.ts";
import { hash32 } from "../rng.ts";
import type { SimSystem, SimSystemContext } from "../system-contract.ts";
import { contextFromState, type CombatActorMetadata } from "../combat/adapter.ts";
import { combatOf } from "../combat/system.ts";
import type { CombatActor } from "../combat/types.ts";
import { agentRuntimeSession, type AgentRuntimeSession } from "../agents/runtime-state.ts";
import { agentsRuntimeOf, runtimeCombatActors } from "../agents/runtime-system.ts";
import { MAX_SIGNIFICANT_AGENTS } from "../agents/fidelity.ts";
import { deriveRobotConversionScopes } from "./conversion-scopes.ts";
import {
  createRobotRuntime, MAX_RUNTIME_ROBOTS, robotActorId, robotAgentId, stepRobotRuntime,
  type RobotRuntimeState, type RobotRuntimeStep,
} from "./runtime.ts";

export interface RobotBaselineFirmware { readonly agentId: number; readonly firmware: "good" | "bad" }

/** The body owners already persist pose; old full actor snapshots remain readable. */
export type StoredRobotActor = Omit<CombatActor, "x" | "y" | "z" | "heading" | "speed" | "radius" | "height"> &
  Partial<Pick<CombatActor, "x" | "y" | "z" | "heading" | "speed" | "radius" | "height">>;

export function storeRobotActor(actor: CombatActor, body?: Pick<CombatActor, "radius" | "height"> & Pick<Partial<CombatActor>, "pursuing">): StoredRobotActor {
  const { x: _x, y: _y, z: _z, heading: _heading, speed: _speed, ...description } = actor;
  const stored: StoredRobotActor = description;
  if (body && body.radius === actor.radius) delete stored.radius;
  if (body && body.height === actor.height) delete stored.height;
  if (body && actor.pursuing === false && body.pursuing !== true) delete stored.pursuing;
  return stored;
}

/** The root stays compatible with the serialized session and other agent-owned fields. */
export interface RobotsRuntimeData extends AgentRuntimeSession {
  readonly brain: RobotRuntimeState;
  readonly actors: readonly StoredRobotActor[];
  readonly attacks: RobotRuntimeStep["attacks"];
  readonly cancellations: RobotRuntimeStep["cancellations"];
  readonly locomotion: RobotRuntimeStep["locomotion"];
  readonly results: RobotRuntimeStep["results"];
  readonly conversionCap: number;
  readonly baselines: readonly RobotBaselineFirmware[];
  readonly metadata: readonly RobotRuntimeMetadata[];
  /** Compact storage only; accessors keep the full semantic metadata view. */
  readonly metadataVersion?: 1;
  /** Body-owner compatibility projection for retention before its next movement pass. */
  readonly significantAgentIds: readonly number[];
  readonly robotSignificantAgentIds: readonly number[];
  readonly restoredAgentIds: readonly number[];
  readonly retiredAgentIds: readonly number[];
  readonly fogDensity: number;
  readonly fleetUpdate: boolean;
  readonly protectedArea: boolean;
  readonly reputations: Readonly<Record<string, number>>;
}

export function robotsRuntimeOf(state: Readonly<SimState>): RobotsRuntimeData | null {
  if (!agentRuntimeSession(state)) return null;
  const value = state.ext.robots as unknown as Partial<RobotsRuntimeData>;
  if (!value.brain || value.brain.version !== 1 || !Number.isSafeInteger(value.brain.tick) || value.brain.tick < 0 ||
      !Number.isSafeInteger(value.brain.lastCombatEventId) || value.brain.lastCombatEventId < 0 ||
      !Array.isArray(value.brain.robots) || !Array.isArray(value.actors) || !Array.isArray(value.attacks) ||
      !Array.isArray(value.cancellations) || !Array.isArray(value.locomotion) || !Array.isArray(value.results) ||
      !Array.isArray(value.metadata) || !Array.isArray(value.robotSignificantAgentIds)) return null;
  return value.metadataVersion === 1 ? { ...value, metadata: robotMetadata(state) } as RobotsRuntimeData : value as RobotsRuntimeData;
}

/** Stable initial firmware. Conversion/restore metadata has precedence over this baseline. */
export function baselineRobotFirmware(seed: number, id: number, kind: AgentKind): "good" | "bad" {
  return (kind === "errandRobot" || kind === "sidewalkBot") && hash32(seed, id) % 100 < 35 ? "bad" : "good";
}

function ids(value: unknown, label: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_ROBOTS || value.some(id => !Number.isSafeInteger(id) || id < 0)) {
    throw new RangeError(`Invalid ${label}`);
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}
function withinFidelity(actor: CombatActor, context: SimSystemContext): boolean {
  if (actor.inFidelity === false) return false;
  const players = sortedIds(context.state.players);
  return players.length === 0 ? actor.inFidelity === true : players.some(id => {
    const player = context.state.players[id]!;
    const body = player.mode === "foot" && player.foot ? player.foot : player.car;
    const dx = actor.x - body.x, dz = actor.z - body.z;
    return dx * dx + dz * dz <= 350 * 350;
  });
}

/** Registration is opt-in through the serialized marker; legacy replay state stays untouched. */
export const robotRuntimeSystem: SimSystem = {
  key: "robots",
  step(context) {
    const session = agentRuntimeSession(context.state);
    if (!session) return context.state;
    const raw = context.state.ext.robots!;
    const previousData = robotsRuntimeOf(context.state);
    if (raw.brain !== undefined && !previousData) throw new Error("Invalid persisted robot runtime data");
    const previous = previousData?.brain ?? createRobotRuntime(context.previous.tick);
    const restoredAgentIds = ids(raw.restoredAgentIds, "restored robot IDs");
    const retiredAgentIds = ids(raw.retiredAgentIds, "retired robot IDs");
    const restored = new Set(restoredAgentIds);
    const extras = runtimeCombatActors(context.state);
    const agents = agentsRuntimeOf(context.state);
    const delivered = new Set(agents?.deliveredAgentIds ?? []);
    const actorMetadata: Record<string, CombatActorMetadata> = {};
    const ambientProfiles = ambientProfilesOf(context.state);
    const ambientById = new Map(ambientProfiles.map(profile => [profile.id, profile]));
    const catalogSources: Record<string, RobotCatalogSource> = {};
    for (const profile of ambientProfiles) catalogSources[String(profile.id)] = { seed: profile.seed, key: profile.key };
    const baselines = new Map<number, "good" | "bad">((previousData?.baselines ?? []).map(entry => [entry.agentId, entry.firmware]));
    for (const agent of [...agentsOf(context.state)].sort((a, b) => a.id - b.id)) {
      if (agent.kind === "person") continue;
      const profileFirmware = ambientById.get(agent.id)?.firmware;
      const base = baselines.get(agent.id) ?? (delivered.has(agent.id) ? "bad" :
        profileFirmware === "good" || profileFirmware === "bad" ? profileFirmware : baselineRobotFirmware(context.state.seed, agent.id, agent.kind));
      baselines.set(agent.id, base);
      actorMetadata[robotActorId(agent.id)] = { firmware: restored.has(agent.id) ? "good" : base };
    }
    const describedActors = contextFromState(context.world, context.state, { actorMetadata, extraActors: extras }).actors;
    for (const actor of describedActors) {
      const id = robotAgentId(actor.id);
      if (id === null || actor.kind !== "robot" || actor.firmware === "none" || baselines.has(id)) continue;
      const old = previous.robots.find(entry => entry.agentId === id);
      // Migration fallback for a prior runtime record; a converted body was originally
      // good even when its current authoritative descriptor already says bad.
      baselines.set(id, old?.convertedTick !== null && old?.convertedTick !== undefined ? "good" : actor.firmware);
    }
    const actors = describedActors.map(actor => {
      const id = robotAgentId(actor.id);
      return id !== null && actor.kind === "robot" && restored.has(id) ? { ...actor, firmware: "good" as const } : actor;
    });
    const baseBadCount = actors.filter(actor => {
      const id = robotAgentId(actor.id);
      return id !== null && baselines.get(id) === "bad" && withinFidelity(actor, context);
    }).length;
    const fogDensity = raw.fogDensity === undefined ? 0 : raw.fogDensity;
    if (typeof fogDensity !== "number" || !Number.isFinite(fogDensity) || fogDensity < 0 || fogDensity > 1) throw new RangeError("Invalid runtime fog density");
    const fleetUpdate = raw.fleetUpdate === true;
    const protectedArea = raw.protectedArea === true;
    const reputationContext = runtimeReputations(context.previous, raw.reputations);
    const promotionExemptIds = [...new Set([...(agents?.significantAgentIds ?? []),
      ...extras.map(actor => robotAgentId(actor.id)).filter((id): id is number => id !== null)])].sort((a, b) => a - b);
    const existingSignificant = agents?.population.significant ?? previous.robots.filter(entry => entry.significant.length > 0).length;
    const promotionBudget = Math.max(0, MAX_SIGNIFICANT_AGENTS - existingSignificant - (agents?.population.reservedVanUnits ?? 0));
    const conversionScopes = deriveRobotConversionScopes(context.world, sortedIds(context.state.players).map(id => {
      const player = context.state.players[id]!, body = player.mode === "foot" && player.foot ? player.foot : player.car;
      return { id, x: body.x, z: body.z };
    }), actors, [...baselines].map(([agentId, firmware]) => ({ agentId, firmware })), protectedArea, session.worldName);
    const result = stepRobotRuntime(previous, context, {
      catalog: true, catalogSources, catalogLevel: raw.catalogLevel as number | undefined,
      catalogArchetypes: raw.catalogArchetypes as unknown as Parameters<typeof stepRobotRuntime>[2]["catalogArchetypes"],
      promotionBudget, promotionExemptIds,
      actors, conversion: { baseBadCount, protectedArea }, conversionScopes, fogDensity, fleetUpdate,
      wave: Math.min(session.wave, 5) as 2 | 3 | 4 | 5,
      missionIds: agents?.significantAgentIds ?? [], restoredIds: restoredAgentIds, retiredIds: retiredAgentIds,
      reputations: reputationContext,
    });
    const combat = combatOf(context.previous);
    const present = new Set(result.actors.map(actor => actor.id));
    const physicalDescriptions = new Map(describedActors.map(actor => [actor.id, actor]));
    const presentations = new Map(result.catalog.map(item => [item.agentId, item]));
    const repairs = new Map(result.locomotion.filter(item => item.repairTravel).map(item => [item.agentId, item.repairTravel!]));
    const metadata: RobotRuntimeMetadata[] = result.state.robots.map(entry => {
      const actorId = robotActorId(entry.agentId), target = combat?.targets[actorId];
      return { ...presentations.get(entry.agentId), agentId: entry.agentId, actorId, present: present.has(actorId), firmware: entry.firmware,
        ...(entry.deferredSignificance?.length ? { deferredSignificance: entry.deferredSignificance } : {}),
        baselineFirmware: baselines.get(entry.agentId) ?? "good",
        mode: entry.brain?.mode ?? null, phase: target?.phase ?? (combat ? "active" : null), rust: target?.rust ?? (combat ? 0 : null),
        convertedTick: entry.convertedTick, bountyUntilTick: entry.bountyUntilTick,
        recruitOffer: entry.recruitOffer ? { ...entry.recruitOffer } : null, repairTravel: repairs.get(entry.agentId) ?? null, significant: [...entry.significant] };
    });
    const significantAgentIds = result.state.robots.filter(entry => entry.significant.length > 0).map(entry => entry.agentId);
    // A later authoritative conversion supersedes an earlier restore acknowledgement.
    const retainedRestores = restoredAgentIds.filter(id => !result.results.some(event => event.kind === "converted" && event.agentId === id));
    const output: RobotsRuntimeData = {
      ...session, brain: result.state, actors: result.actors.map(actor => storeRobotActor(actor, physicalDescriptions.get(actor.id))), attacks: result.attacks, cancellations: result.cancellations,
      locomotion: result.locomotion, results: result.results, conversionCap: result.conversionCap, metadata,
      baselines: result.state.robots.map(entry => ({ agentId: entry.agentId, firmware: baselines.get(entry.agentId) ?? "good" })),
      significantAgentIds, robotSignificantAgentIds: significantAgentIds,
      restoredAgentIds: retainedRestores, retiredAgentIds, fogDensity, fleetUpdate, protectedArea, reputations: reputationContext,
    };
    const described = { ...raw, ...output };
    const stored = { ...described, metadataVersion: 1, metadata: storeRobotMetadata(context.state.seed, { ...described, catalogSources }) };
    return { ...context.state, ext: { ...context.state.ext, robots: stored as unknown as JsonObject } };
  },
};
