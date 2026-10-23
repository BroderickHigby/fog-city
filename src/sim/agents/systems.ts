import type { SimState } from "../contract.ts";
import type { SimSystem, SimSystemContext } from "../system-contract.ts";
import {planThreatRuntime} from "./threat-runtime.ts";
import {planMaintenanceRuntime} from "./maintenance-runtime.ts";
import { planTransitRuntime } from "./transit-runtime.ts";
import { planServiceRuntime } from "./service-runtime.ts";
import {decodeMissionScene,planSceneActors} from "./scene-actors.ts";
import { decodeMissionStage, planMissionActors } from "./mission-actors.ts";
import type { CombatActorMetadata, CombatAdapterOptions } from "../combat/adapter.ts";
import {
  agentsRuntimeOf, observeAgentRuntime, planAgentRuntime, runtimeCombatActors,
  runtimeAttackRequests, type AgentRuntimeOptions, type AgentMotionProposal,
} from "./runtime.ts";

export type ActorIdAllocator = (state:Readonly<SimState>,stableIds:readonly string[])=>{state:SimState;ids:Record<string,number>};
export type AgentRuntimeProvider = (context: SimSystemContext) => AgentRuntimeOptions;
export interface AgentsSystem extends SimSystem {
  prepare(context: SimSystemContext): { state: SimState; motions: readonly AgentMotionProposal[]; retirements: readonly string[] };
}
function withRuntime(state: SimState, runtime: ReturnType<typeof planAgentRuntime>): SimState {
  return { ...state, ext: { ...state.ext, robots: runtime } };
}

/** The core calls prepare before movement, accepts proposals through clearance, then step. */
export function createAgentsSystem(provider: AgentRuntimeProvider = () => ({}), allocate?:ActorIdAllocator): AgentsSystem {
  function prepare(context:SimSystemContext){
    let state=context.state;
    const options=provider(context);
    const spawns=[...(options.spawns??[])];
    const service=allocate&&options.services!==false?planServiceRuntime(context.world,state,agentsRuntimeOf(state)?.services):undefined;
    if(service&&allocate&&service.spawns.length){
      const reserved=allocate(state,service.spawns.map(actor=>actor.id));state=reserved.state;
      for(const actor of service.spawns)if(!spawns.some(spawn=>spawn.id===actor.id))spawns.push({...actor,numericId:reserved.ids[actor.id]!});
    }
    const transit=allocate&&options.transit?planTransitRuntime(context.world,state,options.transit,agentsRuntimeOf(state)?.transit):undefined;
    if(transit&&allocate&&transit.spawns.length){
      const reserved=allocate(state,transit.spawns.map(actor=>actor.id));state=reserved.state;
      for(const actor of transit.spawns)if(!spawns.some(spawn=>spawn.id===actor.id))spawns.push({...actor,numericId:reserved.ids[actor.id]!});
    }
    const threats=allocate&&options.threats!==false&&(options.wave??2)>=3?planThreatRuntime(context.world,state,agentsRuntimeOf(state)?.threats,options,spawns):undefined;
    if(threats&&allocate&&threats.spawns.length){
      const reserved=allocate(state,threats.spawns.map(actor=>actor.id));state=reserved.state;
      for(const actor of threats.spawns)if(!spawns.some(spawn=>spawn.id===actor.id))spawns.push({...actor,numericId:reserved.ids[actor.id]!});
    }
    const maintenance=allocate&&options.maintenance!==false&&(options.wave??2)>=3?planMaintenanceRuntime(context.world,state,agentsRuntimeOf(state)?.maintenance,spawns):undefined;
    if(maintenance&&allocate&&maintenance.spawns.length){
      const reserved=allocate(state,maintenance.spawns.map(actor=>actor.id));state=reserved.state;
      for(const actor of maintenance.spawns)if(!spawns.some(spawn=>spawn.id===actor.id))spawns.push({...actor,numericId:reserved.ids[actor.id]!});
    }
    const bindings={...(agentsRuntimeOf(state)?.missionBindings??{})};
    if(allocate){
      const source=(state.ext.missions as unknown as {events?:unknown}|undefined)?.events;
      const events=Array.isArray(source)?source:[];
      for(const raw of events){
        if(!raw||typeof raw!=="object")continue;
        const event=raw as {kind?:unknown;targetId?:unknown;detail?:unknown};
        if(typeof event.kind!=="string"||typeof event.targetId!=="string"||typeof event.detail!=="string")continue;
        const scene=decodeMissionScene({kind:event.kind,detail:event.detail});
        if(scene){
          const plan=planSceneActors(context.world,state,scene,options.graph,spawns);
          const reserved=allocate(state,plan.actors.map(actor=>actor.id));state=reserved.state;
          for(const actor of plan.actors)if(!spawns.some(spawn=>spawn.id===actor.id))spawns.push({...actor,numericId:reserved.ids[actor.id]!});
          for(const actor of scene.actors)bindings[`${scene.missionId}:${actor.role}`]=actor.id;
        }
        const stage=decodeMissionStage({kind:event.kind,targetId:event.targetId,detail:event.detail});
        if(!stage)continue;
        const plan=planMissionActors(context.world,state,stage,options.graph,()=>true,spawns);
        const reserved=allocate(state,plan.actors.map(actor=>actor.id));state=reserved.state;
        for(const actor of plan.actors)if(!spawns.some(spawn=>spawn.id===actor.id))spawns.push({...actor,numericId:reserved.ids[actor.id]!});
        for(const alias of Object.keys(plan.bindings).sort())bindings[`${stage.missionId}:${alias}`]=plan.bindings[alias]!;
      }
    }
    const runtime=planAgentRuntime(context.world,state,context.inputs,{...options,spawns,movementGoals:{...options.movementGoals,...maintenance?.goals,...threats?.goals},restorationPoints:{...options.restorationPoints,...maintenance?.restorationPoints},vehicleControls:{...options.vehicleControls,...service?.controls,...transit?.controls,...threats?.controls}});
    if(service){runtime.services=service.state;for(const id of service.retirements)if(runtime.actors[id])runtime.actors[id]!.retired=true;}
    if(transit){runtime.transit=transit.state;for(const id of transit.retirements)if(runtime.actors[id])runtime.actors[id]!.retired=true;}
    if(threats){runtime.threats=threats.state;for(const id of threats.retirements)if(runtime.actors[id])runtime.actors[id]!.retired=true;}
    if(maintenance){
      runtime.maintenance=maintenance.state;
      for(const id of Object.keys(runtime.actors).sort()){const actor=runtime.actors[id]!;if(actor.model==="tidy"){delete actor.cargoId;if(actor.behavior.startsWith("tidy-"))actor.behavior="idle";}}
      for(const id of Object.keys(maintenance.state.jobs).sort()){const job=maintenance.state.jobs[id]!,worker=runtime.actors[id];if(worker){worker.behavior=`tidy-${job.phase}`;if(runtime.actors[job.actorId]?.carriedBy===id&&(job.phase==="carry"||job.phase==="restore"))worker.cargoId=job.actorId;}}
    }
    runtime.missionBindings=bindings;
    runtime.proposals=runtime.proposals.filter(proposal=>!runtime.actors[proposal.id]?.retired||runtime.actors[proposal.id]?.restorePending);
    return {state:withRuntime(state,runtime),motions:runtime.proposals,retirements:Object.keys(runtime.actors).sort().filter(id=>runtime.actors[id]!.retired&&!runtime.actors[id]!.restorePending)};
  }
  return {
    key:"robots",prepare,
    step(context){
      if(agentsRuntimeOf(context.state)?.tick!==context.state.tick)return prepare(context).state;
      const options=provider(context);
      const observed=context.observedBodies;
      const runtime=observeAgentRuntime(context.state,{...options,...(observed?{observedBodies:observed}:{})});
      return withRuntime(context.state,runtime);
    },
  };
}

export function missionActorBindings(state:Readonly<SimState>,missionId:string):Record<string,string>{
  const all=agentsRuntimeOf(state)?.missionBindings??{},bindings:Record<string,string>={};
  for(const key of Object.keys(all).sort())if(key.startsWith(`${missionId}:`))bindings[key.slice(missionId.length+1)]=all[key]!;
  return bindings;
}

/** Legacy bodies already exist in contextFromState. Supply metadata, never duplicate them. */
export function agentsCombatOptions(state: Readonly<SimState>): CombatAdapterOptions {
  const runtime = agentsRuntimeOf(state);
  const actorMetadata: Record<string, CombatActorMetadata> = {};
  const extraActors: NonNullable<CombatAdapterOptions["extraActors"]>[number][] = [];
  for (const actor of runtimeCombatActors(state)) {
    if (runtime?.actors[actor.id]?.legacyId !== null) actorMetadata[actor.id] = actor;
    else extraActors.push(actor);
  }
  return { actorMetadata, extraActors, attacks: runtimeAttackRequests(state),...(runtime?.maintenance?{maintenance:runtime.maintenance.requests,maintenanceKiosks:runtime.maintenance.kiosks}:{}),...(runtime?{conversionCap:runtime.baseBadCount*2}:{}) };
}

/** Core composes the configured provider once world navigation and service data are loaded. */
export const systems: readonly SimSystem[] = Object.freeze([]);
