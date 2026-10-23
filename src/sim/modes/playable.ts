import { Action, NEUTRAL_INPUT, sortedIds, type InputFrame, type SimEvent, type SimState, type Spawn } from "../contract.ts";
import { activeBody, step } from "../step.ts";
import type { SimSystem } from "../system-contract.ts";
import { arenaCombatEvents,arenaContains,arenaWorld,constrainArenaMotion,hasArenaRefill } from "./arena.ts";
import { defaultMatchContext } from "./systems.ts";
import { createGameSystems } from "../game-systems.ts";
import { allocateActorIds } from "../identity.ts";
import { groundHeight, type World } from "../world.ts";
import { circleHitsWall, inCorridor, onWater } from "../boundary.ts";
import { planModeRoster } from "../agents/mode-roster.ts";
import { agentsCombatOptions } from "../agents/systems.ts";
import { agentsRuntimeOf, type RuntimeSpawn } from "../agents/runtime.ts";
import { createRivalBotState, planRivalBotInputs, type BotObservation, type RivalBotState } from "../bots/controller.ts";
import { contextFromState } from "../combat/adapter.ts";
import type { CombatPlayer } from "../combat-contract.ts";
import { protectedAreaAt } from "../../content/places.ts";
import { toLatLon } from "../../geo/project.ts";
import { createMatchSession, modeSessionOf, type MatchLoadout, type MatchPayoutEvent } from "./session.ts";
import type { MatchResult } from "./types.ts";

export class LocalMatchUnavailableError extends Error {
  readonly reason="refill";
  constructor(){super("This arena needs an accessible water refill");this.name="LocalMatchUnavailableError";}
}

export type LocalMatchMode = "botSweep" | "cleanStreets";
export interface LocalMatchConfig {
  id:string; mode:LocalMatchMode; seed:number; playerId:string; spawn:Spawn;
  loadouts?:Readonly<Record<string,MatchLoadout>>;
}
interface PlayableMatch {
  version:1; playerId:string; roster:RuntimeSpawn[]; bots:RivalBotState;
  center:{x:number;y:number;z:number}; radius:number;
}
export interface LocalMatchView {
  id:string; mode:LocalMatchMode; phase:"active"|"finished"; remainingTicks:number;
  objectivesRemaining:number; score:number; runway:number; lives:number;
  result:MatchResult|null; payouts:readonly MatchPayoutEvent[];
}
function playable(state:Readonly<SimState>):PlayableMatch|undefined {
  return (state.ext.modes as unknown as {playable?:PlayableMatch}|undefined)?.playable;
}
function excluded(x:number,z:number):boolean {const p=toLatLon(x,z);return Boolean(protectedAreaAt([p.lat,p.lon]));}
function distanceSquared(a:{x:number;z:number},b:{x:number;z:number}):number {const x=a.x-b.x,z=a.z-b.z;return x*x+z*z;}
function dryArenaPoint(world:World,x:number,z:number):boolean {
  return !world.walls||!circleHitsWall(world.walls,x,z,.5)&&(!onWater(world.walls.shore,x,z)||inCorridor(world.walls,x,z));
}

/** A separate, locally playable instance. It never accepts or copies a free-roam wallet. */
export function createLocalMatch(world:World,config:LocalMatchConfig):SimState {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(config.id)||excluded(config.spawn.x,config.spawn.z)||!dryArenaPoint(world,config.spawn.x,config.spawn.z))throw new Error("Choose a dry arena outside excluded areas");
  const botId=`rival:${config.id}`;
  if(config.playerId===botId)throw new Error("Reserved rival identity");
  const players=config.mode==="cleanStreets"?[config.playerId,botId]:[config.playerId];
  const relayId=`mission:mode-${config.id}:update-relay`;
  const center={x:config.spawn.x,y:groundHeight(world,config.spawn.x,config.spawn.z),z:config.spawn.z},radius=120;
  const arena={center,radius},isolated=arenaWorld(world,arena);
  if(!hasArenaRefill(isolated,arena))throw new LocalMatchUnavailableError();
  let state=createMatchSession(isolated,{id:config.id,mode:config.mode,seed:config.seed,players,...(config.mode==="botSweep"?{relayId}:{})},config.spawn,config.loadouts);
  const roster=planModeRoster(isolated,state,{id:config.id,mode:config.mode==="botSweep"?"bot-sweep":"clean-streets",playerCount:players.length,center,radius,
    contains:(x,z)=>arenaContains(arena,x,z,1)&&!excluded(x,z)&&dryArenaPoint(isolated,x,z)},isolated.sidewalks);
  // Missing objectives cannot turn an unbuilt arena into an automatic win.
  if(roster.blocked.length||roster.actors.length!==(config.mode==="botSweep"?121:120))throw new Error("This location has insufficient clear space for the match");
  const reserved=allocateActorIds(state,roster.actors.map(actor=>actor.id));state=reserved.state;
  const actors=roster.actors.map(actor=>({...actor,numericId:reserved.ids[actor.id]!}));
  const session=modeSessionOf(state)!;
  const bots=createRivalBotState(config.mode==="cleanStreets"?{[botId]:"hunter"}:{});
  const local:PlayableMatch={version:1,playerId:config.playerId,roster:actors,bots,center,radius};
  state={...state,ext:{...state.ext,modes:JSON.parse(JSON.stringify({...session,match:{...session.match,remainingBad:actors.filter(actor=>actor.firmware==="bad"&&actor.id!==relayId).map(actor=>actor.id)},playable:local}))}};
  return state;
}

function loadout(item:MatchLoadout):Partial<CombatPlayer> {
  const perks:Record<string,NonNullable<CombatPlayer["perks"]>[number]>={"marine-layer":"marine","do-not-disturb":"quiet","stealth-mode":"stealth",lean:"lean",brackish:"brackish","hydrant-whisperer":"whisperer"};
  return {nozzle:["standard","pressure","wide"].includes(item.nozzle)?item.nozzle as CombatPlayer["nozzle"]:"standard",
    gear:["boots","airplane","microclimate","none"].includes(item.gear)?item.gear as CombatPlayer["gear"]:"none",
    gadget:["balloon","sprinkler","speaker"].includes(item.gadget)?item.gadget as CombatPlayer["gadget"]:"balloon",
    perks:item.perks.flatMap(id=>perks[id]?[perks[id]!]:[])};
}
const systems=createGameSystems({wave:5,
  matchContext:context=>{const observed=defaultMatchContext(context),ids=new Set(playable(context.state)?.roster.map(actor=>actor.id)??[]);return {...observed,combatEvents:arenaCombatEvents(observed.combatEvents??[],ids)};},
  agents:context=>({spawns:playable(context.state)?.roster??[],services:false}),
  combat:context=>{
    const session=modeSessionOf(context.state);if(!session)return {};
    const rivals=Object.fromEntries(sortedIds(session.match.players).map(id=>[id,sortedIds(session.match.players).filter(other=>session.match.players[other]!.team!==session.match.players[id]!.team)]));
    return {mode:session.match.mode==="cleanStreets"?"clean-streets":"bot-sweep",rivalPlayerIds:rivals,
      loadouts:Object.fromEntries(sortedIds(session.loadouts).map(id=>[id,loadout(session.loadouts[id]!)]))};
  },
}).map<SimSystem>(system=>system.key!=="robots"||!system.prepare?system:{...system,prepare(context){
  const prepared=system.prepare!(context),local=playable(context.state);if(!local)return prepared;
  const motions=prepared.motions.map(motion=>constrainArenaMotion(context.world,local,motion));
  const robots=agentsRuntimeOf(prepared.state);
  return {...prepared,motions,state:robots?{...prepared.state,ext:{...prepared.state.ext,robots:{...robots,proposals:motions}}}:prepared.state};
}});

/** One canonical tick; bot controls come from visible bodies and completed scanner readings. */
export function stepLocalMatch(world:World,state:Readonly<SimState>,inputs:InputFrame,events:readonly SimEvent[]=[]):SimState {
  const local=playable(state),session=modeSessionOf(state);if(!local||!session)throw new Error("Not a local match");
  if(session.match.phase==="finished")return state as SimState;
  const isolated=arenaWorld(world,local);
  if((state.ext.combat?.pauseUntil??0)>state.tick)return step(isolated,state,inputs,[...events],systems);
  const runtime=agentsRuntimeOf(state),combat=contextFromState(isolated,state,{...agentsCombatOptions(state),wave:4});
  const observations:BotObservation[]=sortedIds(local.bots.bots).map(id=>{
    const body=activeBody(state.players[id]!);
    const actors=combat.actors.filter(actor=>actor.playerId!==id&&distanceSquared(actor,body)<=40*40)
      .sort((a,b)=>distanceSquared(a,body)-distanceSquared(b,body)||(a.id<b.id?-1:1)).slice(0,256)
      .map(actor=>({id:actor.id,kind:actor.kind,x:actor.x,y:actor.y,z:actor.z,visible:true,operational:actor.kind==="player"||state.ext.combat?.targets[actor.id]?.phase===undefined||state.ext.combat.targets[actor.id]!.phase==="active",height:actor.height,
        // Behaviour can raise suspicion, but hidden firmware never enters bot observations.
        suspicion:runtime?.actors[actor.id]?.behavior==="attack"?1:0,rival:!!actor.playerId&&session.match.players[actor.playerId]?.team!==session.match.players[id]?.team}));
    const refills=[...(isolated.gameplay?.refills??[])].sort((a,b)=>distanceSquared(a,body)-distanceSquared(b,body)||(a.id<b.id?-1:1)).slice(0,64);
    return {playerId:id,actors,refills,objective:local.center,paused:session.match.players[id]!.downUntil>state.tick};
  });
  const plan=planRivalBotInputs(isolated,state,local.bots,observations);
  const commanded=plan.commands.map(command=>{const {playerId,...payload}=command;return {tick:state.tick+1,kind:"gameplay.command",playerId,payload};});
  const controls={...inputs,...plan.inputs};
  for(const id of sortedIds(local.bots.bots))if(state.players[id]?.mode==="vehicle")controls[id]={...NEUTRAL_INPUT,actions:Math.abs(state.players[id]!.car.speed)<.1?Action.enterExit:0,brake:1};
  for(const id of sortedIds(session.match.players))if(session.match.players[id]!.downUntil>state.tick)controls[id]={...NEUTRAL_INPUT};
  // Re-enter through core's ordinary, clearance-checked spawn path. No pose is
  // assigned by the mode, and each request is consumed on the next tick only.
  const respawns:SimEvent[]=session.match.events.filter(event=>event.tick===state.tick&&event.kind==="match.respawn-request").flatMap(event=>[
    {tick:state.tick+1,kind:"player.leave",playerId:event.playerId},
    {tick:state.tick+1,kind:"player.join",playerId:event.playerId,payload:{x:local.center.x,z:local.center.z,heading:0}},
  ]);
  const next=step(isolated,state,controls,[...events,...commanded,...respawns],systems);
  const nextMode=next.ext.modes as unknown as Record<string,unknown>;
  return {...next,ext:{...next.ext,modes:JSON.parse(JSON.stringify({...nextMode,playable:{...local,bots:plan.state}}))}};
}
export function localMatchView(state:Readonly<SimState>):LocalMatchView|null {
  const local=playable(state),session=modeSessionOf(state);if(!local||!session)return null;
  const match=session.match,player=match.players[local.playerId]!;
  return {id:match.id,mode:match.mode as LocalMatchMode,phase:match.phase,remainingTicks:Math.max(0,match.durationTicks-match.elapsedTicks),objectivesRemaining:match.remainingBad.length+(match.relayId?1:0),score:player.score,runway:player.runway,lives:match.lives,result:match.result,payouts:session.payouts};
}
