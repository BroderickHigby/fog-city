import type { SimState } from "../contract.ts";
import type { World } from "../world.ts";
import type { MissionActor } from "../../content/missions.ts";
import { planMissionActors, type MissionActorPlan } from "./mission-actors.ts";
import type { SidewalkGraph } from "./navigation.ts";

export interface ModeRosterRequest {
  /** Stable ID of the approved mode instance, reused on retries. */
  id: string;
  mode: "bot-sweep" | "clean-streets";
  playerCount: number;
  center: {x:number;y:number;z:number};
  radius: number;
  /** The approved instance polygon, never an arbitrary radius substituted for it. */
  contains: (x:number,z:number)=>boolean;
}

/** Deterministic blueprint roster; core's shared allocator admits the actual bodies. */
export function planModeRoster(world:World,sim:Readonly<SimState>,request:ModeRosterRequest,graph?:SidewalkGraph):MissionActorPlan {
  if(!["bot-sweep","clean-streets"].includes(request.mode)||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(request.id)||!Number.isSafeInteger(request.playerCount)||request.playerCount<1||request.playerCount>24||!Number.isFinite(request.radius)||request.radius<6||request.radius>300||![request.center.x,request.center.y,request.center.z].every(Number.isFinite))throw new Error("Invalid mode roster request");
  const bad=request.mode==="clean-streets"?30:10+4*request.playerCount;
  const definitions:Record<string,MissionActor>={};
  const aliases:string[]=[];
  for(let index=0;index<120;index++){
    const id=`unit-${String(index).padStart(3,"0")}`;aliases.push(id);
    definitions[id]={kind:index<bad?"badRobot":"goodRobot",archetype:index%3===0?"Trundle":"Footman"};
  }
  if(request.mode==="bot-sweep"){
    aliases.push("update-relay");definitions["update-relay"]={kind:"badRobot",archetype:"UpdateRelay"};
  }
  return planMissionActors(world,sim,{missionId:`mode-${request.id}`,stepId:"roster",actorIds:aliases,definitions,place:request.center,radius:request.radius},graph,request.contains);
}
