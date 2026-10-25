import { protectedAreaAt } from "../content/places.ts";
import { playerPose } from "./ride.ts";
import { toLatLon } from "../geo/project.ts";
import { sortedIds, type SimState } from "./contract.ts";
import { createClockSystem, gameTime } from "./clock/calendar.ts";
import { createFogSystem, fogDensity, floodDepthAt, puddlesNear, rainDensity, shelteredAt, weatherRefuge } from "./fog/index.ts";
import { allocateActorIds } from "./identity.ts";
import { createAgentsSystem, agentsCombatOptions } from "./agents/systems.ts";
import { agentsRuntimeOf } from "./agents/runtime.ts";
import type { AgentRuntimeOptions } from "./agents/runtime.ts";
import { createCombatSystem } from "./combat/systems.ts";
import { contextFromState, type CombatAdapterOptions } from "./combat/adapter.ts";
import { systems as modeSystems } from "./modes/systems.ts";
import { combatLoadout, createPlayerSystems, createObservedGameplayProvider, gameplaySnapshot } from "./player/adapter.ts";
import type { SimSystem, SimSystemContext } from "./system-contract.ts";
import type { CombatWave, RefillSource } from "./combat-contract.ts";
import { buildMissionParkingWorld } from "./missions/parking-world.ts";
import { CITY_DIRECTOR_CARDS, CITY_LIFE, cityBadRate, populationScale } from "../content/cityLife.ts";

/** Same tick, players and every extension slot but combat (the combat context's inputs). */
function sameExceptCombat(a:Readonly<SimState>,b:Readonly<SimState>):boolean{
  if(a.tick!==b.tick||a.seed!==b.seed||a.players!==b.players)return false;
  const keys=Object.keys(a.ext);
  if(keys.length!==Object.keys(b.ext).length)return false;
  for(const key of keys)if(key!=="combat"&&(a.ext as Record<string,unknown>)[key]!==(b.ext as Record<string,unknown>)[key])return false;
  return true;
}

export interface GameSystemsOptions {
  wave?: CombatWave;
  protectedArea?: (x:number,z:number)=>boolean;
  /** Match instances (src/sim/modes): extra agent-runtime options, e.g. the mode roster. */
  agents?: (context:SimSystemContext)=>Partial<AgentRuntimeOptions>;
  /** Match instances: extra combat options (mode, per-player loadouts). */
  combat?: (context:SimSystemContext)=>CombatAdapterOptions;
  /** Match instances: replaces the static modes registration. */
  modes?: readonly SimSystem[];
}

/**
 * The game: one explicit composition shared by the browser, headless drivers, relay sessions
 * and the sim bench. step()'s default SYSTEMS is only the static registrations (systems.ts).
 * tests/golden/composed-v14.json pins this path.
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
    ...options.agents?.(context),
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
  // The combat system and the observed gameplay provider both read this snapshot within one
  // tick; nothing it reads (players, agents, robots, clock, weather, progression) changes in
  // between, only ext.combat, which it never reads. Reuse it while those are the same objects.
  let cachedCombat:{context:SimSystemContext;value:ReturnType<typeof buildCombatContext>}|undefined;
  const combatContext=(context:SimSystemContext)=>{
    // A match's own combat options (options.combat) may read anything, so only the plain game caches.
    const hit=cachedCombat;
    if(!options.combat&&hit&&hit.context.world===context.world&&sameExceptCombat(hit.context.state,context.state))return hit.value;
    const value=buildCombatContext(context);
    cachedCombat={context,value};
    return value;
  };
  const buildCombatContext=(context:SimSystemContext)=>{
    const supplied=options.combat?.(context)??{};
    const snapshot=gameplaySnapshot(context),loadouts:Record<string,ReturnType<typeof combatLoadout>>={};
    for(const id of sortedIds(context.state.players)){
      const player=context.state.players[id]!,body=playerPose(player);
      loadouts[id]={...combatLoadout(snapshot,{id,mode:player.mode,x:body.x,y:body.y,z:body.z,speed:body.speed},body.heading),...supplied.loadouts?.[id]};
    }
    const calendar=gameTime(context.state),rain=weather?rainDensity(context.state):0,extra=weatherRefills(context);
    const agentOptions=agentsCombatOptions(context.state),runtime=agentsRuntimeOf(context.state);
    // From wave 4: the same live conversion budget the brains use (agents/runtime.ts naturalBad).
    const conversionCap=wave>=4&&runtime?2*sortedIds(runtime.actors).filter(id=>{const a=runtime.actors[id]!;return a.firmware==="bad"&&!a.converted&&!a.retired&&(context.state.ext.combat?.targets[id]?.phase??"active")==="active";}).length:agentOptions.conversionCap;
    const combat=contextFromState(context.world,context.state,{...supplied,...agentOptions,...(conversionCap!==undefined?{conversionCap}:{}),wave,loadouts,
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
  return Object.freeze([createClockSystem(),...(weather?[createFogSystem()]:[]),agents,createCombatSystem(context=>({context:combatContext(context)})),...createPlayerSystems(gameplay),...(options.modes??modeSystems)]);
}
