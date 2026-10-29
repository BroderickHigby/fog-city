// Match payouts into the free-roam city: once per settlement id, ever. The id list lives in the
// city's economy state (economy.settledModeIds), which the save already carries
// (src/save/progression.ts), so a reload, a rejoin or a replayed result cannot pay twice.
//
// Like restoreProgression, this is a host-side transform of a paused free-roam state between
// ticks: the city is never stepped while a match runs, and only XP, cash and achievements come
// out (docs/design.md, Match framework). SIM21 settles a winning faction clock move in the same transaction.
import type { SimState } from "../contract.ts";
import { createWallet } from "../economy/system.ts";
import { createProgressionPlayer, rankForXp } from "../progression/system.ts";
import { createDoomClock,factionFor,moveDoomClock } from "../progression/doom-clock.ts";
import { event } from "../player/common.ts";
import { gameplaySnapshot } from "../player/adapter.ts";
import { isGameplayId } from "../gameplay-contract.ts";
import { isBotSweep } from "./botsweep.ts";
import type { MatchPayoutEvent } from "./session.ts";

/** The most settlement ids kept; older ones belong to matches whose rooms expired long ago. */
export const MAX_SETTLED_MODE_IDS = 512;
const SETTLEMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}:[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export function settledModeIds(state: Readonly<SimState>): readonly string[] {
  return (gameplaySnapshot({ state }).economy as { settledModeIds?: string[] }).settledModeIds ?? [];
}

/**
 * Credit `payout` to `cityPlayerId` in the free-roam `city` state, unless that settlement id was
 * already paid. Returns the same object when nothing changes. Pure.
 */
export function applyMatchSettlement(city: Readonly<SimState>, payout: Readonly<MatchPayoutEvent>, cityPlayerId: string): SimState {
  if (isBotSweep(city)) throw new Error("Settle into the free-roam city, never into a match");
  if (!SETTLEMENT_ID.test(payout.id) || !isGameplayId(cityPlayerId) || !city.players[cityPlayerId]) return city as SimState;
  if (!Number.isSafeInteger(payout.cashCents) || payout.cashCents < 0 || !Number.isSafeInteger(payout.xp) || payout.xp < 0 || !Array.isArray(payout.achievements)) return city as SimState;
  if(city.version>=27&&payout.factionClockMoves!==0&&payout.factionClockMoves!==1)return city as SimState;
  const snapshot = gameplaySnapshot({ state: city });
  const settled = settledModeIds(city);
  if (settled.includes(payout.id)) return city as SimState;
  const wallet = { ...(snapshot.economy.players[cityPlayerId] ?? createWallet()) };
  const own = { ...(snapshot.progression.players[cityPlayerId] ?? createProgressionPlayer()) } as ReturnType<typeof createProgressionPlayer> & { achievements?: string[] };
  wallet.cashCents = Math.min(Number.MAX_SAFE_INTEGER, wallet.cashCents + payout.cashCents);
  own.xp = Math.min(Number.MAX_SAFE_INTEGER, own.xp + payout.xp);
  own.rank = Math.max(own.rank, rankForXp(own.xp,city.version));
  const achievements = payout.achievements.filter(isGameplayId);
  if (achievements.length) own.achievements = [...new Set([...(own.achievements ?? []), ...achievements])].sort();
  const economy = { ...snapshot.economy, players: { ...snapshot.economy.players, [cityPlayerId]: wallet }, settledModeIds: [...settled, payout.id].slice(-MAX_SETTLED_MODE_IDS) };
  const progression = { ...snapshot.progression, players: { ...snapshot.progression.players, [cityPlayerId]: own } };
  if(city.version>=27&&payout.factionClockMoves===1){
    const clock=progression.doom??createDoomClock(),faction=factionFor(clock,cityPlayerId);
    if(faction!=="unaffiliated"){
      const moved=moveDoomClock(clock,faction==="pauser"?1:-1,city.tick,cityPlayerId);
      progression.doom=moved.state;progression.events=[...progression.events];progression.tick=city.tick;
      for(const change of moved.events)event(progression,change.kind,change.playerId,"",change.amount);
    }
  }
  return { ...city, ext: { ...city.ext, economy: economy as typeof snapshot.economy, progression: progression as typeof snapshot.progression } };
}
