import type { SimState } from "../contract.ts";
import type { GameplayFact } from "../gameplay-contract.ts";
import type { MatchState } from "./types.ts";
/** Canonical mode events are observed by progression on its next update, retaining event IDs. */
export function modeProgressionFacts(state:Readonly<SimState>,tick=state.tick):GameplayFact[] {
  if(state.version<27||!Number.isSafeInteger(tick)||tick<0)return [];
  const match=(state.ext.modes as unknown as {match?:MatchState}|undefined)?.match;
  if(match?.version!==1||!Number.isSafeInteger(match.tick)||match.tick>tick||!(match.mode==="botSweep"||match.mode==="cleanStreets"))return [];
  return [...match.events].filter(event=>Number.isSafeInteger(event.id)&&event.id>0&&event.tick<=tick&&match.players[event.playerId]!==undefined).sort((a,b)=>a.id-b.id).flatMap(event=>{
    let kind="",detail="";
    if(event.kind==="match.score"){
      detail=event.detail==="melt"?(event.amount===200?"armouredMelt":event.amount===100?"melt":""):event.detail==="update"&&event.amount===150?"interruptedUpdate":event.detail==="revive"&&event.amount===100?"revive":"";
      if(detail)kind="mode.streak-points";
    }else if(event.kind==="match.streak-reset"){kind="mode.streak-reset";detail="wrongTarget";}
    else if(event.kind==="match.down"||match.mode==="cleanStreets"&&event.kind==="match.respawn-request"&&event.detail==="team-spawn"){kind="mode.streak-reset";detail="downRound";}
    if(!kind)return [];
    return [{id:`match-${match.id}:${event.id}`,source:"modes" as const,sequence:event.id,tick,kind,playerId:event.playerId,actorId:match.mode,detail}];
  });
}
