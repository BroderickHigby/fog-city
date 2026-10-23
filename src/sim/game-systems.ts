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
import type { CombatWave } from "./combat-contract.ts";

export interface GameSystemsOptions { wave?: CombatWave; protectedArea?: (x:number,z:number)=>boolean }

/** One explicit composition shared by browser, headless drivers and relay sessions. */
export function createGameSystems(options: GameSystemsOptions = {}): readonly SimSystem[] {
  const wave=options.wave??2;
  const protectedArea=options.protectedArea??((x:number,z:number)=>{const p=toLatLon(x,z);return Boolean(protectedAreaAt([p.lat,p.lon]));});
  const agents=createAgentsSystem(context=>({wave,graph:context.world.sidewalks,transit:context.world.transit,protectedArea,
    badRateAt:(x:number,z:number)=>{const p=toLatLon(x,z);return badRobotRate([p.lat,p.lon]);},
    fog:fogDensity(context.world,context.state,0,0),
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
      fog:fogDensity(context.world,context.state,0,0)});
  };
  const observed=createObservedGameplayProvider({wave,actors:context=>combatContext(context).actors,
    protectedArea,fog:context=>fogDensity(context.world,context.state,0,0)});
  const gameplay=(context:SimSystemContext)=>{
    const calendar=gameTime(context.state);
    return {...observed(context),day:calendar.dayIndex,month:calendar.month};
  };
  return Object.freeze([createClockSystem(),agents,createCombatSystem(context=>({context:combatContext(context)})),...createPlayerSystems(gameplay),...modeSystems]);
}
