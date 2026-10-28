/** SIM21 selected pause helper; called on the reducer-owned clone, never on previous input. */
import { sortedIds } from "../contract.ts";
import type { CombatState } from "./types.ts";

/** Move an active deadline with the stopped combat clock, leaving unset values alone. */
function holdDeadline(deadline: number, currentTick: number): number {
  return deadline > 0 && deadline < Number.MAX_SAFE_INTEGER && deadline >= currentTick ? deadline + 1 : deadline;
}

/** A recorded tick can legitimately be zero; negative values are unset sentinels. */
function holdTimestamp(tick: number): number {
  return tick >= 0 && tick < Number.MAX_SAFE_INTEGER ? tick + 1 : tick;
}

/**
 * Called on the owned clone after advancing the outer tick during AGI's pause.
 * The pause deadline itself stays fixed. Durations and progress resume exactly
 * where they stopped; no input, resource consumption, or effect resolves here.
 */
export function holdCombatTimers(state: CombatState): void {
  for (const id of sortedIds(state.players)) {
    const player = state.players[id]!;
    player.nextWaterTick = holdDeadline(player.nextWaterTick, state.tick);
    player.nextConeTick = holdDeadline(player.nextConeTick, state.tick);
    player.nextFlowerTick = holdDeadline(player.nextFlowerTick, state.tick);
    player.nextGadgetTick = holdDeadline(player.nextGadgetTick, state.tick);
    player.nextGearTick = holdDeadline(player.nextGearTick, state.tick);
    player.nextScanTick = holdDeadline(player.nextScanTick, state.tick);
    player.gearUntil = holdDeadline(player.gearUntil, state.tick);
    player.boostUntil = holdDeadline(player.boostUntil, state.tick);
    player.lastParrotsTick = holdTimestamp(player.lastParrotsTick);
    for (const mark of player.marks) mark.untilTick = holdDeadline(mark.untilTick, state.tick);
  }
  for (const id of sortedIds(state.targets)) {
    const target = state.targets[id]!;
    if (target.phase !== "active") target.phaseTick = holdTimestamp(target.phaseTick);
    target.lastWaterTick = holdTimestamp(target.lastWaterTick);
    if(target.lastDirectWaterTick!==undefined)target.lastDirectWaterTick=holdTimestamp(target.lastDirectWaterTick);
    target.wetHits = target.wetHits.map(holdTimestamp);
    target.wetUntil = holdDeadline(target.wetUntil, state.tick);
    target.blindUntil = holdDeadline(target.blindUntil, state.tick);
    target.waryUntil = holdDeadline(target.waryUntil, state.tick);
    target.pullOverTick = holdDeadline(target.pullOverTick, state.tick);
    target.stoppedUntil = holdDeadline(target.stoppedUntil, state.tick);
    target.flowersUntil = holdDeadline(target.flowersUntil, state.tick);
    target.slowUntil = holdDeadline(target.slowUntil, state.tick);
    target.distractedUntil = holdDeadline(target.distractedUntil, state.tick);
  }
  state.projectiles=state.projectiles.filter(projectile=>Object.hasOwn(state.players,projectile.ownerId));
  state.gadgets=state.gadgets.filter(gadget=>Object.hasOwn(state.players,gadget.ownerId));
  if(state.flowerReceipts)state.flowerReceipts=state.flowerReceipts.filter(receipt=>Object.hasOwn(state.players,receipt.ownerId)).map(receipt=>({...receipt,untilTick:holdDeadline(receipt.untilTick,state.tick)}));
  for(const id of sortedIds(state.maintenanceChannels??{})){const channel=state.maintenanceChannels![id]!;channel.startedTick=holdTimestamp(channel.startedTick);channel.lastTick=holdTimestamp(channel.lastTick);}
  for (const projectile of state.projectiles) projectile.bornTick = holdTimestamp(projectile.bornTick);
  for (const gadget of state.gadgets) gadget.untilTick = holdDeadline(gadget.untilTick, state.tick);
  for (const attack of state.attacks) {
    attack.startTick = holdTimestamp(attack.startTick);
    attack.resolveTick = holdTimestamp(attack.resolveTick);
    attack.endTick = holdTimestamp(attack.endTick);
  }
}
