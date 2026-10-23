import type { SimState } from "../contract.ts";
import { createWallet } from "../economy/system.ts";
import { createProgressionPlayer,rankForXp } from "../progression/system.ts";
import { createDoomClock,factionFor,moveDoomClock } from "../progression/doom-clock.ts";
import { gameplaySnapshot } from "./adapter.ts";
import { event,validId } from "./common.ts";

export interface ModeSettlement {id:string;playerId:string;xp:number;cashCents:number;achievements:readonly string[];factionClockMoves:0|1}
/** Apply only when the host restores free roam. Never step the preserved snapshot inside a match. */
export function applyModeSettlements(freeRoam:SimState,payouts:readonly ModeSettlement[]):SimState {
 const snapshot=gameplaySnapshot({state:freeRoam});
 const economy={...snapshot.economy,players:{...snapshot.economy.players},settledModeIds:[...(snapshot.economy.settledModeIds??[])]};
 const progression={...snapshot.progression,players:{...snapshot.progression.players},events:[...snapshot.progression.events],doom:snapshot.progression.doom??createDoomClock()};
 for(const payout of [...payouts].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)){
  if(!validId(payout.id)||!validId(payout.playerId)||!freeRoam.players[payout.playerId]||economy.settledModeIds.includes(payout.id)||!Number.isSafeInteger(payout.cashCents)||payout.cashCents<0||!Number.isSafeInteger(payout.xp)||payout.xp<0||!Array.isArray(payout.achievements)||(payout.factionClockMoves!==0&&payout.factionClockMoves!==1))continue;
  const wallet={...(economy.players[payout.playerId]??createWallet())},profile={...(progression.players[payout.playerId]??createProgressionPlayer())};
  wallet.cashCents=Math.min(Number.MAX_SAFE_INTEGER,wallet.cashCents+payout.cashCents);profile.xp=Math.min(Number.MAX_SAFE_INTEGER,profile.xp+payout.xp);profile.rank=rankForXp(profile.xp);profile.achievements=[...new Set([...(profile.achievements??[]),...payout.achievements.filter(validId)])].sort();
  if(payout.factionClockMoves===1){
   const faction=factionFor(progression.doom,payout.playerId);
   if(faction!=="unaffiliated"){
    const moved=moveDoomClock(progression.doom,faction==="pauser"?1:-1,freeRoam.tick,payout.playerId);
    progression.doom=moved.state;
    for(const change of moved.events){const out=event(progression,change.kind,change.playerId,"",change.amount);out.tick=freeRoam.tick;}
   }
  }
  economy.players[payout.playerId]=wallet;progression.players[payout.playerId]=profile;economy.settledModeIds.push(payout.id);
 }
 const ext={...freeRoam.ext};
 Object.assign(ext,{economy,progression});
 return {...freeRoam,ext};
}
