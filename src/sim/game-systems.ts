import { protectedAreaAt } from "../content/places.ts";
import { toLatLon } from "../geo/project.ts";
import { sortedIds } from "./contract.ts";
import { createClockSystem, gameTime } from "./clock/calendar.ts";
import { createFogSystem, fogDensity, floodDepthAt, puddlesNear, rainDensity, shelteredAt, weatherRefuge } from "./fog/index.ts";
import { allocateActorIds } from "./identity.ts";
import { createAgentsSystem, agentsCombatOptions } from "./agents/systems.ts";
import { createCombatSystem } from "./combat/systems.ts";
import { contextFromState } from "./combat/adapter.ts";
import { systems as modeSystems } from "./modes/systems.ts";
import { combatLoadout, createPlayerSystems, createObservedGameplayProvider, gameplaySnapshot } from "./player/adapter.ts";
import type { SimSystem, SimSystemContext } from "./system-contract.ts";
import type { CombatWave, RefillSource } from "./combat-contract.ts";
import { buildMissionParkingWorld } from "./missions/parking-world.ts";
import { CITY_DIRECTOR_CARDS, CITY_LIFE, cityBadRate, populationScale } from "../content/cityLife.ts";

export interface GameSystemsOptions { wave?: CombatWave; protectedArea?: (x:number,z:number)=>boolean }

/**
 * The game: one explicit composition shared by the browser, headless drivers, relay sessions
 * and the sim bench. step()'s default SYSTEMS is only the static registrations (systems.ts).
 * tests/golden/composed-v12.json pins this path.
 */
export function createGameSystems(options: GameSystemsOptions = {}): readonly SimSystem[] {
  const wave=options.wave??2;
  const protectedArea=options.protectedArea??((x:number,z:number)=>{const p=toLatLon(x,z);return Boolean(protectedAreaAt([p.lat,p.lon]));});
  // Weather is a wave-3 system: wave 2 keeps clear skies, dry roads and no tide.
  const weather=wave>=3;
  const fogAt=(context:SimSystemContext,x:number,z:number)=>weather?fogDensity(context.world,context.state,x,z):0;
  const agents=createAgentsSystem(context=>({wave,graph:context.world.sidewalks,transit:context.world.transit,protectedArea,
    // City life (content/city-life.json): ambient density by district and hour, and the director's incidents.
    densityAt:(x:number,z:number)=>{const p=toLatLon(x,z);return populationScale([p.lat,p.lon],gameTime(context.state).hour);},
    director:{cards:CITY_DIRECTOR_CARDS,stageM:CITY_LIFE.director.stageM,maxActive:3},
    badRateAt:(x:number,z:number)=>{const p=toLatLon(x,z);return cityBadRate([p.lat,p.lon]);},
    fog:0,
    fogAt:(x:number,z:number)=>fogAt(context,x,z),
    ...(weather?{weatherRefuge:(x:number,z:number)=>weatherRefuge(context.world,context.state,x,z)}:{}),
  }),allocateActorIds);
  /** Rain puddles and the King tide's flooded promenade, where each player stands: refill sources (0.5x speed, the tide salty). */
  const weatherRefills=(context:SimSystemContext):RefillSource[]=>{
    if(!weather)return [];
    const out:RefillSource[]=[];
    for(const id of sortedIds(context.state.players)){
      const player=context.state.players[id]!,body=player.mode==="foot"&&player.foot?player.foot:player.car;
      for(const puddle of puddlesNear(context.world,context.state,body.x,body.z,3))out.push({id:puddle.id,kind:"puddle",x:puddle.x,y:puddle.y,z:puddle.z,radius:puddle.radius+1,salt:false});
      if(floodDepthAt(context.world,context.state,body.x,body.z)>0)out.push({id:`tide:${id}`,kind:"puddle",x:body.x,y:body.y,z:body.z,radius:1.5,salt:true});
    }
    return out;
  };
  const combatContext=(context:SimSystemContext)=>{
    const snapshot=gameplaySnapshot(context),loadouts:Record<string,ReturnType<typeof combatLoadout>>={};
    for(const id of sortedIds(context.state.players)){
      const player=context.state.players[id]!,body=player.mode==="foot"&&player.foot?player.foot:player.car;
      loadouts[id]=combatLoadout(snapshot,{id,mode:player.mode,x:body.x,y:body.y,z:body.z,speed:body.speed},body.heading);
    }
    const calendar=gameTime(context.state),rain=weather?rainDensity(context.state):0,extra=weatherRefills(context);
    const combat=contextFromState(context.world,context.state,{...agentsCombatOptions(context.state),wave,loadouts,
      refills:extra.length?[...context.world.gameplay?.refills??[],...extra]:context.world.gameplay?.refills??[],night:calendar.hour>=19||calendar.hour<6,
      fog:0,rain,
      fogAt:(x:number,z:number)=>fogAt(context,x,z)});
    // In the rain, robots under an awning, a Muni shelter or the Ferry Building arcade stay dry.
    return rain>0?{...combat,actors:combat.actors.map(actor=>actor.kind==="robot"&&actor.sheltered===undefined?{...actor,sheltered:shelteredAt(context.world,actor.x,actor.z)}:actor)}:combat;
  };
  const observed=createObservedGameplayProvider({wave,actors:context=>combatContext(context).actors,
    protectedArea,fog:(context,x,z)=>fogAt(context,x,z),
    missionParking:context=>buildMissionParkingWorld(context,context.world.parking?.rules??[],context.world.streetCleaning?.rules??[]),
    calendar:context=>{const time=gameTime(context.state);return {day:time.dayIndex,month:time.month,hour:time.hour,minute:time.minute};}});
  let cachedObservation:{context:SimSystemContext;value:ReturnType<typeof observed>}|undefined;
  const gameplay=(context:SimSystemContext)=>{
    const previous=cachedObservation?.context;
    // The six reducers observe the same immutable tick. A branch/replay gets a
    // different previous or input identity and is always recomputed.
    if(previous&&previous.previous===context.previous&&previous.world===context.world&&previous.inputs===context.inputs&&previous.events===context.events&&previous.state.tick===context.state.tick&&previous.state.players===context.state.players&&previous.state.ext.agents===context.state.ext.agents&&previous.state.ext.robots===context.state.ext.robots&&previous.state.ext.combat===context.state.ext.combat&&previous.state.ext.clock===context.state.ext.clock&&previous.state.ext.fog===context.state.ext.fog)return cachedObservation!.value;
    const calendar=gameTime(context.state);
    const value={...observed(context),day:calendar.dayIndex,month:calendar.month};
    cachedObservation={context,value};
    return value;
  };
  return Object.freeze([createClockSystem(),...(weather?[createFogSystem()]:[]),agents,createCombatSystem(context=>({context:combatContext(context)})),...createPlayerSystems(gameplay),...modeSystems]);
}
