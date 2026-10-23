import { Action, type InputFrame } from "../contract.ts";
import type { SimSystem, SimSystemContext } from "../system-contract.ts";
import { combatOf, stepCombatSystem } from "./system.ts";
import { sortedPlayers } from "./shared.ts";
import type { CombatContext, CombatInput, CombatInputs, CombatPlayer, CombatState, RefillSource } from "./types.ts";

export interface CombatSystemSnapshot {
  context: CombatContext;
  /** An explicit input map replaces the recorded-control defaults, including when empty. */
  inputs?: CombatInputs;
}

export type CombatContextProvider = (system: SimSystemContext) => CombatSystemSnapshot;

function refillDistance(player: CombatPlayer, source: RefillSource): number {
  const dx = player.x - source.x, dy = player.y - source.y, dz = player.z - source.z;
  return dx * dx + dy * dy + dz * dz;
}

function nearestRefill(ctx: CombatContext, player: CombatPlayer, state: CombatState | undefined): string | undefined {
  if (Math.abs(player.speed) > 3) return undefined;
  let nearest: RefillSource | undefined;
  let distance = Infinity;
  for (const source of ctx.refills) {
    if (!source.id || ![source.x, source.y, source.z, source.radius].every(Number.isFinite) || source.radius <= 0) continue;
    if (source.kind === "trunk" && (!player.trunk || source.ownerId !== player.id ||
        (state?.players[player.id]?.reserve ?? 20) <= 0)) continue;
    const candidate = refillDistance(player, source);
    if (candidate > source.radius * source.radius || candidate > distance ||
        candidate === distance && nearest !== undefined && source.id >= nearest.id) continue;
    nearest = source;
    distance = candidate;
  }
  return nearest?.id;
}

function recordedInputs(frame: InputFrame, ctx: CombatContext, state: CombatState | undefined): CombatInputs {
  const mapped: Record<string, CombatInput> = {};
  for (const player of sortedPlayers(ctx)) {
    const recorded = frame[player.id];
    if (!recorded) { mapped[player.id] = {}; continue; }
    const input: CombatInput = {
      fire: (recorded.actions & Action.fire) !== 0,
      scan: (recorded.actions & Action.scan) !== 0,
      cone: (recorded.actions & Action.cone) !== 0,
      altFire: (recorded.actions & Action.altFire) !== 0,
      gear: (recorded.actions & Action.gear) !== 0,
    };
    if (recorded.aimYaw !== undefined) input.aimYaw = recorded.aimYaw;
    if (recorded.aimPitch !== undefined) input.aimPitch = recorded.aimPitch;
    if ((recorded.actions & Action.gadget) !== 0 && player.gadget) input.gadget = player.gadget;
    if ((recorded.actions & Action.interact) !== 0) {
      const source = nearestRefill(ctx, player, state);
      if (source !== undefined) input.refill = source;
    }
    mapped[player.id] = input;
  }
  return mapped;
}

/** Register only when the caller can supply current actor, loadout and world data. */
export function createCombatSystem(provider: CombatContextProvider): SimSystem {
  return {
    key: "combat",
    step(system) {
      const snapshot = provider(system);
      const inputs = snapshot.inputs ?? recordedInputs(system.inputs, snapshot.context, combatOf(system.previous));
      return stepCombatSystem(system.previous, system.state, snapshot.context, inputs);
    },
  };
}

/** World/actor owners opt in with createCombatSystem; there is no fabricated default provider. */
export const systems: readonly SimSystem[] = Object.freeze([]);
