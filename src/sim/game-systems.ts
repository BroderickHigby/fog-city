import { protectedAreaAt, badRobotRate } from "../content/places.ts";
import { toLatLon } from "../geo/project.ts";
import { sortedIds } from "./contract.ts";
import { createClockSystem, gameTime } from "./clock/calendar.ts";
import { fogDensity } from "./fog/index.ts";
import { allocateActorIds } from "./identity.ts";
import { createAgentsSystem, agentsCombatOptions } from "./agents/systems.ts";
import { agentsRuntimeOf } from "./agents/runtime.ts";
import { createCombatSystem } from "./combat/systems.ts";
import { contextFromState } from "./combat/adapter.ts";
import { systems as modeSystems } from "./modes/systems.ts";
import { combatLoadout, createPlayerSystems, createObservedGameplayProvider, gameplaySnapshot } from "./player/adapter.ts";
import type { SimSystem, SimSystemContext } from "./system-contract.ts";
import type { CombatWave } from "./combat-contract.ts";
import { buildMissionParkingWorld } from "./missions/parking-world.ts";
import { getawayControls } from "./missions/mechanics/fleet.ts";
import { stepVehicleFollower } from "./vehicles/follower.ts";

export interface GameSystemsOptions { wave?: CombatWave; protectedArea?: (x:number,z:number)=>boolean }

/**
 * The game: one explicit composition shared by the browser, headless drivers, relay sessions
 * and the sim bench. step()'s default SYSTEMS is only the static registrations (systems.ts).
 * tests/golden/composed-v8.json pins this path.
 */
export function createGameSystems(options: GameSystemsOptions = {}): readonly SimSystem[] {
  const wave=options.wave??2;
  const protectedArea=options.protectedArea??((x:number,z:number)=>{const p=toLatLon(x,z);return Boolean(protectedAreaAt([p.lat,p.lon]));});
  const agents=createAgentsSystem(context=>({wave,graph:context.world.sidewalks,transit:context.world.transit,protectedArea,
    badRateAt:(x:number,z:number)=>{const p=toLatLon(x,z);return badRobotRate([p.lat,p.lon]);},
    fog:fogDensity(context.world,context.state,0,0),
    fogAt:(x:number,z:number)=>fogDensity(context.world,context.state,x,z),
    ...(wave>=4?{vehicleControls:getawayControls(context.state)}:{}),
  }),allocateActorIds);
  const combatContext=(context:SimSystemContext)=>{
    const snapshot=gameplaySnapshot(context),loadouts:Record<string,ReturnType<typeof combatLoadout>>={};
    for(const id of sortedIds(context.state.players)){
      const player=context.state.players[id]!,body=player.mode==="foot"&&player.foot?player.foot:player.car;
      loadouts[id]=combatLoadout(snapshot,{id,mode:player.mode,x:body.x,y:body.y,z:body.z,speed:body.speed},body.heading);
    }
    const calendar=gameTime(context.state),agentOptions=agentsCombatOptions(context.state),runtime=agentsRuntimeOf(context.state);
    // From wave 4: the same live conversion budget the brains use (agents/runtime.ts naturalBad).
    const conversionCap=wave>=4&&runtime?2*sortedIds(runtime.actors).filter(id=>{const a=runtime.actors[id]!;return a.firmware==="bad"&&!a.converted&&!a.retired&&(context.state.ext.combat?.targets[id]?.phase??"active")==="active";}).length:agentOptions.conversionCap;
    return contextFromState(context.world,context.state,{...agentOptions,...(conversionCap!==undefined?{conversionCap}:{}),wave,loadouts,
      refills:context.world.gameplay?.refills??[],night:calendar.hour>=19||calendar.hour<6,
      fog:fogDensity(context.world,context.state,0,0),
      fogAt:(x:number,z:number)=>fogDensity(context.world,context.state,x,z)});
  };
  const observed=createObservedGameplayProvider({wave,actors:context=>combatContext(context).actors,
    protectedArea,fog:context=>fogDensity(context.world,context.state,0,0),
    ...(wave>=4?{missionDrive:(context:SimSystemContext)=>(body,previous,target,maxSpeed)=>stepVehicleFollower(context.world,body,previous,{kind:"pursue",target,stopDistance:4,maxSpeed})}:{}),
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
