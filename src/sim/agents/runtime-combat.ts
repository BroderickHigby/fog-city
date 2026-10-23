import { Action, sortedIds, type SimState } from "../contract.ts";
import type { SimSystem, SimSystemContext } from "../system-contract.ts";
import type { CombatActor, CombatContext, CombatInputs, CombatState, RefillSource, TargetCombat } from "../combat-contract.ts";
import { contextFromState } from "../combat/adapter.ts";
import { combatOf, stepCombatSystem } from "../combat/system.ts";
import { initialTarget } from "../combat/shared.ts";
import type { StoredRobotActor } from "../robots/runtime-system.ts";
import { gameplayCommandFromEvent } from "../gameplay-contract.ts";
import type { RobotAttackCancellation, RobotRuntimeStep } from "../robots/runtime.ts";
import { deriveRobotConversionScopes, type RobotConversionBaseline } from "../robots/conversion-scopes.ts";
import { agentRuntimeSession } from "./runtime-state.ts";
import { runtimeCombatActors } from "./runtime-system.ts";
import { completeAgentRuntimeOf } from "./runtime-registration.ts";
import { meshGroundHeight, type World } from "../world.ts";
import { routineSwarmAllowsAttack } from "./routine-runtime.ts";

const refillCache = new WeakMap<World, readonly RefillSource[]>();
function runtimeRefills(world: World): readonly RefillSource[] {
  if (world.gameplay?.refills) return world.gameplay.refills;
  const existing = refillCache.get(world);
  if (existing) return existing;
  const sources = (world.roads?.nodes ?? []).filter((_, i) => i % 4 === 0).map(node => ({
    id: `procedural-hydrant:${node.id}`, kind: "hydrant" as const, x: node.x, z: node.z,
    y: meshGroundHeight(world, node.x, node.z), radius: 2.5, salt: false,
  }));
  refillCache.set(world, sources);
  return sources;
}

type RobotOutput = Pick<RobotRuntimeStep, "attacks" | "cancellations" | "conversionCap"> & { readonly actors: readonly StoredRobotActor[] };

function robotOutput(state: Readonly<SimState>): RobotOutput | null {
  const value = state.ext.robots as unknown as Partial<RobotOutput> | undefined;
  return value && Array.isArray(value.actors) && Array.isArray(value.attacks) && Array.isArray(value.cancellations) &&
    typeof value.conversionCap === "number" ? value as RobotOutput : null;
}

const DEFAULT_TARGET = initialTarget();
const DEFAULT_TARGET_KEYS = Object.keys(DEFAULT_TARGET).sort() as (keyof TargetCombat)[];

/** Missing targets already expand to initialTarget in the combat owner and readers. */
export function pruneDefaultCombatTargets(combat: CombatState): CombatState {
  const targets: CombatState["targets"] = {};
  let omitted = false;
  for (const id of sortedIds(combat.targets)) {
    const target = combat.targets[id]!;
    // Preserve extensions and every non-default field, including expired timer history.
    const pristine = Object.keys(target).length === DEFAULT_TARGET_KEYS.length && DEFAULT_TARGET_KEYS.every((key) => {
      const expected = DEFAULT_TARGET[key];
      const value = target[key];
      return Array.isArray(expected) ? Array.isArray(value) && value.length === 0 : value === expected;
    });
    if (pristine) omitted = true;
    else Object.defineProperty(targets, id, { value: target, enumerable: true, configurable: true, writable: true });
  }
  return omitted ? { ...combat, targets } : combat;
}

/** A cancelled channel cannot finish while the actor changes its decision that tick. */
function cancelledPrevious(previous: Readonly<SimState>, cancellations: readonly RobotAttackCancellation[]): {
  previous: Readonly<SimState>; cancelled: readonly RobotAttackCancellation[];
} {
  const combat = combatOf(previous);
  if (!combat || cancellations.length === 0) return { previous, cancelled: [] };
  const accepted = cancellations.filter(c => combat.attacks.some(a => (!a.active || a.kind !== "ad-blast") && a.id === c.attackId &&
    a.attackerId === c.attackerId && a.targetId === c.targetId && a.kind === c.kind));
  if (accepted.length === 0) return { previous, cancelled: [] };
  const ids = new Set(accepted.map(c => c.attackId));
  return { previous: { ...previous, ext: { ...previous.ext, combat: { ...combat, attacks: combat.attacks.filter(a => !ids.has(a.id)) } } },
    cancelled: [...accepted].sort((a, b) => a.attackId < b.attackId ? -1 : a.attackId > b.attackId ? 1 : 0) };
}

function controls(context: SimSystemContext, combatContext: CombatContext): CombatInputs {
  const inputs: Record<string, CombatInputs[string]> = {};
  for (const id of sortedIds(context.state.players)) {
    const input = context.inputs[id];
    const player = combatContext.players.find(p => p.id === id)!;
    let refill: string | undefined;
    if (input && (input.actions & Action.interact) !== 0 && Math.abs(player.speed) <= 3) {
      const sources = combatContext.refills.filter(source => {
        const dx = source.x - player.x, dy = source.y - player.y, dz = source.z - player.z;
        return dx * dx + dy * dy + dz * dz <= source.radius * source.radius;
      }).sort((a, b) => {
        const distance = (p: typeof a): number => {
          const dx = p.x - player.x, dy = p.y - player.y, dz = p.z - player.z;
          return dx * dx + dy * dy + dz * dz;
        };
        return distance(a) - distance(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      refill = sources[0]?.id;
    }
    inputs[id] = {
      fire: !!input && (input.actions & Action.fire) !== 0,
      scan: !!input && (input.actions & Action.scan) !== 0,
      cone: !!input && (input.actions & Action.cone) !== 0,
      altFire: !!input && (input.actions & Action.altFire) !== 0,
      ...(input?.aimYaw !== undefined ? { aimYaw: input.aimYaw } : {}),
      ...(input?.aimPitch !== undefined ? { aimPitch: input.aimPitch } : {}),
      ...(refill ? { refill } : {}),
    };
  }
  for (const event of context.events) {
    const command = gameplayCommandFromEvent(event);
    if (!command || !Object.hasOwn(inputs, command.playerId)) continue;
    if (command.kind === "close-ad") inputs[command.playerId] = { ...inputs[command.playerId], closeAd: true };
    if (command.kind === "break-free") inputs[command.playerId] = { ...inputs[command.playerId], breakFree: true };
  }
  return inputs;
}

export function runtimeCombatContext(context: SimSystemContext): CombatContext {
  const output = robotOutput(context.state);
  const metadata: Record<string, Partial<CombatActor>> = {};
  for (const actor of output?.actors ?? []) metadata[actor.id] = actor;
  const routine = completeAgentRuntimeOf(context.state)?.routineOutput;
  for (const id of sortedIds(routine?.actorMetadata ?? {})) {
    const value = routine!.actorMetadata[id]!;
    const robot = metadata[id];
    metadata[id] = { ...robot, ...value, ...(robot?.kind === "robot" && id.startsWith("agent:") ? { firmware: robot.firmware } : {}) };
  }
  const session = agentRuntimeSession(context.state)!;
  const extras = runtimeCombatActors(context.state);
  const mapped = contextFromState(context.world, context.state, {
    wave: Math.min(5, session.wave) as 2 | 3 | 4 | 5,
    actorMetadata: metadata,
    extraActors: extras.map(actor => ({ ...actor, ...metadata[actor.id], id: actor.id, x: actor.x, y: actor.y, z: actor.z,
      heading: actor.heading, speed: actor.speed })).concat(routine?.finaleWeakPoints ?? []),
    attacks: [...(output?.attacks ?? []), ...(routine?.attackRequests ?? [])].filter(attack => !routine || routineSwarmAllowsAttack(routine, attack)),
    conversionCap: output?.conversionCap ?? 0,
    refills: runtimeRefills(context.world),
  });
  const rawBaselines = context.state.ext.robots?.baselines;
  if (!Array.isArray(rawBaselines)) return { ...mapped, conversionScopes: [] };
  const conversionScopes = deriveRobotConversionScopes(context.world, mapped.players.map(player => ({ id: player.id, x: player.x, z: player.z })),
    mapped.actors, rawBaselines as unknown as readonly RobotConversionBaseline[], context.state.ext.robots?.protectedArea === true, session.worldName);
  return { ...mapped, conversionScopes };
}

/** Combat owns wind-up clocks, water physics, rust and reward events. */
export const runtimeCombatSystem: SimSystem = {
  key: "combat",
  step(context) {
    if (!agentRuntimeSession(context.state)) return context.state;
    const output = robotOutput(context.state);
    const routine = completeAgentRuntimeOf(context.state)?.routineOutput;
    const suppressed: RobotAttackCancellation[] = routine ? (combatOf(context.previous)?.attacks ?? []).filter(attack => !routineSwarmAllowsAttack(routine, attack)).map(attack => ({
      attackId: attack.id, attackerId: attack.attackerId, targetId: attack.targetId, kind: attack.kind, reason: "policy" as const,
    })) : [];
    const cancellationById = new Map([...(output?.cancellations ?? []), ...suppressed].map(item => [item.attackId, item]));
    const cancelled = cancelledPrevious(context.previous, [...cancellationById.values()]);
    const combatContext = runtimeCombatContext(context);
    let next = stepCombatSystem(cancelled.previous, context.state, combatContext, controls(context, combatContext));
    if (cancelled.cancelled.length) {
      const previous = next.ext.combat!;
      const combat: CombatState = { ...previous, events: [...previous.events] };
      for (const item of cancelled.cancelled) {
        combat.events.push({ id: combat.nextId++, tick: next.tick, kind: "attack.cancelled", sourceId: item.attackerId,
          targetId: item.targetId, amount: 0, detail: `${item.kind}:${item.reason}` });
        if (item.kind === "forced-update") combat.events.push({ id: combat.nextId++, tick: next.tick, kind: "update.interrupted",
          sourceId: item.attackerId, targetId: item.targetId, amount: 0, detail: item.reason });
      }
      next = { ...next, ext: { ...next.ext, combat } };
    }
    const combat = next.ext.combat!;
    const compact = pruneDefaultCombatTargets(combat);
    return compact === combat ? next : { ...next, ext: { ...next.ext, combat: compact } };
  },
};
