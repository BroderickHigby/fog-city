import { protectedAreaAt, badRobotRate } from "../content/places.ts";
import { toLatLon } from "../geo/project.ts";
import { sortedIds } from "./contract.ts";
import { createClockSystem, gameTime } from "./clock/calendar.ts";
import { fogDensity, rainDensity, createFogSystem } from "./fog/index.ts";
import { createWorldEffectsSystem } from "./vehicles/world-effects.ts";
import { DEFAULT_CATALOG } from "./player/catalog.ts";
import { allocateActorIds } from "./identity.ts";
import { createAgentsSystem, agentsCombatOptions, type AgentRuntimeProvider } from "./agents/systems.ts";
import { createCombatSystem } from "./combat/systems.ts";
import { contextFromState, type CombatAdapterOptions } from "./combat/adapter.ts";
import { createModesSystem, type MatchContextProvider } from "./modes/systems.ts";
import type { AdvancedModeProviders } from "./modes/advanced.ts";
import { combatLoadout, createPlayerSystems, createObservedGameplayProvider, gameplaySnapshot } from "./player/adapter.ts";
import type { SimSystem, SimSystemContext } from "./system-contract.ts";
import type { CombatWave } from "./combat-contract.ts";

export interface GameSystemsOptions {
  wave?: CombatWave;
  protectedArea?: (x:number,z:number)=>boolean;
  agents?: AgentRuntimeProvider;
  combat?: (context:SimSystemContext)=>CombatAdapterOptions;
  matchContext?: MatchContextProvider;
  advanced?: AdvancedModeProviders;
}

/** One explicit composition shared by browser, headless drivers and relay sessions. */
export function createGameSystems(options: GameSystemsOptions = {}): readonly SimSystem[] {
  const wave=options.wave??2;
  const protectedArea=options.protectedArea??((x:number,z:number)=>{const p=toLatLon(x,z);return Boolean(protectedAreaAt([p.lat,p.lon]));});
  const fogAt=(context:SimSystemContext,x:number,z:number)=>wave>=3?fogDensity(context.world,context.state,x,z):0;
  const agents=createAgentsSystem(context=>({wave,graph:context.world.sidewalks,transit:context.world.transit,protectedArea,
    badRateAt:(x:number,z:number)=>{const p=toLatLon(x,z);return badRobotRate([p.lat,p.lon]);},
    fogAt:(x:number,z:number)=>fogAt(context,x,z),fog:0,
    ...options.agents?.(context),
  }),allocateActorIds);
  const combatContext=(context:SimSystemContext)=>{
    const supplied=options.combat?.(context)??{};
    const snapshot=gameplaySnapshot(context),loadouts:Record<string,ReturnType<typeof combatLoadout>>={};
    for(const id of sortedIds(context.state.players)){
      const player=context.state.players[id]!,body=player.mode==="foot"&&player.foot?player.foot:player.car;
      loadouts[id]={...combatLoadout(snapshot,{id,mode:player.mode,x:body.x,y:body.y,z:body.z,speed:body.speed},body.heading),...supplied.loadouts?.[id]};
    }
    const calendar=gameTime(context.state);
    const combat=contextFromState(context.world,context.state,{...supplied,...agentsCombatOptions(context.state),wave,loadouts,
      refills:supplied.refills??context.world.gameplay?.refills??[],night:supplied.night??(calendar.hour>=19||calendar.hour<6),
      fog:supplied.fog??0,rain:supplied.rain??(wave>=3?rainDensity(context.state):0)});
    return {...combat,actors:combat.actors.map(actor=>({...actor,fog:supplied.fog??fogAt(context,actor.x,actor.z)})),
      players:combat.players.map(player=>({...player,fog:supplied.fog??fogAt(context,player.x,player.z)}))};
  };
  const observed=createObservedGameplayProvider({wave,actors:context=>combatContext(context).actors,
    protectedArea,fog:()=>0});
  let cachedObservation:{context:SimSystemContext;value:ReturnType<typeof observed>}|undefined;
  const gameplay=(context:SimSystemContext)=>{
    const previous=cachedObservation?.context;
    // The six reducers observe the same immutable tick. A branch/replay gets a
    // different previous or input identity and is always recomputed.
    if(previous&&previous.previous===context.previous&&previous.world===context.world&&previous.inputs===context.inputs&&previous.events===context.events&&previous.state.tick===context.state.tick&&previous.state.players===context.state.players&&previous.state.ext.agents===context.state.ext.agents&&previous.state.ext.robots===context.state.ext.robots&&previous.state.ext.combat===context.state.ext.combat&&previous.state.ext.clock===context.state.ext.clock&&previous.state.ext.fog===context.state.ext.fog)return cachedObservation!.value;
    const calendar=gameTime(context.state);
    const result=observed(context);
    const value={...result,observations:result.observations.map(observation=>{const body=result.bodies.find(body=>body.id===observation.playerId);return {...observation,fog:body?fogAt(context,body.x,body.z):0};}),day:calendar.dayIndex,month:calendar.month,hour:calendar.hour,minute:calendar.minute};
    cachedObservation={context,value};
    return value;
  };
  return Object.freeze([createClockSystem(),...(wave>=3?[createFogSystem()]:[]),createWorldEffectsSystem({sites:DEFAULT_CATALOG.sites,wave}),agents,createCombatSystem(context=>({context:combatContext(context)})),...createPlayerSystems(gameplay),createModesSystem(options.matchContext,options.advanced)]);
}
