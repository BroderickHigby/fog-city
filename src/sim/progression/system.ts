import { Action } from "../contract.ts";
import { facts } from "../player/common.ts";
import { createProgression,createProgressionPlayer,stepLegacyProgression,rankForXp as legacyRankForXp } from "./legacy-system.ts";
export { createProgression,createProgressionPlayer };
import { clamp } from "../dmath.ts";
import { commands, event, sortedBodies } from "../player/common.ts";
import { rankForXp as contentRankForXp, PROGRESSION } from "../../content/gameplay.ts";
import type { GameplayContext, GameplayEvent, Progression, ProgressionState } from "../player/types.ts";
import { createDoomClock, stepDoomClock } from "./doom-clock.ts";
import { loadoutSlots, normalizeLoadoutChoice, normalizeStreakId, STREAK_REWARDS, streakPointsFor, streakResetsOn } from "./rules.ts";
export { STREAK_COST } from "./rules.ts";

export function rankForXp(xp: number,simVersion=21): number { return simVersion>=21?contentRankForXp(xp):legacyRankForXp(xp); }
export function conversionCap(localBaseCount: number, inFidelity: boolean, protectedArea = false): number {
  return Math.floor(Math.max(0, localBaseCount) * (inFidelity && !protectedArea ? 2 : 1));
}
const nonnegative = (value: number): number => Number.isFinite(value) ? clamp(value, 0, Number.MAX_SAFE_INTEGER) : 0;

function normalizePlayer(old: Progression, ctx: GameplayContext,owned:readonly string[]): Progression {
  const rank = ctx.wave >= 4 ? rankForXp(old.xp) : 1;
  const nozzle = normalizeLoadoutChoice(old.nozzle);
  const gadget = normalizeLoadoutChoice(old.gadget);
  const gear = normalizeLoadoutChoice(old.gear);
  const perks = [...new Set(old.perks.flatMap((id) => {
    const choice = normalizeLoadoutChoice(id);
    return choice?.kind === "perk" ? [choice.value] : [];
  }))].slice(0, loadoutSlots("perkSlots", rank, ctx.wave));
  const streaks = [...new Set(old.streaks.flatMap((id) => normalizeStreakId(id) ?? []))]
    .slice(0, loadoutSlots("streakSlots", rank, ctx.wave));
  const banked: Record<string, number> = {};
  for (const id of Object.keys(old.banked).sort()) {
    const count = old.banked[id]!;
    const key = normalizeStreakId(id);
    if (key) banked[key] = nonnegative((banked[key] ?? 0) + Math.floor(nonnegative(count)));
  }
  const streakPoints = nonnegative(old.streakPoints);
  // Legacy profiles stored points without an earned ledger. Recover their already earned,
  // equipped rewards once; marking all crossed thresholds prevents retroactive equip farming.
  const earnedStreaks = old.earnedStreaks === undefined
    ? STREAK_REWARDS.filter((reward) => reward.threshold <= streakPoints).map((reward) => reward.runtimeId)
    : [...new Set(old.earnedStreaks.flatMap((id) => normalizeStreakId(id) ?? []))];
  if (old.earnedStreaks === undefined) {
    for (const id of earnedStreaks) if (streaks.includes(id) && !banked[id]) banked[id] = 1;
  }
  return {
    ...old, xp: nonnegative(old.xp), rank, streakPoints, perks, streaks, banked, earnedStreaks,
    nozzle: nozzle?.kind === "nozzle" && rank >= nozzle.rank && (!nozzle.requiresOwnership||owned.some(id=>{const choice=normalizeLoadoutChoice(id);return choice?.kind==="nozzle"&&choice.value===nozzle.value;})) ? nozzle.value : "standard",
    gadget: gadget?.kind === "gadget" && (ctx.wave < 4 || rank >= gadget.rank || gadget.value === "balloon") ? gadget.value : "balloon",
    gear: gear?.kind === "gear" && (ctx.wave < 4 || rank >= gear.rank) ? gear.value : "none",
    achievements: [...(old.achievements ?? [])],
    ...(old.pendingStreak?{pendingStreak:{...old.pendingStreak}}:{}),
  };
}

function points(own: Progression, amount: number): void {
  if (!Number.isFinite(amount)) return;
  const previous = own.streakPoints;
  own.streakPoints = nonnegative(previous + amount);
  for (const reward of STREAK_REWARDS) {
    if (previous >= reward.threshold || own.streakPoints < reward.threshold || own.earnedStreaks!.includes(reward.runtimeId)) continue;
    own.earnedStreaks!.push(reward.runtimeId);
    if (own.streaks.includes(reward.runtimeId)) own.banked[reward.runtimeId] = nonnegative((own.banked[reward.runtimeId] ?? 0) + 1);
  }
}
function resetPoints(own: Progression): void {
  own.streakPoints = 0;
  own.earnedStreaks = [];
  // Earned rewards remain banked after the run ends; calling one spends the reward, not score.
}

function requestStreak(state:ProgressionState,own:Progression,playerId:string,id:string):void {
  const kind=normalizeStreakId(id);
  if(!kind||own.pendingStreak||!own.streaks.includes(kind)||(own.banked[kind]??0)<1||!Number.isSafeInteger(own.streakSequence)||own.streakSequence>=Number.MAX_SAFE_INTEGER)return;
  own.pendingStreak={kind,sequence:++own.streakSequence};event(state,"streak.grant",playerId,kind,own.streakSequence);
}

/** Permanent upgrades, score accounting and banked tactical grants have one authoritative owner. */
export function stepProgression(previous: ProgressionState, ctx: GameplayContext, tick: number,
  groups: Readonly<Record<string, readonly GameplayEvent[]>>,
  ownedByPlayer: Readonly<Record<string, readonly string[]>> = {},simVersion=20): ProgressionState {
  if(simVersion<21)return stepLegacyProgression(previous,ctx,tick,groups);
  const state: ProgressionState = { ...previous, tick, players: {}, grantCursors: { ...previous.grantCursors }, events: [],factCursors:{...previous.factCursors} };
  for (const body of sortedBodies(ctx)) state.players[body.id] = normalizePlayer(previous.players[body.id] ?? createProgressionPlayer(), ctx,ownedByPlayer[body.id]??[]);
  for (const source of Object.keys(groups).sort()) {
    for (const grant of [...groups[source]!].sort((a, b) => a.id - b.id)) {
      if (!Number.isSafeInteger(grant.id) || grant.id <= 0 || grant.id <= (state.grantCursors[source] ?? 0)) continue;
      state.grantCursors[source] = grant.id;
      const own = state.players[grant.playerId];
      if (!own) continue;
      if (grant.kind === "bounty.paid") {
        const actor = ctx.actors.find((a) => a.id === grant.targetId);
        const subtlety = Number.isFinite(actor?.subtlety) ? actor!.subtlety! : 1;
        own.xp = nonnegative(own.xp + PROGRESSION.awards.melt * clamp(subtlety, 1, 5));
        points(own, streakPointsFor(ctx.mode, actor?.armoured ? "armouredMelt" : "melt") + (actor?.caughtInAct ? streakPointsFor(ctx.mode, "caughtInAct") : 0));
        if((actor as typeof actor&{beforeFirstAttack?:boolean})?.beforeFirstAttack===true)points(own,streakPointsFor(ctx.mode,"beforeFirstAttack"));
      }
      if (grant.kind === "update.rewarded") points(own, streakPointsFor(ctx.mode, "interruptedUpdate"));
      if (grant.kind === "mission.unlock" && grant.targetId === "app:scanner-tier-2") own.scannerTier = Math.max(own.scannerTier, 2) as 2 | 3 | 4;
      if (grant.kind === "economy.changed" && grant.detail === "wrong-target" && streakResetsOn(ctx.mode, "wrongTarget")) resetPoints(own);
      if (grant.kind === "mission.xp" || grant.kind === "activity.xp") own.xp = nonnegative(own.xp + nonnegative(grant.amount));
      if ((grant.kind === "player.down" || grant.kind === "player.acqui-hired") && streakResetsOn(ctx.mode, "downRound")) resetPoints(own);
      if (grant.kind === "vendor.purchased") {
        const item = ctx.items.find((item) => item.id === grant.targetId);
        if (!item) continue;
        const choice = normalizeLoadoutChoice(item.id);
        const catalogRank = Math.max(PROGRESSION.upgrades.find((row) => row.id === item.id)?.rank ?? 1, choice?.rank ?? 1);
        const currentRank = ctx.wave >= 4 ? rankForXp(own.xp) : 1;
        if (currentRank < Math.max(item.rank ?? 1, ctx.wave >= 4 ? catalogRank : 1)) continue;
        if (item.kind === "tank") own.tankTier = Math.max(own.tankTier, clamp(item.tier ?? 0, 0, 2)) as 0 | 1 | 2;
        if (item.kind === "flow") own.flowTier = Math.max(own.flowTier, clamp(item.tier ?? 0, 0, 1)) as 0 | 1;
        if (item.kind === "scanner") own.scannerTier = Math.max(own.scannerTier, clamp(item.tier ?? 1, 1, 4)) as 1 | 2 | 3 | 4;
        if (item.kind === "nozzle" && choice?.kind === "nozzle") own.nozzle = choice.value;
        if (item.kind === "perk" && choice?.kind === "perk" && !own.perks.includes(choice.value)) own.perks.push(choice.value);
      }
    }
  }
  // Only measured combat acknowledgments matching the exact reserved request may spend it.
  for(const fact of facts(ctx,tick,state.factCursors!)){
    if(fact.source==="modes"&&fact.actorId===ctx.mode&&(ctx.mode==="botSweep"||ctx.mode==="cleanStreets")){
      const own=state.players[fact.playerId];if(!own)continue;
      if(fact.kind==="mode.streak-points"&&fact.detail)points(own,streakPointsFor(ctx.mode,fact.detail));
      if(fact.kind==="mode.streak-reset"&&fact.detail&&streakResetsOn(ctx.mode,fact.detail))resetPoints(own);
      continue;
    }
    if(fact.source!=="combat"||(fact.kind!=="streak.used"&&fact.kind!=="streak.rejected"))continue;
    const own=state.players[fact.playerId],pending=own?.pendingStreak;
    if(!own||!pending||fact.amount!==pending.sequence||fact.detail!==pending.kind)continue;
    if(fact.kind==="streak.used"){
      own.banked[pending.kind]=Math.max(0,(own.banked[pending.kind]??0)-1);
      event(state,"streak.spent",fact.playerId,pending.kind,pending.sequence);
    }else event(state,"streak.blocked",fact.playerId,pending.kind,pending.sequence,"Reward retained");
    delete own.pendingStreak;
  }
  for (const body of sortedBodies(ctx)) {
    const own = state.players[body.id]!;
    own.rank = ctx.wave >= 4 ? rankForXp(own.xp) : 1;
    const streakSlots = loadoutSlots("streakSlots", own.rank, ctx.wave);
    const perkSlots = loadoutSlots("perkSlots", own.rank, ctx.wave);
    own.perks = own.perks.slice(0, perkSlots);
    own.streaks = own.streaks.slice(0, streakSlots);
    for (const command of commands(ctx, body.id, ["loadout", "streak-call"], own.commandSequence)) {
      own.commandSequence = command.sequence;
      const streakId = command.itemId ? normalizeStreakId(command.itemId) : null;
      if (command.kind === "streak-call" && streakId)requestStreak(state,own,body.id,streakId);
      if (command.kind !== "loadout" || !command.itemId || ctx.wave < 4) continue;
      const choice = normalizeLoadoutChoice(command.itemId);
      if (!choice || own.rank < choice.rank) continue;
      if (choice.kind === "nozzle") {
        const owned = !choice.requiresOwnership || (ownedByPlayer[body.id] ?? []).some((id) => {
          const item = normalizeLoadoutChoice(id);
          return item?.kind === "nozzle" && item.value === choice.value;
        });
        if (owned) own.nozzle = choice.value;
      }
      if (choice.kind === "gadget") own.gadget = choice.value;
      if (choice.kind === "gear") own.gear = choice.value;
      if (choice.kind === "perk") {
        if (own.perks.includes(choice.value)) own.perks = own.perks.filter((id) => id !== choice.value);
        else if (own.perks.length < perkSlots) own.perks.push(choice.value);
      }
      if (choice.kind === "streak") {
        if (own.streaks.includes(choice.value)) own.streaks = own.streaks.filter((id) => id !== choice.value);
        else if (own.streaks.length < streakSlots) own.streaks.push(choice.value);
      }
    }
    const held=Boolean((ctx.actions?.[body.id]??0)&Action.streak);
    if(held&&!own.streakHeld){const banked=own.streaks.find(id=>(own.banked[id]??0)>0);if(banked)requestStreak(state,own,body.id,banked);}
    own.streakHeld=held;
  }
  // Activities are trusted local producers; keep their event IDs as the replay identity.
  const activityFacts = (groups.activities ?? [])
    .filter((grant) => Number.isSafeInteger(grant.id) && grant.id > 0
      && Number.isSafeInteger(grant.tick) && grant.tick >= 0 && grant.tick <= tick
      && ctx.bodies.some((body) => body.id === grant.playerId)
      && (grant.kind === "faction.pauser-completed" || grant.kind === "faction.accelerator-completed"))
    .map((grant) => ({
      id: `activities:${grant.id}`, sequence: grant.id, source: "world" as const,
      tick, playerId: grant.playerId, kind: grant.kind,
      ...(grant.targetId ? { actorId: grant.targetId } : {}), detail: grant.detail,
    }));
  // Only acknowledged spent AGI advances the world; requesting or rejecting never does.
  // Only the local activity producer owns clock facts; outside observations must not
  // advance its replay cursor, even when their event kind is otherwise harmless.
  const doom = stepDoomClock(previous.doom ?? createDoomClock(), { ...ctx, facts: activityFacts }, tick, state.events);
  state.doom = doom.state;
  if (ctx.wave >= 4) for (const change of doom.events) event(state, change.kind, change.playerId, "", change.amount);
  return state;
}
