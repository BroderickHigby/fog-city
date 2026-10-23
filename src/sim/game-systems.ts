import { protectedAreaAt, badRobotRate } from "../content/places.ts";
import { toLatLon } from "../geo/project.ts";
import { sortedIds } from "./contract.ts";
import { createClockSystem, gameTime } from "./clock/calendar.ts";
import { fogDensity } from "./fog/index.ts";
import { allocateActorIds } from "./identity.ts";
import { createAgentsSystem, agentsCombatOptions } from "./agents/systems.ts";
import { createCombatSystem } from "./combat/systems.ts";
import { contextFromState } from "./combat/adapter.ts";
import { systems as modeSystems } from "./modes/systems.ts";
import { combatLoadout, createPlayerSystems, createObservedGameplayProvider, gameplaySnapshot } from "./player/adapter.ts";
import type { SimSystem, SimSystemContext } from "./system-contract.ts";
import type { CombatActor, CombatWave } from "./combat-contract.ts";
import type { GameplayFact } from "./gameplay-contract.ts";
import { impactsOf } from "./impacts.ts";
import type { AgentsExt } from "./agents.ts";
import { buildMissionParkingWorld } from "./missions/parking-world.ts";

/** Knocking over a good robot with your car: $30 and 3 reputation (impacts.ts; design decision log 2026-10-23). */
export const RAM_GOOD_ROBOT_CENTS = 3000;

/**
 * A player's car knocking a good robot over this tick becomes an economy penalty (a fact the
 * economy reducer already settles: cash and reputation). Bad robots cost nothing. `actors` (the
 * combat actors, with their firmware) is only built when there is such a hit.
 */
export function rammedRobotFacts(context:SimSystemContext,actors:()=>readonly CombatActor[]):GameplayFact[] {
  const tick=context.state.tick;
  const hits=(impactsOf(context.state)?.events??[]).filter(e=>e.tick===tick&&e.kind==="car-robot"&&e.fell===true&&e.a.startsWith("p:"));
  if(!hits.length)return [];
  const list=(context.state.ext.agents as AgentsExt|undefined)?.list??[];
  const all=actors();
  const out:GameplayFact[]=[];
  for(const e of hits){
    const agent=list.find(a=>a.id===Number(e.b.slice(2)));
    if(!agent)continue;
    const actorId=agent.runtimeId??`agent:${agent.id}`;
    const actor=all.find(a=>a.id===actorId);
    if(!actor||actor.kind!=="robot"||actor.firmware!=="good")continue;
    out.push({id:`world:ram-${e.id}`,source:"world",sequence:e.id,tick,kind:"economy.penalty",playerId:e.a.slice(2),actorId,amount:RAM_GOOD_ROBOT_CENTS/100,detail:"reputation:-3 rammed"});
  }
  return out;
}

export interface GameSystemsOptions { wave?: CombatWave; protectedArea?: (x:number,z:number)=>boolean }

/**
 * The game: one explicit composition shared by the browser, headless drivers, relay sessions
 * and the sim bench. step()'s default SYSTEMS is only the static registrations (systems.ts).
 * tests/golden/composed-v11.json pins this path (composed-v8.json is the v8 record).
 */
export function createGameSystems(options: GameSystemsOptions = {}): readonly SimSystem[] {
  const wave=options.wave??2;
  const protectedArea=options.protectedArea??((x:number,z:number)=>{const p=toLatLon(x,z);return Boolean(protectedAreaAt([p.lat,p.lon]));});
  const agents=createAgentsSystem(context=>({wave,graph:context.world.sidewalks,transit:context.world.transit,protectedArea,
    badRateAt:(x:number,z:number)=>{const p=toLatLon(x,z);return badRobotRate([p.lat,p.lon]);},
    fog:fogDensity(context.world,context.state,0,0),
    fogAt:(x:number,z:number)=>fogDensity(context.world,context.state,x,z),
  }),allocateActorIds);
  const combatContext=(context:SimSystemContext)=>{
    const snapshot=gameplaySnapshot(context),loadouts:Record<string,ReturnType<typeof combatLoadout>>={};
    for(const id of sortedIds(context.state.players)){
      const player=context.state.players[id]!,body=player.mode==="foot"&&player.foot?player.foot:player.car;
      loadouts[id]=combatLoadout(snapshot,{id,mode:player.mode,x:body.x,y:body.y,z:body.z,speed:body.speed},body.heading);
    }
    const calendar=gameTime(context.state);
    return contextFromState(context.world,context.state,{...agentsCombatOptions(context.state),wave,loadouts,
      refills:context.world.gameplay?.refills??[],night:calendar.hour>=19||calendar.hour<6,
      fog:fogDensity(context.world,context.state,0,0),
      fogAt:(x:number,z:number)=>fogDensity(context.world,context.state,x,z)});
  };
  const observed=createObservedGameplayProvider({wave,actors:context=>combatContext(context).actors,
    facts:context=>rammedRobotFacts(context,()=>combatContext(context).actors),
    protectedArea,fog:context=>fogDensity(context.world,context.state,0,0),
    missionParking:context=>buildMissionParkingWorld(context,context.world.parking?.rules??[],context.world.streetCleaning?.rules??[]),
    calendar:context=>{const time=gameTime(context.state);return {day:time.dayIndex,month:time.month,hour:time.hour,minute:time.minute};}});
  let cachedObservation:{context:SimSystemContext;value:ReturnType<typeof observed>}|undefined;
  const gameplay=(context:SimSystemContext)=>{
    const previous=cachedObservation?.context;
    // The six reducers observe the same immutable tick. A branch/replay gets a
    // different previous or input identity and is always recomputed.
    if(previous&&previous.previous===context.previous&&previous.world===context.world&&previous.inputs===context.inputs&&previous.events===context.events&&previous.state.tick===context.state.tick&&previous.state.players===context.state.players&&previous.state.ext.agents===context.state.ext.agents&&previous.state.ext.robots===context.state.ext.robots&&previous.state.ext.combat===context.state.ext.combat&&previous.state.ext.clock===context.state.ext.clock)return cachedObservation!.value;
    const calendar=gameTime(context.state);
    const value={...observed(context),day:calendar.dayIndex,month:calendar.month};
    cachedObservation={context,value};
    return value;
  };
  return Object.freeze([createClockSystem(),agents,createCombatSystem(context=>({context:combatContext(context)})),...createPlayerSystems(gameplay),...modeSystems]);
}
