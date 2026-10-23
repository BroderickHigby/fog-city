import { MISSIONS, SAFEHOUSES } from "../content/catalog.ts";
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
import type { RoadGraph } from "../render/types.ts";
import type { InteractionView, MapEdge, MapPoint, UiView } from "./types.ts";
const graphEdges=new WeakMap<RoadGraph,readonly MapEdge[]>();

export function uiProjection(state:SimState,playerId:string,roads:RoadGraph|null,waypoint?:MapPoint,wave=2,missionDestination?:MapPoint):UiView {
  const snapshot=gameplaySnapshot({state}),own=playerView(snapshot,playerId),player=state.players[playerId];
  const body=player?.mode==="foot"&&player.foot?player.foot:player?.car;
  const combat=state.ext.combat?.players[playerId],progression=snapshot.progression.players[playerId],progress=snapshot.missions.players[playerId];
  const loadout=player&&body?combatLoadout(snapshot,{id:playerId,mode:player.mode,x:body.x,y:body.y,z:body.z,speed:body.speed},body.heading):undefined;
  const mission=MISSIONS.find(m=>m.id===progress?.missionId),step=mission?.steps.find(s=>s.id===progress?.stepId);
  let interaction:InteractionView|undefined;
  const lines=step&&"lines"in step?step.lines?.map(line=>`${line.speaker}: ${line.text}`).join("\n"):"";
  const detail=(step&&"hint"in step?step.hint:undefined)||lines||step?.note||mission?.summary||"";
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
  const blips=SAFEHOUSES.map(site=>({id:site.id,kind:"safehouse" as const,label:site.label,...toLocal(site.lat,site.lon)}));
  const objectiveActor=step?.type==="objective"?(step.objective.actor??(step.objective.event==="botCheck.falsePositiveSeen"?"courier":undefined)):undefined;
  const targetId=mission&&objectiveActor?missionActorBindings(state,mission.id,playerId)[objectiveActor]:undefined;
  const actorTarget=targetId?agentsRuntimeOf(state)?.actors[targetId]:undefined;
  const target=missionDestination??(step?.type==="goto"?toLocal(step.target.lat,step.target.lon):step?.type==="trigger"?toLocal(step.event.place.lat,step.event.place.lon):actorTarget?{x:actorTarget.x,z:actorTarget.z}:undefined);
  if(target)blips.push({id:"mission-target",kind:"safehouse",label:mission?.title??uiText("ui.hud.objective"),...target});
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
  };
}
