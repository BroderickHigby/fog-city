import type { SimState } from "../contract.ts";
import { createWallet } from "../economy/system.ts";
import { createProgressionPlayer,rankForXp } from "../progression/system.ts";
import { gameplaySnapshot } from "./adapter.ts";
import { createWorldEvents,factionOf,moveDoomClock } from "../activities/world-events.ts";
import { event,validId } from "./common.ts";

export interface ModeSettlement {id:string;playerId:string;xp:number;cashCents:number;achievements:readonly string[];factionClockMoves:0|1}
/** Apply only when the host restores free roam. Never step the preserved snapshot inside a match. */
export function applyModeSettlements(freeRoam:SimState,payouts:readonly ModeSettlement[]):SimState {
 const snapshot=gameplaySnapshot({state:freeRoam});
 let activities=snapshot.activities,clockChanged=false;
 const economy={...snapshot.economy,players:{...snapshot.economy.players},settledModeIds:[...(snapshot.economy.settledModeIds??[])]},progression={...snapshot.progression,players:{...snapshot.progression.players}};
 for(const payout of [...payouts].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)){
  if(!validId(payout.id)||!validId(payout.playerId)||!freeRoam.players[payout.playerId]||economy.settledModeIds.includes(payout.id)||!Number.isSafeInteger(payout.cashCents)||payout.cashCents<0||!Number.isSafeInteger(payout.xp)||payout.xp<0||(payout.factionClockMoves!==0&&payout.factionClockMoves!==1))continue;
  const wallet={...(economy.players[payout.playerId]??createWallet())},profile={...(progression.players[payout.playerId]??createProgressionPlayer())};
  wallet.cashCents=Math.min(Number.MAX_SAFE_INTEGER,wallet.cashCents+payout.cashCents);profile.xp=Math.min(Number.MAX_SAFE_INTEGER,profile.xp+payout.xp);profile.rank=rankForXp(profile.xp);profile.achievements=[...new Set([...(profile.achievements??[]),...payout.achievements.filter(validId)])].sort();
  if(payout.factionClockMoves===1){
   const world=activities.worldEvents??createWorldEvents(),faction=factionOf(world.doom.factions[payout.playerId]);
   if(faction){const moved=moveDoomClock(world.doom,faction==="pausers"?1:-1,freeRoam.tick,payout.playerId);
    activities={...activities,events:[...activities.events],worldEvents:{...world,doom:moved.doom}};
    for(const out of moved.emissions)event(activities,out.kind,out.playerId,out.targetId,out.amount,out.detail);
    clockChanged=true;
   }
  }
  economy.players[payout.playerId]=wallet;progression.players[payout.playerId]=profile;economy.settledModeIds.push(payout.id);
 }
 const ext={...freeRoam.ext};Object.assign(ext,{economy,progression});if(clockChanged)ext.activities=activities as unknown as NonNullable<typeof ext.activities>;return {...freeRoam,ext};
}
