import { MISSIONS, SAFEHOUSES } from "../content/catalog.ts";
import { CITY_DIRECTOR_CARDS } from "../content/cityLife.ts";
import { uiText } from "../content/ui.ts";
import { VENDOR } from "../content/vendor.ts";
import { toLocal } from "../geo/project.ts";
import type { SimState } from "../sim/contract.ts";
import { gameplaySnapshot, playerView, combatLoadout } from "../sim/player/adapter.ts";
import { capacity } from "../sim/combat/shared.ts";
import { canInteractAtSite } from "../sim/player/sites.ts";
import { DEFAULT_CATALOG } from "../sim/player/catalog.ts";
import { agentsRuntimeOf } from "../sim/agents/runtime.ts";
import { missionActorBindings } from "../sim/agents/systems.ts";
import { nearestTurntable } from "../sim/missions/mechanics/bell.ts";
import type { RoadGraph } from "../render/types.ts";
import type { InteractionView, MapBlip, MapEdge, MapPoint, UiView } from "./types.ts";
const graphEdges=new WeakMap<RoadGraph,readonly MapEdge[]>();

export function uiProjection(state:SimState,playerId:string,roads:RoadGraph|null,waypoint?:MapPoint,wave=2,missionDestination?:MapPoint):UiView {
  const snapshot=gameplaySnapshot({state}),own=playerView(snapshot,playerId),player=state.players[playerId];
  const body=player?.mode==="foot"&&player.foot?player.foot:player?.car;
  const combat=state.ext.combat?.players[playerId],progression=snapshot.progression.players[playerId],progress=snapshot.missions.players[playerId];
  const loadout=player&&body?combatLoadout(snapshot,{id:playerId,mode:player.mode,x:body.x,y:body.y,z:body.z,speed:body.speed},body.heading):undefined;
  const mission=MISSIONS.find(m=>m.id===progress?.missionId),step=mission?.steps.find(s=>s.id===progress?.stepId);
  let interaction:InteractionView|undefined;
  const lines=step&&"lines"in step?step.lines?.map(line=>`${line.speaker}: ${line.text}`).join("\n"):"";
  const duelStep=step?.type==="objective"&&step.objective.kind==="event"&&(step.objective.event==="bell.duelStarted"||step.objective.event==="bell.duelWon");
  const duel=duelStep?state.ext.missions?.bell?.duels[playerId]:undefined;
  const bell=duel?{round:duel.round,wins:duel.wins,losses:duel.losses,count:duel.cues.length}:undefined;
  const duelText=duel&&bell?duel.phase==="demonstration"?uiText("ui.bell.listen",{...bell,heard:duel.cues.filter(cue=>cue<=state.tick).length}):duel.phase==="response"?uiText("ui.bell.turn",{...bell,rung:duel.ringIndex}):uiText("ui.bell.pause",bell):undefined;
  const detail=duelText||(step&&"hint"in step?step.hint:undefined)||lines||step?.note||mission?.summary||"";
  if(mission&&progress&&step&&progress.status==="active"){
    const id=`${mission.id}:${step.id}:${progress.questionIndex}`;
    if(step.type==="form")interaction={id,title:mission.title,detail,startup:true,choices:[]};
    if(step.type==="trigger"&&step.event.kind==="phoneCall")interaction={id,title:mission.title,detail,choices:[{id:"ack",label:uiText("ui.common.continue")}]};
    if(step.type==="dialogue"){
      const question=step.questions[progress.questionIndex];if(question)interaction={id,title:step.speaker,detail:question.prompt,choices:question.answers.map(answer=>({id:answer.id,label:answer.text}))};
    }
    if(step.type==="objective"&&step.objective.kind==="event"&&step.objective.event==="botCheck.falsePositiveSeen"){
      const courier=missionActorBindings(state,mission.id,playerId).courier??`mission:${mission.id}:courier`;
      if(progress.observed?.falsePositives.includes(courier))interaction={id,title:mission.title,detail,choices:[{id:"ack",label:uiText("ui.common.continue")}]};
    }
  }
  if(mission&&progress?.status==="retry"&&state.tick>=progress.deadlineTick)interaction={id:`${mission.id}:retry:${progress.visits}`,title:mission.title,detail,choices:[{id:"retry",label:uiText("ui.common.retry")}]};
  let edges=roads?graphEdges.get(roads):undefined;if(!edges){const all:MapEdge[]=[];for(const edge of roads?.edges??[]){all.push({from:edge.a,to:edge.b});if(!edge.oneway)all.push({from:edge.b,to:edge.a});}edges=all;if(roads)graphEdges.set(roads,edges);}
  const blips:MapBlip[]=SAFEHOUSES.map(site=>({id:site.id,kind:"safehouse" as const,label:site.label,...toLocal(site.lat,site.lon)}));
  const objectiveActor=step?.type==="objective"?(step.objective.actor??(step.objective.event==="botCheck.falsePositiveSeen"?"courier":undefined)):undefined;
  const targetId=mission&&objectiveActor?missionActorBindings(state,mission.id,playerId)[objectiveActor]:undefined;
  const actorTarget=targetId?agentsRuntimeOf(state)?.actors[targetId]:undefined;
  const turntable=duelStep&&body?nearestTurntable(body.x,body.z):undefined;
  const target=missionDestination??(turntable?{x:turntable.x,z:turntable.z}:step?.type==="goto"?toLocal(step.target.lat,step.target.lon):step?.type==="trigger"?toLocal(step.event.place.lat,step.event.place.lon):actorTarget?{x:actorTarget.x,z:actorTarget.z}:undefined);
  if(target)blips.push({id:"mission-target",kind:"safehouse",label:mission?.title??uiText("ui.hud.objective"),...target});
  // Street incidents the director staged for this player (src/sim/agents/incidents.ts): a bounty
  // blip on each bad robot still on its feet, and a card in BotBounty.
  const runtime=agentsRuntimeOf(state),shown=new Set<string>(),bounties:{id:string;title:string;detail:string;multiplier:number;confirmed:boolean}[]=[];
  for(const id of Object.keys(runtime?.incidents??{}).sort()){
    const incident=runtime!.incidents![id]!;if(incident.playerId!==playerId)continue;
    const card=CITY_DIRECTOR_CARDS.find(c=>c.id===incident.cardId);
    const live=incident.targetIds.map(t=>runtime!.actors[t]).filter(a=>a&&!a.retired&&(state.ext.combat?.targets[a.id]?.phase??"active")==="active");
    if(!live.length)continue;
    for(const actor of live)shown.add(actor!.id);
    for(const actor of live)blips.push({id:`${id}:${actor!.id}`,kind:"bounty",label:card?.title??id,x:actor!.x,z:actor!.z});
    bounties.push({id,title:card?.title??id,detail:card?.blurb??"",multiplier:card?.payoff.kind==="catchInTheAct"?1.5:1,confirmed:true});
  }
  // Bad robots the player has found: flagged by a Bot Check scan (a mark, right or wrong: the
  // scanner can be fooled), or openly hostile nearby (alerted, attacking or fleeing within 150 m).
  const ownCombat=state.ext.combat?.players[playerId];
  for(const mark of ownCombat?.marks??[]){
    const actor=runtime?.actors[mark.targetId];
    if(!actor||actor.retired||mark.untilTick<state.tick||shown.has(actor.id))continue;
    shown.add(actor.id);blips.push({id:`flagged:${actor.id}`,kind:"robot",label:uiText("ui.map.flagged"),x:actor.x,z:actor.z});
  }
  for(const id of Object.keys(runtime?.actors??{}).sort()){
    const actor=runtime!.actors[id]!;
    if(actor.retired||actor.firmware!=="bad"||shown.has(id)||!body||Math.hypot(actor.x-body.x,actor.z-body.z)>150)continue;
    if(!["alerted","attack","flee"].includes(actor.behavior)||(state.ext.combat?.targets[id]?.phase??"active")!=="active")continue;
    shown.add(id);blips.push({id:`hostile:${id}`,kind:"robot",label:uiText("ui.map.hostile"),x:actor.x,z:actor.z});
  }
  const owned=new Set(own.ownedItemIds);
  const vendorSite=body?DEFAULT_CATALOG.sites.filter(site=>site.kind==="vendor"&&site.wave<=wave&&canInteractAtSite(body,site)).sort((a,b)=>Math.hypot(a.x-body.x,a.z-body.z)-Math.hypot(b.x-body.x,b.z-body.z))[0]:undefined;
  return {tick:state.tick,playerId,x:body?.x??0,z:body?.z??0,heading:body?.heading??0,speedMps:body?.speed??0,...own,
    waterLitres:combat?.water??(loadout?capacity(loadout):8),capacityLitres:loadout?capacity(loadout):8,salt:combat?.salt??false,
    ...(mission&&step?{objective:{id:`${mission.id}:${step.id}`,title:mission.title,detail,remainingTicks:progress?.deadlineTick?Math.max(0,progress.deadlineTick-state.tick):undefined}}:{}),
    ...(interaction?{interaction}:{}),...(combat?.scan?{scan:combat.scan}:{}),
    map:{nodes:roads?.nodes??[],edges,blips,waypoint:waypoint??target,radius:150},
    vendorSiteId:vendorSite?.id,
    vendor:VENDOR.items.filter(item=>item.wave<=wave).map(item=>({id:item.id,title:item.name,description:item.blurb,priceCents:item.priceCents,owned:owned.has(item.id),available:!!vendorSite?.vendorItems?.includes(item.id)&&(!item.requires||owned.has(item.requires)),reason:item.requires&&!owned.has(item.requires)?uiText("ui.vendor.requires",{item:item.requires}):undefined})),
    phoneApps:["map","botBounty","botCheck","bank","settings"],
    ...(bounties.length?{bounties}:{}),
  };
}
