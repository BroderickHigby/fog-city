import { Action, sortedIds, TICK_HZ } from "../contract.ts";
import { dcos, dsin, PI } from "../dmath.ts";
import type { SimSystemContext } from "../system-contract.ts";
import { segmentBlocked } from "../world.ts";
import { ATTACK_EVENT, ATTACK_SPECS } from "../combat/attacks.ts";
import { combatOf, movementLimit } from "../combat/system.ts";
import type { AttackKind, AttackRequest, CombatActor, CombatEvent, PendingAttack, RobotModel, Vec3 } from "../combat/types.ts";
import {
  createRobotBrain, stepRobotBrain, type RobotArchetype, type RobotBrainInput, type RobotBrainIntent, type RobotBrainState,
  type RobotBroadcast, type RobotGoal, type RobotMovementIntent, type RobotObservations,
} from "./brain.ts";

export const MAX_RUNTIME_ROBOTS = 4096;
export const MAX_RUNTIME_PLAYERS = 24;
export type RobotSignificance = "rusted" | "scanned" | "converted" | "recruitable" | "mission" | "engaged";
export interface RobotRecruitOffer { readonly playerId: string; readonly offeredTick: number }
export interface RobotRuntimeEntry {
  readonly agentId: number;
  readonly firmware: "good" | "bad";
  readonly model: RobotModel | null;
  readonly brain: RobotBrainState | null;
  readonly lastPosition: Readonly<Vec3>;
  readonly sequence: number;
  readonly cooldownUntilTick: number;
  readonly convertedTick: number | null;
  readonly bountyUntilTick: number;
  readonly recruitOffer: RobotRecruitOffer | null;
  readonly significant: readonly RobotSignificance[];
}
export interface RobotRuntimeState {
  readonly version: 1;
  readonly tick: number;
  readonly lastCombatEventId: number;
  readonly robots: readonly RobotRuntimeEntry[];
}
export interface RobotRuntimeOptions {
  /** Current authoritative physical descriptors; this adapter never changes their poses. */
  readonly actors: readonly CombatActor[];
  readonly conversion: { readonly baseBadCount: number; readonly protectedArea: boolean };
  readonly fogDensity?: number;
  readonly fleetUpdate?: boolean;
  readonly wave?: 2 | 3 | 4 | 5;
  readonly goalWeights?: Readonly<Partial<Record<RobotGoal, number>>>;
  readonly reputations?: Readonly<Record<string, number>>;
  readonly missionIds?: readonly number[];
  /** A body owner explicitly confirms a restore; ordinary default-good descriptors do not erase a conversion. */
  readonly restoredIds?: readonly number[];
  /** Physical retirement acknowledged by the body owner. Significant absent actors otherwise survive. */
  readonly retiredIds?: readonly number[];
}
export interface RobotAttackCancellation {
  readonly attackId: string;
  readonly attackerId: string;
  readonly targetId: string;
  readonly kind: AttackKind;
  readonly reason: "policy" | "inactive" | "retired";
}
export interface RobotLocomotion {
  readonly agentId: number;
  readonly intent: RobotMovementIntent;
  readonly combat: { readonly maxSpeed: number | null; readonly scale: number; readonly blind: boolean; readonly canAttack: boolean };
}
export interface RobotRuntimeResult {
  readonly eventId: number;
  readonly tick: number;
  readonly kind: "converted" | "interrupted" | "seized" | "scanned";
  readonly agentId: number;
  readonly sourceId: string;
  readonly rescuerId: string | null;
}
export interface RobotRuntimeStep {
  readonly state: RobotRuntimeState;
  /** Fresh descriptors with persistent alignment and pursuit metadata applied. */
  readonly actors: readonly CombatActor[];
  readonly attacks: readonly AttackRequest[];
  /** The combat integration must apply these; no fake firmware/visibility is used for cancellation. */
  readonly cancellations: readonly RobotAttackCancellation[];
  readonly locomotion: readonly RobotLocomotion[];
  readonly results: readonly RobotRuntimeResult[];
  readonly conversionCap: number;
}

const ATTACK_KIND = { shove: "shove", grocerySnatch: "snatch", adBlast: "ad-blast", phoneHack: "phone-hack", handshake: "handshake" } as const;
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function natural(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(label);
}
/** No suffix coercion, leading zero aliases, negative values, or foreign IDs. */
export function robotAgentId(id: string): number | null {
  if (!/^agent:(0|[1-9][0-9]*)$/.test(id)) return null;
  const value = Number(id.slice(6));
  return Number.isSafeInteger(value) ? value : null;
}
export function robotActorId(id: number): string { natural(id, "agent id"); return `agent:${id}`; }
function archetype(model: RobotModel | undefined): RobotArchetype | null {
  return model === "footman" || model === "trundle" || model === "patrol" ? model : null;
}
function distanceSq(a: Pick<Vec3, "x" | "z">, b: Pick<Vec3, "x" | "z">): number {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
}
function position(actor: Vec3): Vec3 { return { x: actor.x, y: actor.y, z: actor.z }; }
function cloneBrain(brain: RobotBrainState): RobotBrainState {
  return { ...brain, knowledge: brain.knowledge.map(value => ({ ...value })), closeWatches: brain.closeWatches.map(value => ({ ...value })),
    windup: null, update: null, pendingUpdates: [] };
}
function cloneEntry(entry: RobotRuntimeEntry): RobotRuntimeEntry {
  return { ...entry, lastPosition: { ...entry.lastPosition }, brain: entry.brain ? cloneBrain(entry.brain) : null,
    recruitOffer: entry.recruitOffer ? { ...entry.recruitOffer } : null, significant: [...entry.significant] };
}
function significant(entry: RobotRuntimeEntry, reason: RobotSignificance): RobotRuntimeEntry {
  return entry.significant.includes(reason) ? entry : { ...entry, significant: [...entry.significant, reason].sort(compare) };
}
function newEntry(actor: CombatActor, id: number, tick: number): RobotRuntimeEntry {
  const model = archetype(actor.model);
  return { agentId: id, firmware: actor.firmware === "bad" ? "bad" : "good", model: actor.model ?? null,
    brain: model ? createRobotBrain({ id, archetype: model, tick }) : null, lastPosition: position(actor), sequence: 0,
    cooldownUntilTick: 0, convertedTick: null, bountyUntilTick: 0, recruitOffer: null, significant: [] };
}
function playerBody(context: SimSystemContext, id: string, previous = false) {
  const player = (previous ? context.previous : context.state).players[id];
  return player ? player.mode === "foot" && player.foot ? player.foot : player.car : undefined;
}
function desiredAttack(intent: RobotBrainIntent): { kind: AttackKind; targetId: string } | null {
  if (intent.action.kind === "update") return { kind: "forced-update", targetId: robotActorId(intent.action.targetId) };
  if (intent.action.kind !== "windup" && intent.action.kind !== "attack") return null;
  return { kind: ATTACK_KIND[intent.action.attack], targetId: intent.action.target.kind === "robot" ? robotActorId(intent.action.target.id) : intent.action.target.id };
}
function normalizedPlayerTarget(id: string, actors: readonly CombatActor[]): string {
  return actors.find(actor => actor.id === id && actor.kind === "player")?.playerId ?? id;
}
function sameRequest(pending: PendingAttack, desired: { kind: AttackKind; targetId: string }, actors: readonly CombatActor[]): boolean {
  return pending.kind === desired.kind && normalizedPlayerTarget(pending.targetId, actors) === normalizedPlayerTarget(desired.targetId, actors);
}
function visible(context: SimSystemContext, from: Vec3, to: Vec3, range = 30): boolean {
  return distanceSq(from, to) <= range * range && !segmentBlocked(context.world, from.x, from.z, to.x, to.z);
}

interface IndexedRobot { readonly actor: CombatActor; readonly id: number; readonly order: number }
type RobotSightIndex = Map<number, Map<number, IndexedRobot[]>>;
const SIGHT_CELL_M = 30;
function indexRobots(actors: readonly CombatActor[]): RobotSightIndex {
  const grid: RobotSightIndex = new Map();
  for (let order = 0; order < actors.length; order++) {
    const actor = actors[order]!, id = robotAgentId(actor.id);
    if (actor.kind !== "robot" || id === null) continue;
    const x = Math.floor(actor.x / SIGHT_CELL_M), z = Math.floor(actor.z / SIGHT_CELL_M);
    let column = grid.get(x);
    if (!column) { column = new Map(); grid.set(x, column); }
    let cell = column.get(z);
    if (!cell) { cell = []; column.set(z, cell); }
    cell.push({ actor, id, order });
  }
  return grid;
}
function nearbyRobots(grid: RobotSightIndex, point: Pick<Vec3, "x" | "z">): IndexedRobot[] {
  const result: IndexedRobot[] = [], visited = new Set<readonly IndexedRobot[]>();
  // Include both endpoints: a target exactly 30 m away remains a sight candidate.
  // Distinct bucket identities also avoid duplication at very large finite coordinates.
  const xs = [Math.floor((point.x - SIGHT_CELL_M) / SIGHT_CELL_M), Math.floor(point.x / SIGHT_CELL_M), Math.floor((point.x + SIGHT_CELL_M) / SIGHT_CELL_M)];
  const zs = [Math.floor((point.z - SIGHT_CELL_M) / SIGHT_CELL_M), Math.floor(point.z / SIGHT_CELL_M), Math.floor((point.z + SIGHT_CELL_M) / SIGHT_CELL_M)];
  for (const x of xs) {
    const column = grid.get(x);
    if (!column) continue;
    for (const z of zs) {
      const cell = column.get(z);
      if (!cell || visited.has(cell)) continue;
      visited.add(cell);
      for (const target of cell) if (distanceSq(point, target.actor) <= SIGHT_CELL_M * SIGHT_CELL_M) result.push(target);
    }
  }
  // Preserve the original canonical actor order, independent of bucket traversal.
  return result.sort((a, b) => a.order - b.order);
}

export function createRobotRuntime(tick = 0): RobotRuntimeState {
  natural(tick, "runtime tick");
  return { version: 1, tick, lastCombatEventId: 0, robots: [] };
}

/**
 * Run before combat. The brain supplies decisions only: its standalone attack/channel clocks
 * are discarded every tick. The first wind-up intent becomes a request immediately; accepted
 * combat attacks own all timers, completion effects and rejection. Body movement is external.
 */
export function stepRobotRuntime(previous: RobotRuntimeState, context: SimSystemContext, options: RobotRuntimeOptions): RobotRuntimeStep {
  const tick = context.state.tick, combat = combatOf(context.previous);
  natural(tick, "runtime tick"); natural(options.conversion.baseBadCount, "base bad count");
  if (previous.version !== 1 || previous.tick !== context.previous.tick || tick !== previous.tick + 1) throw new Error("Robot runtime ticks must be consecutive");
  if (combat && combat.tick !== context.previous.tick) throw new Error("Robot runtime combat snapshot is stale");
  if (options.actors.length > MAX_RUNTIME_ROBOTS || previous.robots.length > MAX_RUNTIME_ROBOTS) throw new Error("Robot runtime capacity exceeded");
  const playerIds = sortedIds(context.state.players);
  if (playerIds.length > MAX_RUNTIME_PLAYERS) throw new Error("Robot runtime player capacity exceeded");
  const fog = options.fogDensity ?? 0;
  if (!Number.isFinite(fog) || fog < 0 || fog > 1) throw new RangeError("fog density");
  const actors = [...options.actors].sort((a, b) => compare(a.id, b.id)).map(actor => ({ ...actor }));
  const actorById = new Map(actors.map(actor => [actor.id, actor]));
  const playerBodies = new Map(playerIds.map(id => [id, playerBody(context, id)!]));
  const actorIds = new Set<string>();
  for (const actor of actors) {
    if (actorIds.has(actor.id) || ![actor.x, actor.y, actor.z, actor.heading, actor.speed].every(Number.isFinite)) throw new Error("Invalid runtime actor");
    actorIds.add(actor.id);
  }
  const retired = new Set(options.retiredIds ?? []), restored = new Set(options.restoredIds ?? []), mission = new Set(options.missionIds ?? []);
  for (const list of [options.retiredIds, options.restoredIds, options.missionIds]) for (const id of list ?? []) natural(id, "runtime metadata id");
  const entries = new Map(previous.robots.filter(entry => !retired.has(entry.agentId)).map(entry => [entry.agentId, cloneEntry(entry)]));
  const present = new Set<number>();
  for (const actor of actors) {
    const id = robotAgentId(actor.id);
    if (id === null || actor.kind !== "robot" || actor.firmware === "none" || retired.has(id)) continue;
    present.add(id);
    let entry = entries.get(id) ?? newEntry(actor, id, tick);
    entry = { ...entry, model: actor.model ?? null, firmware: entry.convertedTick !== null && !restored.has(id) ? "bad" : actor.firmware,
      convertedTick: restored.has(id) ? null : entry.convertedTick, lastPosition: position(actor) };
    if (mission.has(id)) entry = significant(entry, "mission");
    if ((combat?.targets[actor.id]?.rust ?? 0) > 0) entry = significant(entry, "rusted");
    entries.set(id, entry);
  }
  const results: RobotRuntimeResult[] = [];
  const freshEvents = [...(combat?.events ?? [])].filter(event => event.id > previous.lastCombatEventId).sort((a, b) => a.id - b.id);
  let lastCombatEventId = previous.lastCombatEventId;
  for (const event of freshEvents) {
    natural(event.id, "combat event id"); natural(event.tick, "combat event tick");
    if (event.id <= lastCombatEventId || event.tick > context.previous.tick) throw new Error("Invalid combat event sequence");
    lastCombatEventId = event.id;
    const id = robotAgentId(event.targetId), entry = id === null ? undefined : entries.get(id);
    // Sustained effects remain owned by combat after resolution. Starting a cooldown
    // here would make the next policy step cancel a live handshake or phone hack.
    if (event.kind === ATTACK_EVENT.ended || event.kind === ATTACK_EVENT.cancelled ||
        event.kind === ATTACK_EVENT.resolved && (event.detail === "shove" || event.detail === "snatch" || event.detail === "forced-update")) {
      const sourceId = robotAgentId(event.sourceId), source = sourceId === null ? undefined : entries.get(sourceId);
      if (source) entries.set(source.agentId, { ...source, cooldownUntilTick: tick + TICK_HZ });
    }
    if (!entry || id === null) continue;
    let updated = entry;
    let resultKind: RobotRuntimeResult["kind"] | null = null, rescuerId: string | null = null;
    if (event.kind === ATTACK_EVENT.converted) {
      updated = significant({ ...entry, firmware: "bad", convertedTick: event.tick, bountyUntilTick: event.tick + 60 * TICK_HZ, recruitOffer: null }, "converted");
      resultKind = "converted";
    } else if (event.kind === ATTACK_EVENT.interrupted) {
      updated = significant(updated, "engaged");
      const pusher = combat?.targets[event.sourceId];
      // Combat records the last actual water owner. No nearby player is guessed as rescuer.
      if (pusher && pusher.rust >= 0.2 && pusher.lastWaterTick === event.tick && playerIds.includes(pusher.sourceId)) rescuerId = pusher.sourceId;
      if (rescuerId && (options.reputations?.[rescuerId] ?? 0) >= 60 && updated.firmware === "good") {
        updated = significant({ ...updated, recruitOffer: { playerId: rescuerId, offeredTick: event.tick } }, "recruitable");
      }
      resultKind = "interrupted";
    } else if (event.kind === "robot.seized" || event.kind === "robot.disabled") {
      updated = significant(entry, "rusted"); resultKind = "seized";
    } else if (event.kind === "scan.result") {
      updated = significant(entry, "scanned"); resultKind = "scanned";
    }
    entries.set(id, updated);
    if (resultKind) results.push({ eventId: event.id, tick: event.tick, kind: resultKind, agentId: id, sourceId: event.sourceId, rescuerId });
  }
  // Keep interacted identities even after physical demotion; remove only disposable absentees.
  for (const [id, entry] of entries) if (!present.has(id) && entry.significant.length === 0) entries.delete(id);
  if (entries.size > MAX_RUNTIME_ROBOTS) throw new Error("Robot runtime significant capacity exceeded");
  for (const actor of actors) {
    const id = robotAgentId(actor.id), entry = id === null ? undefined : entries.get(id);
    if (actor.kind === "robot" && entry) actor.firmware = entry.firmware;
  }
  const sightIndex = indexRobots(actors);

  const broadcasts: RobotBroadcast[] = [];
  for (const event of freshEvents) {
    if (event.kind !== "robot.seized" && event.kind !== "robot.disabled") continue;
    const id = robotAgentId(event.targetId), source = previous.robots.find(entry => entry.agentId === id);
    if (!source?.brain || source.firmware !== "bad") continue;
    const known = [...source.brain.knowledge].sort((a, b) => b.observedTick - a.observedTick || compare(a.playerId, b.playerId));
    const target = known.find(knowledge => knowledge.playerId === event.sourceId) ?? known[0];
    if (!target) continue;
    broadcasts.push({ sourceId: source.agentId, sourcePosition: { x: source.lastPosition.x, z: source.lastPosition.z }, sourceSeized: true,
      emittedTick: event.tick, observedTick: target.observedTick, playerId: target.playerId, position: { x: target.x, z: target.z } });
  }
  const sounds: RobotObservations["sounds"][number][] = [];
  for (const event of freshEvents) if (event.kind === "weapon.water") {
    const body = playerBody(context, event.sourceId, true);
    if (body) sounds.push({ kind: "spray", playerId: event.sourceId, x: body.x, z: body.z });
  }
  const watchTargets = new Map<string, number>();
  for (const id of playerIds) {
    const body = playerBodies.get(id)!, input = context.inputs[id];
    if ((input?.actions ?? 0) & Action.horn) sounds.push({ kind: "horn", playerId: id, x: body.x, z: body.z });
    if (!((input?.actions ?? 0) & Action.watch) || context.state.players[id]!.mode !== "foot" && Math.abs(body.speed) > 0.1) continue;
    const heading = input?.aimYaw ?? body.heading;
    const candidates = nearbyRobots(sightIndex, body).filter(target => visible(context, body, target.actor));
    candidates.sort((a, b) => distanceSq(body, a.actor) - distanceSq(body, b.actor) || a.id - b.id);
    const target = candidates.find(({ actor }) => {
      const distance = Math.sqrt(distanceSq(body, actor));
      return distance === 0 || ((actor.x - body.x) * dsin(heading) - (actor.z - body.z) * dcos(heading)) / distance >= dcos(10 * PI / 180);
    });
    if (target) watchTargets.set(id, target.id);
  }
  const activeIds = new Set<string>();
  for (const actor of actors) {
    const near = playerIds.length > 0 ? playerIds.some(id => distanceSq(actor, playerBodies.get(id)!) <= 350 * 350) : actor.inFidelity === true;
    if (actor.inFidelity !== false && near && (combat?.targets[actor.id]?.phase ?? "active") === "active") activeIds.add(actor.id);
  }
  const badCount = actors.filter(actor => actor.kind === "robot" && actor.firmware === "bad" && activeIds.has(actor.id)).length;
  const conversionCap = options.conversion.baseBadCount * (options.conversion.protectedArea ? 1 : 2);
  const pendingAttacks = [...(combat?.attacks ?? [])].sort((a, b) => compare(a.attackerId, b.attackerId) || compare(a.id, b.id));
  const reservations = new Set(pendingAttacks.filter(attack => attack.kind === "forced-update").map(attack => attack.targetId));
  const attacks: AttackRequest[] = [], cancellations: RobotAttackCancellation[] = [], locomotion: RobotLocomotion[] = [];
  const orderedEntries = [...entries.keys()].sort((a, b) => a - b);
  for (const id of orderedEntries) {
    let entry = entries.get(id)!;
    const descriptor = actorById.get(robotActorId(id));
    const actor = descriptor?.kind === "robot" ? descriptor : undefined;
    const pending = pendingAttacks.find(attack => attack.attackerId === robotActorId(id));
    const limits = actor && combat ? movementLimit(combat, actor) : { maxSpeed: null, scale: 1, blind: false, canAttack: true };
    const operational = !!actor && activeIds.has(actor.id) && !actor.protected && !retired.has(id);
    let decision: RobotBrainIntent | null = null;
    if (actor && operational && entry.firmware === "bad" && entry.brain) {
      const scans: RobotObservations["scans"][number][] = [];
      for (const event of freshEvents) if (event.kind === "robot.wary" && event.targetId === actor.id) {
        const body = playerBody(context, event.sourceId, true);
        if (body) scans.push({ playerId: event.sourceId, x: body.x, z: body.z,
          targetRobotId: freshEvents.some(other => other.kind === "robot.alert" && other.targetId === actor.id && other.sourceId === event.sourceId) ? id : null });
      }
      const sight: RobotObservations["sight"][number][] = [];
      if (!limits.blind) {
        for (const playerId of playerIds) {
          const body = playerBodies.get(playerId)!;
          if (distanceSq(actor, body) > SIGHT_CELL_M * SIGHT_CELL_M) continue;
          sight.push({ kind: "player", id: playerId, x: body.x, z: body.z, heading: body.heading,
            inVehicle: context.state.players[playerId]!.mode !== "foot", threatening: ((context.inputs[playerId]?.actions ?? 0) & Action.fire) !== 0,
            lineOfSight: visible(context, actor, body) });
        }
        for (const { actor: target, id: targetId } of nearbyRobots(sightIndex, actor)) {
          if (target.firmware === "none" || target.protected) continue;
          sight.push({ kind: "robot", id: targetId, x: target.x, z: target.z, alignment: target.firmware,
            operational: activeIds.has(target.id), lineOfSight: visible(context, actor, target) });
        }
      }
      const own = combat?.targets[actor.id];
      const reservedCount = reservations.size - (pending?.kind === "forced-update" && reservations.has(pending.targetId) ? 1 : 0);
      const weights = { ...options.goalWeights, ...((options.wave ?? 2) < 3 ? { phoneHack: 0 } : {}) };
      const policyState = { ...cloneBrain(entry.brain), cooldownUntilTick: entry.cooldownUntilTick };
      const policyInput: RobotBrainInput = {
        tick, self: { x: actor.x, z: actor.z, heading: actor.heading, rust: own?.rust ?? 0, fogDensity: fog,
          shoved: freshEvents.some(event => event.kind === ATTACK_EVENT.knockdown && event.targetId === actor.id) },
        observations: { sight, sounds, broadcasts, scans, watches: playerIds.filter(playerId => watchTargets.get(playerId) === id).map(playerId => {
          const body = playerBody(context, playerId)!; return { playerId, x: body.x, z: body.z, lineOfSight: true };
        }) },
        conversion: { ...options.conversion, withinFidelity: actor.inFidelity !== false, badCount, reservedCount },
        goalWeights: weights, fleetUpdate: options.fleetUpdate,
        meleeSlotsAvailable: 2,
      };
      let stepped = stepRobotBrain(policyState, policyInput);
      const firstChoice = desiredAttack(stepped.intent);
      if (firstChoice && robotAgentId(firstChoice.targetId) !== null &&
          firstChoice.kind !== "shove" && firstChoice.kind !== "snatch" && firstChoice.kind !== "forced-update") {
        // The standalone policy also describes future robot effects. Current combat
        // supports only these three against robots; reselect rather than stalling.
        stepped = stepRobotBrain(policyState, { ...policyInput, goalWeights: { ...weights, adBlast: 0, phoneHack: 0, handshake: 0 } });
      } else if (firstChoice && robotAgentId(firstChoice.targetId) === null) {
        const occupied = pendingAttacks.filter(attack => attack.attackerId !== actor.id && ATTACK_SPECS[attack.kind].melee &&
          normalizedPlayerTarget(attack.targetId, actors) === firstChoice.targetId).length +
          attacks.filter(attack => ATTACK_SPECS[attack.kind].melee && attack.targetId === firstChoice.targetId).length;
        if (occupied > 0) stepped = stepRobotBrain(policyState, { ...policyInput, meleeSlotsAvailable: Math.max(0, 2 - occupied) });
      }
      entry = { ...entry, brain: cloneBrain(stepped.state) };
      decision = stepped.intent;
    }
    const desired = decision && limits.canAttack ? desiredAttack(decision) : null;
    const deliveredPopup = pending?.active && pending.kind === "ad-blast";
    const continuing = !!pending && (deliveredPopup || !!desired && sameRequest(pending, desired, actors));
    if (pending && !continuing) {
      cancellations.push({ attackId: pending.id, attackerId: pending.attackerId, targetId: pending.targetId, kind: pending.kind,
        reason: retired.has(id) ? "retired" : operational ? "policy" : "inactive" });
      if (pending.kind === "forced-update") reservations.delete(pending.targetId);
    }
    if (desired && !pending && tick >= entry.cooldownUntilTick && actor && operational && ATTACK_SPECS[desired.kind].models.includes(actor.model!)) {
      // Combat accepts only shove/snatch/update against robots. Other robot-targeted brain
      // choices are discarded instead of manufacturing an eligible human target.
      const robotTarget = robotAgentId(desired.targetId);
      if (robotTarget === null || desired.kind === "shove" || desired.kind === "snatch" || desired.kind === "forced-update") {
        const sequence = Math.max(entry.sequence, combat?.attackSequence[actor.id] ?? 0) + 1;
        natural(sequence, "attack sequence");
        attacks.push({ id: `${actor.id}/attack/${sequence}`, sequence, attackerId: actor.id, targetId: desired.targetId, kind: desired.kind });
        entry = significant({ ...entry, sequence }, "engaged");
        if (desired.kind === "forced-update") reservations.add(desired.targetId);
      }
    }
    if (actor) {
      const stopped = !operational || limits.maxSpeed === 0 || continuing && pending?.kind === "forced-update";
      locomotion.push({ agentId: id, intent: stopped ? { kind: "hold", face: null, avoidFog: options.fleetUpdate !== true } :
        decision?.movement ?? { kind: "errand", avoidFog: options.fleetUpdate !== true }, combat: { ...limits } });
      actor.pursuing = decision?.fogRustMultiplier === 3;
    }
    entries.set(id, entry);
  }
  // Retired sources are absent from entries, but their accepted channels still need explicit cancellation.
  for (const pending of pendingAttacks) if (retired.has(robotAgentId(pending.attackerId) ?? -1) && !(pending.active && pending.kind === "ad-blast")) {
    cancellations.push({ attackId: pending.id, attackerId: pending.attackerId, targetId: pending.targetId, kind: pending.kind, reason: "retired" });
  }
  return { state: { version: 1, tick, lastCombatEventId, robots: [...entries.values()].sort((a, b) => a.agentId - b.agentId) },
    actors, attacks, cancellations, locomotion, results, conversionCap };
}
