import type { PlayerState, SimEvent, SimInput, SimState } from "../contract.ts";
import type { SimSystem, SimSystemContext } from "../system-contract.ts";
import type { CombatActor } from "../combat-contract.ts";
import { contextFromState } from "../combat/adapter.ts";
import { AGENT_SPEC, agentsOf, rejoinAt, type AgentState } from "../agents.ts";
import type { JsonObject } from "../extensions.ts";
import { createRoutineRuntime, stepRoutineRuntime, type RoutineRuntimeState, type RoutineRuntimeStep } from "./routine-runtime.ts";
import { agentRuntimeSession, runtimeRestoreSafehouses } from "./runtime-state.ts";
import { agentRuntimeSystem, agentsRuntimeOf, runtimeCombatActors, type AgentRuntimeData } from "./runtime-system.ts";
import type { ThreatSpawnRequest } from "../gameplay-contract.ts";
import type { RobotRuntimeMetadata } from "../robots/runtime-system.ts";
import { movementLimit } from "../combat/system.ts";
import { createRecruitTransportState, stepRecruitTransport, type RecruitTransportState } from "./recruit-transport.ts";
import type { RuntimePhysicalBody } from "./runtime-state.ts";
import { toLocal } from "../../geo/project.ts";
import { meshGroundHeight } from "../world.ts";

// Authored convention-center site in content/places.json (600 m falloff).
const CONVENTION_CENTER = toLocal(37.784, -122.4015);

export type RoutineOutput = Pick<RoutineRuntimeStep, "effects" | "actorMetadata" | "attackRequests" | "diagnostics" | "conference" | "finaleWeakPoints" | "swarmAssignments" | "swarmSuppressedIds" | "associateRiderBindings">;
export type CompleteAgentRuntime = AgentRuntimeData & {
  routines?: RoutineRuntimeState;
  routineOutput?: RoutineOutput;
  effectState?: { acks?: readonly string[] };
  transport?: RecruitTransportState;
  boundLegacyActors?: readonly AgentState[];
  restorationArrivals?: ReturnType<typeof stepRecruitTransport>["restorationArrivals"];
  restoreSafehouses?: ReturnType<typeof runtimeRestoreSafehouses>;
};

export function completeAgentRuntimeOf(state: Readonly<SimState>): CompleteAgentRuntime | null {
  return agentsRuntimeOf(state) as CompleteAgentRuntime | null;
}

/** The robot-body controller is the sole movement owner while its mode is active. */
export function runtimePlayerMotion(state: Readonly<SimState>, id: string, input: SimInput, events: readonly SimEvent[]): {
  player: PlayerState; input: SimInput; owned: boolean;
} {
  const player = state.players[id]!;
  if (!agentRuntimeSession(state)) return { player, input, owned: false };
  const controlled = completeAgentRuntimeOf(state)?.routines?.controlled.some(control => control.playerId === id) ?? false;
  const starting = events.some(event => event.kind === "agents.robot-body.start" && event.playerId === id);
  if (player.mode === "foot" && (controlled || starting)) return { player, input, owned: true };
  const combat = state.ext.combat;
  if (!combat) return { player, input, owned: false };
  const body = player.mode === "foot" && player.foot ? player.foot : player.car;
  const limit = movementLimit(combat, { id: `player:${id}`, playerId: id, kind: "player", firmware: "none",
    ...body, radius: .35, height: 1.8 });
  const cappedSpeed = (speed: number): number => {
    const magnitude = Math.min(Math.abs(speed) * limit.scale, limit.maxSpeed ?? Math.abs(speed));
    return speed < 0 ? -magnitude : magnitude;
  };
  const nextPlayer = player.mode === "foot" && player.foot
    ? { ...player, foot: { ...player.foot, speed: cappedSpeed(player.foot.speed) } }
    : { ...player, car: { ...player.car, speed: cappedSpeed(player.car.speed), lateral: cappedSpeed(player.car.lateral) } };
  return { player: nextPlayer,
    input: { ...input, throttle: limit.maxSpeed === 0 ? 0 : input.throttle * limit.scale,
      steer: limit.maxSpeed === 0 ? 0 : input.steer, brake: limit.maxSpeed === 0 ? 1 : input.brake }, owned: false };
}

function observedActors(context: SimSystemContext): CombatActor[] {
  const metadata: Record<string, Partial<CombatActor>> = {};
  const robots = context.previous.ext.robots as unknown as { metadata?: RobotRuntimeMetadata[] } | undefined;
  for (const item of robots?.metadata ?? []) metadata[item.actorId] = { firmware: item.firmware };
  return [...contextFromState(context.world, context.state, { actorMetadata: metadata, extraActors: runtimeCombatActors(context.state) }).actors];
}

function threatRequests(context: SimSystemContext): ThreatSpawnRequest[] {
  const requests: ThreatSpawnRequest[] = [];
  for (const event of context.events) {
    if (event.kind !== "threat.spawn" || !event.payload || typeof event.payload !== "object") continue;
    const value = event.payload as Partial<ThreatSpawnRequest>;
    if (typeof value.id === "string" && typeof value.playerId === "string" && context.state.players[value.playerId] &&
        Number.isSafeInteger(value.requestTick) && Number(value.requestTick) <= context.state.tick &&
        ["drone", "patrol", "swarm", "taxi"].includes(String(value.kind)) &&
        [3, 4, 5].includes(Number(value.threat)) && Number.isInteger(value.unitCount) && Number(value.unitCount) > 0 && Number(value.unitCount) <= 8) {
      requests.push(value as ThreatSpawnRequest);
    }
  }
  return requests;
}

function legacyBody(actor: AgentState, firmware: RuntimePhysicalBody["firmware"]): RuntimePhysicalBody {
  const spec = AGENT_SPEC[actor.kind];
  return { id: `agent:${actor.id}`, numericId: actor.id, firmware,
    kind: actor.kind === "person" ? "person" : actor.kind === "robotaxi" ? "vehicle" : "robot",
    model: actor.kind === "person" ? "person" : actor.kind === "robotaxi" ? "robotaxi" : actor.kind === "sidewalkBot" ? "trundle" : "footman",
    x: actor.x, y: actor.y, z: actor.z, previousX: actor.x, previousZ: actor.z, heading: actor.heading,
    previousHeading: actor.heading, speed: actor.speed, radius: spec.radius,
    halfLength: spec.halfLength, halfWidth: spec.halfWidth, height: actor.kind === "sidewalkBot" ? .7 : 1.8,
    dodge: actor.dodge };
}

/** One registered agent stage composes population, physical services and later routines. */
export const completeAgentRuntimeSystem: SimSystem = {
  key: "agents",
  step(context) {
    const base = agentRuntimeSystem.step(context);
    const session = agentRuntimeSession(base);
    if (!session) return base;
    const data = completeAgentRuntimeOf(base)!;
    const prior = completeAgentRuntimeOf(context.previous);
    const routineState = prior?.routines ?? createRoutineRuntime(context.previous.tick);
    const legacy = new Map([...base.ext.agents!.list, ...(prior?.boundLegacyActors ?? [])].map(actor => [actor.id, actor]));
    const restoreSafehouses = runtimeRestoreSafehouses(base);
    const previousMetadata = context.previous.ext.robots?.metadata;
    const metadata = Array.isArray(previousMetadata) ? previousMetadata as unknown as RobotRuntimeMetadata[] : [];
    const restored = context.previous.ext.robots?.restoredAgentIds;
    const legacyFirmware = (actor: AgentState): RuntimePhysicalBody["firmware"] => actor.kind === "person" ? "none" :
      Array.isArray(restored) && restored.includes(actor.id) ? "good" : metadata.find(item => item.actorId === `agent:${actor.id}`)?.firmware;
    const transport = stepRecruitTransport(context.world, prior?.transport ?? createRecruitTransportState(), {
      tick: base.tick, players: base.players, bodies: [...data.bodies, ...[...legacy.values()].map(actor => legacyBody(actor, legacyFirmware(actor)))],
      effects: prior?.routines?.pendingEffects ?? [], nextActorId: base.ext.agents!.nextId,
      safehouses: restoreSafehouses, restoredEffectIds: prior?.effectState?.acks ?? [],
    });
    const bound = new Set(transport.state.jobs.filter(job => job.parentVehicleId !== null).map(job => job.recruitId));
    const transportedLegacy = new Map<number, AgentState>();
    const extraBodies: RuntimePhysicalBody[] = [];
    for (const body of transport.bodies) {
      const actor = legacy.get(body.numericId);
      if (actor && body.id === `agent:${actor.id}`) {
        if (bound.has(body.id)) continue;
        if (base.ext.agents!.list.some(current => current === actor) && body.x === actor.x && body.y === actor.y && body.z === actor.z && body.heading === actor.heading) {
          transportedLegacy.set(actor.id, actor);
          continue;
        }
        const rejoined = rejoinAt(context.world, actor, body.x, body.z);
        transportedLegacy.set(actor.id, { ...actor, ...(rejoined ?? {}), x: body.x, y: body.y, z: body.z,
          heading: body.heading, speed: body.speed, dodge: body.dodge });
      } else if (!bound.has(body.id)) extraBodies.push(body);
    }
    const transportData = { ...data, bodies: extraBodies };
    const transportAgents = { ...base.ext.agents!, nextId: transport.nextActorId,
      list: [...transportedLegacy.values()].sort((a, b) => a.id - b.id), runtime: transportData };
    const transported = { ...base, ext: { ...base.ext, agents: transportAgents } };
    const nextContext = { ...context, state: transported };
    const rawRobots = context.previous.ext.robots as unknown as { metadata?: RobotRuntimeMetadata[]; reputations?: Record<string, number> } | undefined;
    const offers: Record<string, { playerId: string; offeredTick: number }> = {};
    for (const item of rawRobots?.metadata ?? []) if (item.recruitOffer) offers[item.actorId] = item.recruitOffer;
    const result = stepRoutineRuntime(nextContext, routineState, {
      bodies: extraBodies, actors: observedActors(nextContext), nextActorId: transport.nextActorId,
      reputations: rawRobots?.reputations ?? {}, recruitOffers: offers,
      convertedIds: (rawRobots?.metadata ?? []).filter(item => item.convertedTick !== null).map(item => item.actorId),
      threatRequests: threatRequests(nextContext),
      effectAcks: [...(prior?.effectState?.acks ?? []), ...transport.effectAcks],
      recruitObservations: transport.observations,
      boundActorIds: [...bound], carriedBodies: transport.bodies.filter(body => bound.has(body.id)),
      conferenceCenter: { ...CONVENTION_CENTER, y: meshGroundHeight(context.world, CONVENTION_CENTER.x, CONVENTION_CENTER.z) },
      remainingSignificantCapacity: Math.max(0, 2000 - data.population.significant - (data.population.reservedVanUnits ?? 0)),
    });
    // Calendar holds can undo only this tick's ordinary movement; final clearance still runs.
    const previousActors = new Map(agentsOf(context.previous).map(actor => [actor.id, actor]));
    const list = transportAgents.list.map(actor => {
      const override = result.actorMetadata[`agent:${actor.id}`];
      const before = previousActors.get(actor.id);
      if (!before || override?.speed !== 0 || override.x !== before.x || override.z !== before.z || actor.dodge) return actor;
      return { ...actor, x: before.x, y: before.y, z: before.z, speed: 0 };
    });
    const significantAgentIds = [...new Set([...data.significantAgentIds, ...[...legacy.keys()].filter(id => bound.has(`agent:${id}`))])].sort((a, b) => a - b);
    const significantExtras = new Set([
      ...result.state.specials.map(special => special.body.numericId),
      ...result.state.finales.map(finale => finale.body.numericId),
      ...result.bodies.filter(body => body.kind !== "animal" && body.model !== "van" && body.model !== "bus").map(body => body.numericId),
    ]);
    const runtime: CompleteAgentRuntime = { ...data, bodies: result.bodies.filter(body => !bound.has(body.id)), routines: result.state,
      transport: transport.state, restorationArrivals: transport.restorationArrivals, restoreSafehouses,
      boundLegacyActors: [...legacy.values()].filter(actor => bound.has(`agent:${actor.id}`)).map(actor => {
        const pose = transport.bodies.find(body => body.id === `agent:${actor.id}`);
        return pose ? { ...actor, x: pose.x, y: pose.y, z: pose.z, heading: pose.heading, speed: pose.speed } : actor;
      }),
      significantAgentIds,
      population: { ...data.population, significant: significantAgentIds.length + significantExtras.size, extraSignificant: significantExtras.size },
      routineOutput: { effects: result.effects, actorMetadata: result.actorMetadata, attackRequests: result.attackRequests, diagnostics: result.diagnostics, conference: result.conference, finaleWeakPoints: result.finaleWeakPoints, swarmAssignments: result.swarmAssignments, swarmSuppressedIds: result.swarmSuppressedIds, associateRiderBindings: result.associateRiderBindings },
      diagnostics: [...data.diagnostics, ...transport.diagnostics, ...result.diagnostics] };
    const agents = { ...base.ext.agents!, nextId: result.nextActorId, list, runtime };
    const currentRestored = base.ext.robots?.restoredAgentIds;
    const restoredAgentIds = [...new Set([...(Array.isArray(currentRestored) ? currentRestored.filter((id): id is number => typeof id === "number") : []), ...result.restoreIds])].sort((a, b) => a - b);
    return { ...base, players: { ...base.players, ...result.playerOverrides }, ext: { ...base.ext,
      agents, robots: { ...base.ext.robots!, restoredAgentIds } as JsonObject } };
  },
};
