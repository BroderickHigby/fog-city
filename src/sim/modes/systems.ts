import { Action, sortedIds } from "../contract.ts";
import { activeBody } from "../step.ts";
import type { SimSystem, SimSystemContext } from "../system-contract.ts";
import { stepMatch } from "./match.ts";
import { encodeSession, modeSessionOf, settleSession } from "./session.ts";
import type { MatchContext, MatchInput } from "./types.ts";
import { stepAdvancedModes, type AdvancedModeProviders } from "./advanced.ts";

export type MatchContextProvider=(context:SimSystemContext)=>MatchContext;
export const defaultMatchContext:MatchContextProvider=context=>{
  const session=modeSessionOf(context.state);
  const positions=Object.fromEntries(sortedIds(context.state.players).map(id=>[id,activeBody(context.state.players[id]!)]));
  const inputs:Record<string,MatchInput>={};
  if(session)for(const id of sortedIds(context.state.players)) {
    if(!((context.inputs[id]?.actions??0)&Action.interact))continue;
    const source=positions[id]!;
    const candidate=sortedIds(session.match.players).filter(target=>target!==id && session.match.players[target]!.downUntil>context.state.tick && positions[target])
      .map(target=>({target,d:(source.x-positions[target]!.x)*(source.x-positions[target]!.x)+(source.y-positions[target]!.y)*(source.y-positions[target]!.y)+(source.z-positions[target]!.z)*(source.z-positions[target]!.z)}))
      .sort((a,b)=>a.d-b.d||(a.target<b.target?-1:a.target>b.target?1:0))[0];
    if(candidate)inputs[id]={reviveTarget:candidate.target};
  }
  const combat=context.state.ext.combat;
  const combatEvents=(combat?.events??[]).map(event=>{
    if(event.kind!=="update.interrupted"||session?.match.players[event.sourceId])return event;
    const blind=combat?.events.find(hit=>hit.kind==="robot.blinded"&&hit.tick===event.tick&&hit.targetId===event.sourceId);
    const effect=combat?.targets[event.sourceId];
    const sourceId=blind?.sourceId??(effect&&effect.phase!=="active"?effect.sourceId:"");
    return sourceId&&session?.match.players[sourceId]?{...event,sourceId}:event;
  });
  return {tick:context.state.tick,positions,inputs,combatEvents};
};
export function createModesSystem(provider:MatchContextProvider=defaultMatchContext,advanced:AdvancedModeProviders={}):SimSystem {
  return {key:"modes",step(context){
    const extended=stepAdvancedModes(context,advanced);if(extended)return extended;
    const previous=modeSessionOf(context.previous);if(!previous)return context.state;
    const match=stepMatch(previous.match,{...provider(context),tick:context.state.tick});
    const session=settleSession({...previous,match,payouts:[]});
    return {...context.state,ext:{...context.state.ext,modes:encodeSession(session)}};
  }};
}
/** Inert outside an explicitly created match instance. */
export const systems:readonly SimSystem[]=Object.freeze([createModesSystem()]);
