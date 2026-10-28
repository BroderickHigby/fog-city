import { runtimeDeviceLure,lureStepAllowed } from "./lures.ts";
import { activeWorldTick } from "../pause-timers.ts";
import { isCivilianTraffic } from "../civilian-traffic.ts";
import { BOT_TELLS, botAtLevel } from "../../content/botTells.ts";
import { agentActorId } from "../identity.ts";
import { playerPose } from "../ride.ts";
import { ROBOT_GOALS, goalsInWave } from "../../content/robotGoals.ts";
import { badRobotRate, protectedAreaAt } from "../../content/places.ts";
import { toLatLon } from "../../geo/project.ts";
import { Action, type InputFrame, type SimInput, type SimState } from "../contract.ts";
import { AGENT_SPEC, ROBOTAXI_BODY, agentsOf, personIsChild, type AgentState } from "../agents.ts";
import { CAR } from "../car.ts";
import { DETOUR_CLEAR_M, DETOUR_LOOK_M, DETOUR_REJOIN_M, DETOUR_TICKS, boxGap, detourWaypoint, type DetourBox } from "./detour.ts";
import { dcos, dsin, datan2, clamp, PI } from "../dmath.ts";
import type { AgentMotionProposal as CoreAgentMotionProposal } from "../motion.ts";
import { circleBlocked, groundHeight, segmentBlocked, type World } from "../world.ts";
import type { AttackKind, AttackRequest, CombatActor, CombatState } from "../combat-contract.ts";
import { createRobotBrain, stepRobotBrain, type RobotBrainState, type RobotBrainIntent, type RobotObservations, type BrainTarget, type RobotGoal } from "../robots/brain.ts";
import { buildFallbackSidewalkGraph, nearestSidewalkNode, shortestSidewalkRoute, advanceSidewalkRoute, type SidewalkGraph, type SidewalkRoute, type SidewalkCursor } from "./navigation.ts";
import { planFidelity, type FidelityAnchor } from "./fidelity.ts";
import type { TransitLayer, TransitRuntimeState } from "./transit-runtime.ts";
import type { AdWrapSlot } from "./services.ts";
import type { ServiceRuntimeState } from "./service-runtime.ts";
import type { PendingMissionStages } from "./mission-staging.ts";
import { IDLE_REACTION, reactToPerception, type ReactionState, type PerceivedStimulus } from "./reactions.ts";

export type RuntimeModel = "footman" | "trundle" | "robotaxi" | "person" | "pigeon" | "dog" | "van" | "bus" | "drone" | "patrol" | "sign-spinner" | "tidy" | "associate" | "walker";

export interface RuntimeSpawn {
  id: string;
  /** Allocated by the core owner; this module does not reserve a private numeric range. */
  numericId: number;
  model: RuntimeModel;
  firmware: "good" | "bad" | "none";
  x: number; y: number; z: number; heading: number;
  radius: number; height: number;
  halfLength?: number; halfWidth?: number;
  /** Unsigned motion speed. Physical bodies keep signed forward velocity separately. */
  speed?: number;
  protected?: boolean;
  child?: boolean;
  posture?: "standing" | "seated" | "lying";
  mobilityAid?: boolean;
  ownerId?: string;
  significant?: boolean;
  rustScale?: number;
  archetype?: string;
  level?: number;
  adWrapSlot?: AdWrapSlot;
  posted?: boolean;
}

export interface RuntimeActor extends RuntimeSpawn {
  legacyId: number | null;
  speed: number;
  bornTick: number;
  retired: boolean;
  converted: boolean;
  significant: boolean;
  brain: RobotBrainState | null;
  intent: RobotBrainIntent | null;
  reaction: ReactionState;
  route: SidewalkRoute | null;
  cursor: SidewalkCursor;
  goalNode: string;
  pendingCursor: SidewalkCursor | null;
  pendingPoint: {x:number;z:number} | null;
  attackSequence: number;
  actionToken: string;
  fidelity: "full" | "active" | "abstract" | "despawn";
  behavior: string;
  bag: "none" | "empty" | "full";
  statusLight: "steady" | "flicker";
  tellIds: string[];
  tellIntensity: number;
  hiddenTellId: string | null;
  /** v13: walking round a stopped vehicle to (x, z), where its route carries on from `cursor` (detour.ts). */
  detour?: { x: number; z: number; cursor: SidewalkCursor; until: number } | null;
  /** v11: when it last began a glance at someone standing near (GLANCE_COOLDOWN_TICKS). */
  glanced?: number;
  /** v10: where and when it last made progress while wanting to walk (WALKER_STALL_TICKS). */
  stall?: { x: number; z: number; tick: number };
}

export interface AgentMotionProposal extends CoreAgentMotionProposal {
  /** Follower controls are consumed by core's vehicle physics, once per tick. */
  controls?: Readonly<SimInput>;
}

export interface AgentRuntimeEvent {
  id: string;
  tick: number;
  kind: "actor.retired" | "actor.spawned" | "actor.converted" | "actor.behavior";
  actorId: string;
  detail: string;
}

export interface AgentsRuntimeState {
  version: 1;
  tick: number;
  actors: Record<string, RuntimeActor>;
  missionBindings: Record<string,string>;
  missionStages?: PendingMissionStages;
  services?: ServiceRuntimeState;
  transit?: TransitRuntimeState;
  baseBadCount: number;
  lastCombatTick: number;
  attacks: AttackRequest[];
  proposals: AgentMotionProposal[];
  events: AgentRuntimeEvent[];
  /** v11 city life: each player's ambient density multipliers by kind (read by populate in agents.ts). */
  density?: Record<string, Record<string, number>>;
  /** v11 city life: street incidents staged for the director (incidents.ts), by id, and the next number. */
  incidents?: Record<string, import("./incidents.ts").Incident>;
  nextIncident?: number;
}

export interface AgentRuntimeOptions {
  graph?: SidewalkGraph;
  services?: boolean;
  /** v21 authored weather scaling for autonomous robots only; finite values clamp to .5..1. */
  speedMultiplier?: number;
  transit?: TransitLayer;
  vehicleControls?: Readonly<Record<string,Readonly<SimInput>>>;
  spawns?: readonly RuntimeSpawn[];
  /** Core's resulting positions from the previous proposal; absence preserves the old body. */
  observedBodies?: readonly Pick<RuntimeSpawn,"id"|"x"|"y"|"z"|"heading"|"speed">[];
  firmware?: Readonly<Record<string,"good"|"bad"|"none">>;
  wave?: number;
  badRateAt?: (x:number,z:number)=>number;
  fog?: number;
  /** Position-specific weather/fog; core supplies the authoritative sample. */
  fogAt?: (x:number,z:number)=>number;
  /** Where weather sends a bad robot standing at (x, z) (shelter from rain, inland off a flooded promenade), or null. */
  weatherRefuge?: (x:number,z:number)=>{x:number;z:number}|null;
  /** Core owns player-controlled bodies, so autonomous brains never propose motion for them. */
  controlledActorIds?: readonly string[];
  conversionCap?: number;
  /** Scenario or camera anchors are accepted only when recorded in the simulation. */
  anchors?: readonly FidelityAnchor[];
  protectedArea?: (x:number,z:number)=>boolean;
  /** v17 game composition: close visible rogue encounters can engage an on-foot player. */
  engagePlayers?: boolean;
  crossingBlocked?: (edgeId:string)=>boolean;
  /** v11 city life: ambient density multipliers by kind for an area owned by a player standing at (x, z). */
  densityAt?: (x:number,z:number)=>Record<string,number>;
  /** v11 city life: stage the director's cards as street incidents (incidents.ts). */
  director?: { cards: readonly import("../../content/directorCards.ts").DirectorCard[]; stageM: readonly [number,number]; maxActive: number };
}

export const MAX_RUNTIME_ACTORS = 4096;
const DT=1/60;
const BODY_EPSILON=.015;
const attackKinds:Record<string,AttackKind>={shove:"shove",grocerySnatch:"snatch",adBlast:"ad-blast",phoneHack:"phone-hack",handshake:"handshake"};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Sorted ids of an actors record that synchronize() built (no key is added to it afterwards). */
const sortedActorIds=new WeakMap<object,readonly string[]>();
function keys<T>(record:Readonly<Record<string,T>>):string[]{const hit=sortedActorIds.get(record);return hit?[...hit]:Object.keys(record).sort(compare);}
function distance(a:{x:number;z:number},b:{x:number;z:number}):number{return Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.z-b.z)*(a.z-b.z));}
function bodyOf(player:SimState["players"][string]){return playerPose(player);}
function players(state:Readonly<SimState>){return keys(state.players).map(id=>({id,mode:state.players[id]!.mode,...bodyOf(state.players[id]!)}));}
function hash(value:string):number{let out=2166136261;for(let i=0;i<value.length;i++)out=Math.imul(out^value.charCodeAt(i),16777619);return out>>>0;}
/** Sequential actor IDs need avalanche mixing before a probability threshold: raw FNV
 * puts whole runs of nearby IDs on the same side of a low bad-firmware share. */
function firmwareRoll(seed:number,id:string,version:number):number{
  let value=hash(`${seed}:${id}`);
  if(version>=17){value=Math.imul(value^(value>>>16),0x85ebca6b);value=Math.imul(value^(value>>>13),0xc2b2ae35);value=(value^(value>>>16))>>>0;}
  return value/4294967296;
}
function defaultBadRate(x:number,z:number):number{const point=toLatLon(x,z);return badRobotRate([point.lat,point.lon]);}
function defaultProtected(x:number,z:number):boolean{const point=toLatLon(x,z);return Boolean(protectedAreaAt([point.lat,point.lon]));}
function activeCombat(state:Readonly<SimState>):CombatState|undefined{return state.ext.combat;}
function phase(state:Readonly<SimState>,id:string):string{return activeCombat(state)?.targets[id]?.phase??"active";}
function archetype(model:RuntimeModel){return model==="trundle"?"trundle":model==="patrol"?"patrol":"footman";}
function vehicle(model:RuntimeModel):boolean{return model==="robotaxi"||model==="van"||model==="bus";}
function animal(model:RuntimeModel):boolean{return model==="pigeon"||model==="dog";}
function human(model:RuntimeModel):boolean{return model==="person"||model==="associate";}

function initialize(spawn:RuntimeSpawn,tick:number,legacyId:number|null):RuntimeActor{
  if([spawn.halfLength,spawn.halfWidth,spawn.rustScale].some(value=>value!==undefined&&(!Number.isFinite(value)||value<=0))||spawn.speed!==undefined&&(!Number.isFinite(spawn.speed)||spawn.speed<0)||spawn.model==="tidy"&&spawn.firmware==="bad")throw new Error("Invalid runtime metadata");
  if(!spawn.id||!Number.isSafeInteger(spawn.numericId)||spawn.numericId<1||![spawn.x,spawn.y,spawn.z,spawn.heading,spawn.radius,spawn.height].every(Number.isFinite)||spawn.radius<=0||spawn.height<=0)throw new Error("Invalid runtime actor");
  const profile=spawn.archetype&&BOT_TELLS.archetypes.some(candidate=>candidate.id===spawn.archetype)?botAtLevel(spawn.archetype,spawn.level??1):undefined;
  const tells=profile?[...profile.tells,...profile.camouflage]:[];
  const bag:RuntimeActor["bag"]=tells.some(tell=>tell.behaviour.kind==="emptyBag"||tell.behaviour.kind==="emptyBagReturning")?"empty":tells.some(tell=>tell.behaviour.kind==="fullBag")?"full":spawn.model==="footman"?(spawn.firmware==="good"?"full":"empty"):"none";
  return {...spawn,...(vehicle(spawn.model)?{halfLength:spawn.halfLength??(spawn.model==="bus"?6.6:spawn.model==="van"?2.7:2.2),halfWidth:spawn.halfWidth??(spawn.model==="bus"?1.35:spawn.model==="van"?1.1:.95)}:{}),legacyId,speed:spawn.speed??0,bornTick:tick,retired:false,converted:false,significant:spawn.significant??false,
    brain:spawn.firmware==="bad"&&!vehicle(spawn.model)?createRobotBrain({id:spawn.numericId,archetype:archetype(spawn.model),tick}):null,
    intent:null,reaction:IDLE_REACTION,route:null,cursor:{stepIndex:0,distanceM:0},goalNode:"",pendingCursor:null,pendingPoint:null,attackSequence:0,actionToken:"",fidelity:"full",behavior:"idle",bag,statusLight:tells.some(tell=>tell.behaviour.kind==="faceLightFlicker")?"flicker":"steady",tellIds:tells.map(tell=>tell.id),tellIntensity:profile?.intensity??1,hiddenTellId:null};
}

function legacySpawn(agent:AgentState,seed:number,options:AgentRuntimeOptions,version:number):RuntimeSpawn{
  const id=agentActorId(agent.id), model=agent.kind==="errandRobot"?"footman":agent.kind==="sidewalkBot"?"trundle":agent.kind;
  const firmware=options.firmware?.[id]??(model==="person"?"none":firmwareRoll(seed,id,version)<clamp((options.badRateAt??defaultBadRate)(agent.x,agent.z),0,1)?"bad":"good");
  const profiles=BOT_TELLS.archetypes.filter(profile=>profile.kind===firmware&&profile.model===(model==="trundle"?"sidewalk-bot":model==="robotaxi"?"robotaxi":"errand-robot"));
  const profile=profiles[hash(id)%Math.max(1,profiles.length)];
  return {id,numericId:agent.id,model,firmware,...(profile?{archetype:profile.id,level:1+hash(`${id}:level`)%5}:{}),x:agent.x,y:agent.y,z:agent.z,heading:agent.heading,speed:Math.abs(agent.speed),
    radius:AGENT_SPEC[agent.kind].radius,height:model==="trundle"?.7:1.8,
    ...(model==="person"?{posture:"standing" as const,protected:personIsChild(agent.id),child:personIsChild(agent.id),mobilityAid:false}:{})};
}

export function createAgentsRuntime(state:Readonly<SimState>,options:AgentRuntimeOptions={}):AgentsRuntimeState{
  const actors:Record<string,RuntimeActor>={};
  for(const agent of [...agentsOf(state)].filter(a=>!isCivilianTraffic(a)).sort((a,b)=>a.id-b.id)) {const spawn=legacySpawn(agent,state.seed,options,state.version);actors[spawn.id]=initialize(spawn,state.tick,agent.id);}
  for(const spawn of [...(options.spawns??[])].sort((a,b)=>compare(a.id,b.id))){if(actors[spawn.id])throw new Error("Duplicate runtime actor ID");actors[spawn.id]=initialize(spawn,state.tick,null);}
  if(keys(actors).length>MAX_RUNTIME_ACTORS)throw new Error("Runtime actor budget exceeded");
  return {version:1,tick:state.tick,actors,missionBindings:{},baseBadCount:keys(actors).filter(id=>actors[id]!.firmware==="bad").length,lastCombatTick:-1,attacks:[],proposals:[],events:[]};
}

export function agentsRuntimeOf(state:Readonly<SimState>):AgentsRuntimeState|undefined{
  const value=state.ext.robots as unknown as AgentsRuntimeState|undefined;
  return value?.version===1&&value.actors?value:undefined;
}

function event(state:AgentsRuntimeState,kind:AgentRuntimeEvent["kind"],actorId:string,detail=""):void{
  state.events.push({id:`${state.tick}:${state.events.length}`,tick:state.tick,kind,actorId,detail});
}

/**
 * The runtime record for this tick. With `shared` false every actor is a fresh copy the planner
 * may mutate. With `shared` true (the post-movement observation, which changes few actors) an
 * actor is copied only when this tick changes it, and an unchanged one stays the previous
 * tick's object: structural sharing. Either way the result has equal contents.
 */
function synchronize(previous:AgentsRuntimeState,sim:Readonly<SimState>,options:AgentRuntimeOptions,shared=false):{state:AgentsRuntimeState;own:(id:string)=>RuntimeActor}{
  const state:AgentsRuntimeState={...previous,tick:sim.tick,actors:{},attacks:[],proposals:[],events:[]};
  const known=new Set<string>();
  const borrowed=new Set<string>();
  /** The actor, as an object this tick may change (a copy when it was shared). */
  const own=(id:string):RuntimeActor=>{
    if(borrowed.has(id)){borrowed.delete(id);state.actors[id]={...state.actors[id]!};}
    return state.actors[id]!;
  };
  const share=(id:string,actor:RuntimeActor):void=>{state.actors[id]=actor;borrowed.add(id);};
  const bound=new Set(Object.keys(previous.missionBindings).map(key=>previous.missionBindings[key]!));
  const embodied=new Set((sim.ext.agents?.list??[]).map(actor=>actor.runtimeId??agentActorId(actor.id)));
  for(const agent of [...agentsOf(sim)].filter(a=>!isCivilianTraffic(a)).sort((a,b)=>a.id-b.id)){
    const id=agentActorId(agent.id), old=previous.actors[id];known.add(id);
    if(shared&&old&&old.x===agent.x&&old.y===agent.y&&old.z===agent.z&&old.heading===agent.heading&&old.speed===Math.abs(agent.speed))share(id,old);
    else state.actors[id]=old?{...old,x:agent.x,y:agent.y,z:agent.z,heading:agent.heading,speed:Math.abs(agent.speed)}:initialize(legacySpawn(agent,sim.seed,options,sim.version),sim.tick,agent.id);
  }
  for(const spawn of [...(options.spawns??[])].sort((a,b)=>compare(a.id,b.id))){
    if(known.has(spawn.id))throw new Error("Duplicate runtime actor ID");known.add(spawn.id);
    const old=previous.actors[spawn.id];
    if(shared&&old)share(spawn.id,old);
    else state.actors[spawn.id]=old?{...old}:initialize(spawn,sim.tick,null);
  }
  for(const id of keys(previous.actors)){
    const old=previous.actors[id]!;
    if(old.legacyId!==null && isCivilianTraffic({id:old.legacyId,kind:old.model==="robotaxi"?"robotaxi":"person"})) continue;
    if(known.has(id)||old.retired&&!bound.has(id)&&!embodied.has(id))continue;
    // Ordinary traffic needs its original lane-route body. Once population
    // culling removes that body, retain no motionless virtual replacement.
    // Authored/service vehicles have legacyId=null and keep their own follower.
    if(old.legacyId!==null&&vehicle(old.model)&&!embodied.has(id)&&!bound.has(id))continue;
    if(old.significant||old.legacyId===null){
      // A significant ambient actor can return after its physical body was
      // culled. Its stable ID survives; it now needs normal physical admission.
      const legacyId=old.legacyId!==null&&!embodied.has(id)?null:old.legacyId,fidelity=old.legacyId===null?old.fidelity:"abstract";
      if(shared&&legacyId===old.legacyId&&fidelity===old.fidelity)share(id,old);
      else state.actors[id]={...old,...(old.legacyId!==null&&!embodied.has(id)?{legacyId:null}:{}),fidelity};
    }
  }
  for(const observed of options.observedBodies??[]){
    const actor=state.actors[observed.id];
    if(actor&&[observed.x,observed.y,observed.z,observed.heading,observed.speed??0].every(Number.isFinite)
      &&(actor.id!==observed.id||actor.x!==observed.x||actor.y!==observed.y||actor.z!==observed.z||actor.heading!==observed.heading||actor.speed!==Math.abs(observed.speed??0)))Object.assign(own(observed.id),observed,{speed:Math.abs(observed.speed??0)});
  }
  const ids=Object.keys(state.actors).sort(compare);
  if(ids.length>MAX_RUNTIME_ACTORS)throw new Error("Runtime actor budget exceeded");
  const numericIds=new Set<number>();
  for(const id of ids){
    let actor=state.actors[id]!;
    if(numericIds.has(actor.numericId))throw new Error("Duplicate numeric runtime actor ID");numericIds.add(actor.numericId);
    if(actor.pendingCursor!==null||actor.pendingPoint!==null){
      actor=own(id);
      if(actor.pendingCursor&&actor.pendingPoint&&distance(actor,actor.pendingPoint)<=BODY_EPSILON)actor.cursor={...actor.pendingCursor};
      actor.pendingCursor=null;actor.pendingPoint=null;
    }
    const effects=activeCombat(sim)?.targets[id];
    if(effects&&(effects.rust>0||effects.waryUntil>sim.tick||effects.phase!=="active")&&actor.significant!==true)own(id).significant=true;
  }
  const combat=activeCombat(sim);
  if(combat&&combat.tick>state.lastCombatTick){
    for(const received of combat.events){
      const actor=state.actors[received.targetId]?own(received.targetId):undefined;
      if(received.kind==="robot.inventory"){
        if(actor)actor.bag="empty";
        if(state.actors[received.sourceId])own(received.sourceId).bag="full";
      }
      if(!actor)continue;
      if(received.kind==="robot.converted"){
        actor.firmware="bad";actor.converted=true;actor.significant=true;
        actor.brain=createRobotBrain({id:actor.numericId,archetype:archetype(actor.model),tick:sim.tick});event(state,"actor.converted",actor.id);
      }
      if(received.kind==="robot.heap-cleared"){actor.retired=true;event(state,"actor.retired",actor.id,"heap-cleared");}
    }
    state.lastCombatTick=combat.tick;
  }
  if(state.baseBadCount===0)state.baseBadCount=ids.filter(id=>state.actors[id]!.firmware==="bad"&&!state.actors[id]!.converted).length;
  sortedActorIds.set(state.actors,ids);
  return {state,own};
}

function observationSet(world:World,sim:Readonly<SimState>,actor:RuntimeActor,others:RuntimeActor[],inputs:InputFrame,people:ReturnType<typeof players>,options:AgentRuntimeOptions,protectedActor:boolean):RobotObservations{
  const sight:RobotObservations["sight"][number][]=[],sounds:RobotObservations["sounds"][number][]=[],scans:RobotObservations["scans"][number][]=[],watches:RobotObservations["watches"][number][]=[];
  const protectedArea=options.protectedArea??defaultProtected;
  const encounters=sim.version>=17&&options.engagePlayers===true&&
    (actor.model==="footman"||actor.model==="patrol"||actor.model==="trundle"&&(options.wave??2)>=3);
  const mayEngage=encounters&&actor.protected!==true&&!protectedActor;
  for(const player of people){
    const near=distance(actor,player)<=40;
    if(!near)continue;
    const visible=!segmentBlocked(world,actor.x,actor.z,player.x,player.z);
    const targetable=mayEngage&&player.mode==="foot"&&!protectedArea(player.x,player.z);
    const input=inputs[player.id];
    if(distance(actor,player)<=30)sight.push({kind:"player",id:player.id,x:player.x,z:player.z,heading:player.heading,inVehicle:player.mode==="vehicle",lineOfSight:visible,threatening:(activeCombat(sim)?.events??[]).some(event=>event.sourceId===player.id&&event.kind==="weapon.water"),
      ...(encounters?{engage:targetable&&distance(actor,player)<=18,targetable}:{})});
    if(input&&(input.actions&Action.horn))sounds.push({kind:"horn",playerId:player.id,x:player.x,z:player.z});
    if(input&&(input.actions&Action.watch))watches.push({playerId:player.id,x:player.x,z:player.z,lineOfSight:visible});
  }
  for(const other of others){
    if(other.id===actor.id||other.retired||other.behavior==="pending-admission"||distance(actor,other)>30)continue;
    const visible=!segmentBlocked(world,actor.x,actor.z,other.x,other.z);
    if(human(other.model))sight.push({kind:"person",id:other.numericId,x:other.x,z:other.z,lineOfSight:visible});
    // Robots see robots of their own medium only: a robot on foot never takes a robotaxi, van or
    // bus for a mark to update or an ally to run to (it walked into the road and stood at the
    // taxi's nose while the taxi yielded to it, a standoff that held FiDi traffic for good).
    else if(!animal(other.model)&&vehicle(other.model)===vehicle(actor.model))sight.push({kind:"robot",id:other.numericId,x:other.x,z:other.z,lineOfSight:visible,alignment:other.firmware==="bad"?"bad":"good",operational:phase(sim,other.id)==="active"});
  }
  for(const received of activeCombat(sim)?.events??[]){
    const source=people.find(player=>player.id===received.sourceId);
    if(!source)continue;
    if(received.kind==="weapon.water")sounds.push({kind:"spray",playerId:source.id,x:source.x,z:source.z});
    if(received.targetId===actor.id&&(received.kind==="robot.wary"||received.kind==="robot.alert"))scans.push({playerId:source.id,x:source.x,z:source.z,targetRobotId:received.kind==="robot.alert"?actor.numericId:null});
  }
  const broadcasts:RobotObservations["broadcasts"][number][]=[];
  for(const received of activeCombat(sim)?.events??[]){
    if(received.kind!=="robot.broadcast")continue;
    const source=others.find(other=>other.id===received.sourceId);
    if(!source?.brain)continue;
    for(const known of source.brain.knowledge)broadcasts.push({sourceId:source.numericId,sourcePosition:{x:source.x,z:source.z},sourceSeized:phase(sim,source.id)==="seized",emittedTick:sim.tick,observedTick:known.observedTick,...(sim.version>=21?{expiresTick:known.expiresTick}:{}),playerId:known.playerId,position:{x:known.x,z:known.z}});
  }
  return {sight,sounds,scans,watches,broadcasts};
}

const NODE_CELL=25;
const nodeIndexes=new WeakMap<SidewalkGraph,Map<string,SidewalkGraph["nodes"][number][]>>();
function nodeIndex(graph:SidewalkGraph){
  let index=nodeIndexes.get(graph);
  if(!index){
    index=new Map();
    for(const node of graph.nodes){const key=`${Math.floor(node.x/NODE_CELL)},${Math.floor(node.z/NODE_CELL)}`;const bucket=index.get(key)??[];bucket.push(node);index.set(key,bucket);}
    nodeIndexes.set(graph,index);
  }
  return index;
}
function nearbyNodes(graph:SidewalkGraph,point:{x:number;z:number},radius:number){
  const result:SidewalkGraph["nodes"][number][]=[],index=nodeIndex(graph);
  for(let x=Math.floor((point.x-radius)/NODE_CELL);x<=Math.floor((point.x+radius)/NODE_CELL);x++)for(let z=Math.floor((point.z-radius)/NODE_CELL);z<=Math.floor((point.z+radius)/NODE_CELL);z++)for(const node of index.get(`${x},${z}`)??[])if(distance(node,point)<=radius)result.push(node);
  return result.sort((a,b)=>compare(a.id,b.id));
}

function desiredMovement(actor:RuntimeActor,intent:RobotBrainIntent|undefined,others:RuntimeActor[]):{goal:{x:number;z:number}|null;speed:number}{
  const movement=intent?.movement;
  if(movement?.kind==="hold")return {goal:null,speed:0};
  if(movement?.kind==="pursue"){
    const d=distance(actor,movement.destination);
    return {goal:d>movement.stopDistance?movement.destination:null,speed:d>movement.stopDistance?1.8:0};
  }
  if(movement?.kind==="flee"){
    if(movement.toward)return {goal:movement.toward,speed:1.8};
    if(movement.from)return {goal:{x:actor.x+(actor.x-movement.from.x),z:actor.z+(actor.z-movement.from.z)},speed:1.8};
  }
  if(actor.model==="dog"&&actor.ownerId){const owner=others.find(other=>other.id===actor.ownerId);if(owner&&distance(actor,owner)>1.5)return {goal:owner,speed:Math.min(2,distance(actor,owner)-1.5)};}
  return {goal:null,speed:actor.model==="trundle"?1:animal(actor.model)?1.3:1.6};
}

/** Every vehicle body (players' cars, robotaxis, vans, buses), as of the previous tick. */
function vehicleBoxes(sim:Readonly<SimState>):DetourBox[]{
  const out:DetourBox[]=[];
  for(const id of keys(sim.players)){const c=sim.players[id]!.car;out.push({x:c.x,z:c.z,heading:c.heading,hl:CAR.halfLength,hw:CAR.halfWidth});}
  for(const a of sim.ext.agents?.list??[])if(a.kind==="robotaxi")out.push({x:a.x,z:a.z,heading:a.heading,hl:a.halfLength??ROBOTAXI_BODY.halfLength,hw:a.halfWidth??ROBOTAXI_BODY.halfWidth});
  return out;
}

/** Bodies standing still that walkers go round (players' cars, robotaxis, vans, buses, a player on foot), as of the previous tick. */
function stoppedVehicles(sim:Readonly<SimState>):DetourBox[]{
  const out:DetourBox[]=[];
  for(const id of keys(sim.players)){
    const p=sim.players[id]!,c=p.car;
    if(Math.abs(c.speed)<.1)out.push({x:c.x,z:c.z,heading:c.heading,hl:CAR.halfLength,hw:CAR.halfWidth});
    // A player standing on the pavement: walkers step round them too.
    if(p.mode==="foot"&&p.foot&&Math.abs(p.foot.speed)<.1)out.push({x:p.foot.x,z:p.foot.z,heading:p.foot.heading,hl:.35,hw:.35});
  }
  for(const a of sim.ext.agents?.list??[])if(a.kind==="robotaxi"&&Math.abs(a.speed)<.1)out.push({x:a.x,z:a.z,heading:a.heading,hl:a.halfLength??ROBOTAXI_BODY.halfLength,hw:a.halfWidth??ROBOTAXI_BODY.halfWidth});
  return out;
}

/**
 * A walker whose route runs into a vehicle standing still walks round its nearer bumper to the
 * first point of the route clear beyond it (detour.ts), and carries on from there. Returns the
 * point to head for this tick, or null to follow the route as usual.
 */
function detourGoal(world:World,sim:Readonly<SimState>,graph:SidewalkGraph,actor:RuntimeActor,speed:number,stopped:readonly DetourBox[],isBlocked:(edge:SidewalkGraph["edges"][number])=>boolean):{x:number;z:number}|null{
  const r=actor.radius;
  const within=(reach:number)=>stopped.filter(b=>Math.abs(b.x-actor.x)<=reach+b.hl+b.hw&&Math.abs(b.z-actor.z)<=reach+b.hl+b.hw);
  // Nothing standing still within reach of the next DETOUR_LOOK_M of route and no detour under way:
  // the common case, no route walk.
  if(!actor.route||(!actor.detour&&!within(DETOUR_LOOK_M+r+.2).length)){actor.detour=null;return null;}
  const boxes=within(DETOUR_REJOIN_M+r+DETOUR_CLEAR_M+1);
  const walkable=(ax:number,az:number,bx:number,bz:number)=>!segmentBlocked(world,ax,az,bx,bz)&&!circleBlocked(world,bx,bz,r);
  const blocking=(tx:number,tz:number)=>{
    // The first stopped vehicle the straight line to (tx, tz) runs into.
    let best:DetourBox|null=null,bestD=Infinity;
    for(const b of boxes){
      const dx=tx-actor.x,dz=tz-actor.z,l=Math.sqrt(dx*dx+dz*dz),n=Math.max(1,Math.ceil(l/.1));
      for(let i=0;i<=n;i++){const px=actor.x+dx*i/n,pz=actor.z+dz*i/n;if(boxGap(px,pz,b)<r+DETOUR_CLEAR_M-.02){const d=l*i/n;if(d<bestD){bestD=d;best=b;}break;}}
    }
    return best;
  };
  if(actor.detour&&actor.detour.until>sim.tick){
    const target=actor.detour;
    if(distance(actor,target)<=Math.max(.25,speed*DT)){actor.cursor={...target.cursor};actor.detour=null;return {x:target.x,z:target.z};}
    const box=blocking(target.x,target.z);
    const way=box?detourWaypoint(actor,target,box,r,walkable):walkable(actor.x,actor.z,target.x,target.z)?target:null;
    if(!way){actor.detour=null;return null;}
    return way;
  }
  actor.detour=null;
  if(!boxes.length)return null;
  // Is the next stretch of route into a stopped vehicle's body?
  let box:DetourBox|null=null,from=0;
  for(let d=.5;d<=DETOUR_LOOK_M&&!box;d+=.5){
    const p=advanceSidewalkRoute(graph,actor.route,actor.cursor,d,edge=>isBlocked(edge));
    if(p.blockedEdgeId!==null)break;
    for(const b of boxes)if(boxGap(p.point.x,p.point.z,b)<r+.1){box=b;from=d;break;}
    if(p.finished)break;
  }
  if(!box)return null;
  // The first point of the route beyond it with room to stand clear of every stopped vehicle.
  for(let d=from+.5;d<=DETOUR_REJOIN_M;d+=.5){
    const p=advanceSidewalkRoute(graph,actor.route,actor.cursor,d,edge=>isBlocked(edge));
    if(p.blockedEdgeId!==null)return null;
    if(boxes.every(b=>boxGap(p.point.x,p.point.z,b)>=r+DETOUR_CLEAR_M+.1)&&!circleBlocked(world,p.point.x,p.point.z,r)){
      const way=detourWaypoint(actor,p.point,box,r,walkable);
      if(!way)return null;
      actor.detour={x:p.point.x,z:p.point.z,cursor:p.cursor,until:sim.tick+DETOUR_TICKS};
      return way;
    }
    if(p.finished)return null;
  }
  return null;
}

/** After a glance at someone standing near, a walker does not glance again for this many ticks (10 s). */
export const GLANCE_COOLDOWN_TICKS=600;

/** A walker that has not moved WALKER_STALL_M in this many ticks while wanting to walk picks a new way. */
export const WALKER_STALL_TICKS=240;
/** ...and must get this far from where it stalled to count as progress (jittering in place is not), metres. */
const WALKER_STALL_M=1;

/**
 * Would the physical layer (motion.ts applyMotionBodies) refuse this walker's step towards `goal`?
 * Its body would end inside a facade's clearance or cross one, or come nearer a vehicle's body it
 * is already within its radius + 0.1 m of.
 */
function stepRefused(world:World,actor:RuntimeActor,goal:{x:number;z:number},speed:number,vehicles:readonly DetourBox[]):boolean{
  const dx=goal.x-actor.x,dz=goal.z-actor.z,l=Math.sqrt(dx*dx+dz*dz);
  if(l<1e-9)return false;
  const step=Math.min(l,speed*DT),x=actor.x+dx/l*step,z=actor.z+dz/l*step;
  if(circleBlocked(world,x,z,actor.radius)||segmentBlocked(world,actor.x,actor.z,x,z))return true;
  return vehicles.some(v=>{const after=boxGap(x,z,v);return after<actor.radius+.15&&after<boxGap(actor.x,actor.z,v);});
}

/** Can a walker go straight from where it stands to (x, z): no facade on the way, never nearer a vehicle than its berth? */
function walkableTo(world:World,actor:RuntimeActor,x:number,z:number,vehicles:readonly DetourBox[]):boolean{
  const r=actor.radius,dx=x-actor.x,dz=z-actor.z,l=Math.sqrt(dx*dx+dz*dz);
  if(segmentBlocked(world,actor.x,actor.z,x,z))return false;
  if(l<1e-9)return true;
  // Finely over the first steps (a corner can clip the very next tick's step and not a longer one),
  // then every 0.2 m.
  const at:number[]=[];
  for(let d=.02;d<Math.min(l,.3);d+=.02)at.push(d);
  for(let d=.3;d<l;d+=.2)at.push(d);
  at.push(l);
  for(const d of at){
    const px=actor.x+dx/l*d,pz=actor.z+dz/l*d;
    if(circleBlocked(world,px,pz,r))return false;
    if(vehicles.some(v=>{const g=boxGap(px,pz,v);return g<r+.2&&g<boxGap(actor.x,actor.z,v);}))return false;
  }
  return true;
}

/** Wedged in a nook: the free spot 0.6 m away (one of 16 directions) that is nearest `toward`, or null. */
function stepOut(world:World,actor:RuntimeActor,vehicles:readonly DetourBox[],toward:{x:number;z:number}):{x:number;z:number;cursor:SidewalkCursor}|null{
  let best:{x:number;z:number}|null=null,score=Infinity;
  for(let i=0;i<16;i++){
    const a=i*PI/8,x=actor.x+dsin(a)*.6,z=actor.z-dcos(a)*.6;
    if(!walkableTo(world,actor,x,z,vehicles))continue;
    const d=distance({x,z},toward);
    if(d<score){score=d;best={x,z};}
  }
  return best?{...best,cursor:{...actor.cursor}}:null;
}

/** Sideways shifts tried off a sidewalk line that hugs a facade, metres (+ = right of the route). */
const FACADE_SHIFTS_M:readonly number[]=[0,.3,-.3,.6,-.6,1,-1,1.5,-1.5];

/**
 * Where a walker heads when its route line runs too close to a facade for its body: the first
 * point ahead on the route (0.5 to 8 m), or beside it (FACADE_SHIFTS_M, away from the wall), where
 * the body fits and that it can walk straight to, with the route cursor at that point.
 */
function clearAhead(world:World,graph:SidewalkGraph,actor:RuntimeActor,vehicles:readonly DetourBox[],isBlocked:(edge:SidewalkGraph["edges"][number])=>boolean):{x:number;z:number;cursor:SidewalkCursor}|null{
  const fits=(x:number,z:number)=>walkableTo(world,actor,x,z,vehicles);
  for(let d=.5;d<=8;d+=.5){
    const p=advanceSidewalkRoute(graph,actor.route!,actor.cursor,d,edge=>isBlocked(edge));
    if(p.blockedEdgeId!==null)return null;
    const q=advanceSidewalkRoute(graph,actor.route!,actor.cursor,d+.25,edge=>isBlocked(edge)).point;
    const tx=q.x-p.point.x,tz=q.z-p.point.z,tl=Math.sqrt(tx*tx+tz*tz);
    // Right of the route there (none where the route has no direction: only the line itself).
    const rx=tl>1e-6?-tz/tl:0,rz=tl>1e-6?tx/tl:0;
    for(const shift of tl>1e-6?FACADE_SHIFTS_M:[0]){
      const x=p.point.x+rx*shift,z=p.point.z+rz*shift;
      if(fits(x,z))return {x,z,cursor:p.cursor};
    }
    if(p.finished)return null;
  }
  return null;
}

function motionMetadata(actor:RuntimeActor):Pick<AgentMotionProposal,"bodyKind"|"protected"|"child"|"mobilityAid"|"posture">{
  return {bodyKind:animal(actor.model)?"animal":human(actor.model)?"person":"robot",...(actor.protected!==undefined?{protected:actor.protected}:{}),...(actor.child!==undefined?{child:actor.child}:{}),...(actor.mobilityAid!==undefined?{mobilityAid:actor.mobilityAid}:{}),...(actor.posture?{posture:actor.posture}:{})};
}
/** One motion proposal, built field by field (the same record the spread literals used to make). */
function proposalOf(actor:RuntimeActor,legacyId:number|null,kind:AgentMotionProposal["kind"],x:number,y:number,z:number,heading:number,speed:number,controls?:Readonly<SimInput>):AgentMotionProposal{
  const out:AgentMotionProposal={id:actor.id,numericId:actor.numericId,legacyId,kind,x,y,z,heading,speed,radius:actor.radius,height:actor.height,sourceX:actor.x,sourceY:actor.y,sourceZ:actor.z};
  if(controls)out.controls=controls;
  out.bodyKind=animal(actor.model)?"animal":human(actor.model)?"person":"robot";
  if(actor.protected!==undefined)out.protected=actor.protected;
  if(actor.child!==undefined)out.child=actor.child;
  if(actor.mobilityAid!==undefined)out.mobilityAid=actor.mobilityAid;
  if(actor.posture)out.posture=actor.posture;
  if(actor.halfLength)out.halfLength=actor.halfLength;
  if(actor.halfWidth)out.halfWidth=actor.halfWidth;
  return out;
}
function propose(world:World,state:AgentsRuntimeState,actor:RuntimeActor,graph:SidewalkGraph|undefined,intent:RobotBrainIntent|undefined,options:AgentRuntimeOptions,sim:Readonly<SimState>,inputs:InputFrame,others:RuntimeActor[],people:ReturnType<typeof players>,stopped:readonly DetourBox[],vehicles:readonly DetourBox[]):void{
  if(vehicle(actor.model)){
    // Legacy traffic keeps its route mover. New service/mission bodies await shared steering.
    const controls=options.vehicleControls?.[actor.id];
    if(actor.legacyId===null||controls)state.proposals.push(proposalOf(actor,null,"vehicle",actor.x,actor.y,actor.z,actor.heading,0,controls));
    return;
  }
  const wanted=desiredMovement(actor,intent,others);
  const effect=activeCombat(sim)?.targets[actor.id];
  const updating=(activeCombat(sim)?.attacks??[]).some(attack=>attack.kind==="forced-update"&&attack.targetId===actor.id);
  const frozen=Boolean(effect&&effect.phase!=="active"||updating);
  let speed=frozen?0:wanted.speed*(effect?.movementScale??1);
  let goal=wanted.goal,direct=false;
  const lure=runtimeDeviceLure(sim,actor,intent);if(lure){goal=lure.goal;speed=frozen?0:lure.speed;direct=distance(actor,lure)<lure.stopRadius;}
  // Bad firmware has no splash seal: in the rain an idle bad robot heads for shelter (a tell),
  // and on a King-tide day it keeps off the flooded waterfront. Chases and flight still win, and
  // authored mission and scene bodies (significant) keep their scripts.
  if(actor.firmware==="bad"&&!actor.significant&&!wanted.goal&&!lure&&intent?.movement?.kind!=="hold"&&options.weatherRefuge){
    const refuge=options.weatherRefuge(actor.x,actor.z);
    if(refuge){const d=distance(actor,refuge);goal=d>.4?refuge:null;speed=d>.4?Math.min(speed,1.6):0;direct=d<10;}
  }
  if(effect?.repair&&actor.firmware==="good"){
    const kiosks=(world.gameplay?.anchors??[]).filter(anchor=>anchor.kind==="repair-kiosk").sort((a,b)=>distance(actor,a)-distance(actor,b)||compare(a.id,b.id));
    const kiosk=kiosks[0];if(kiosk){goal=distance(actor,kiosk)>2?kiosk:null;speed=goal?Math.min(speed,.9):0;}
  }
  if(actor.model==="person"||animal(actor.model)||actor.firmware==="good"){
    const stimuli:PerceivedStimulus[]=people.flatMap(player=>{
      // No reaction observes beyond 40 m. Reject distant players before the
      // building-footprint visibility query, which dominates citywide costs.
      const dx=actor.x-player.x,dz=actor.z-player.z;
      if(dx*dx+dz*dz>1600)return [];
      const input=inputs[player.id],seen=!segmentBlocked(world,actor.x,actor.z,player.x,player.z);
      const observed:PerceivedStimulus[]=[];
      // A glance is at someone standing near; a driver sitting in a stopped car is not one (people walk round it).
      // A glance is brief and does not repeat for GLANCE_COOLDOWN_TICKS: people look at someone
      // standing near, then carry on, instead of freezing round them.
      if(player.mode==="foot"&&distance(actor,player)<=4&&!(actor.glanced!==undefined&&sim.tick-actor.glanced<GLANCE_COOLDOWN_TICKS))observed.push({sourceId:player.id,kind:"nearby",x:player.x,z:player.z,seen,heard:false});
      if(input&&(input.actions&Action.horn))observed.push({sourceId:player.id,kind:"horn",x:player.x,z:player.z,seen,heard:true});
      // People and animals step back from a moving car; robots do not (a car bowls them over: impacts.ts).
      if(player.mode==="vehicle"&&actor.firmware!=="good")observed.push({sourceId:player.id,kind:"vehicle",x:player.x,z:player.z,seen,heard:false,speedMps:Math.abs(player.speed)});
      for(const emitted of activeCombat(sim)?.events??[])if(emitted.sourceId===player.id){
        if(emitted.kind==="weapon.water")observed.push({sourceId:player.id,kind:"spray",x:player.x,z:player.z,seen,heard:true});
        if(emitted.kind==="robot.glance"&&emitted.targetId===actor.id)observed.push({sourceId:player.id,kind:"ping",x:player.x,z:player.z,seen,heard:true});
      }
      return observed;
    });
    const owner=actor.ownerId?others.find(other=>other.id===actor.ownerId):undefined;
    // A detached or displaced dog holds until the body owner restores its pair safely.
    if(actor.model==="dog"&&(!owner||distance(actor,owner)>4)){speed=0;goal=null;}
    else {
    const reaction=reactToPerception({actor:{id:actor.id,kind:actor.model==="pigeon"?"pigeon":actor.model==="dog"?"dog":actor.firmware==="good"?"good-robot":"person",x:actor.x,z:actor.z,wet:(effect?.wetUntil??0)>sim.tick,...(actor.rustScale!==undefined?{rustScale:actor.rustScale}:{}),...(actor.level!==undefined?{subtlety:actor.level}:{}),...(actor.child?{child:true}:{}),...(actor.posture?{posture:actor.posture}:{}),...(actor.mobilityAid?{mobilityAid:true}:{}),...(actor.model==="dog"&&actor.ownerId&&others.find(other=>other.id===actor.ownerId)?{leash:{ownerId:actor.ownerId,ownerX:others.find(other=>other.id===actor.ownerId)!.x,ownerZ:others.find(other=>other.id===actor.ownerId)!.z,lengthM:4}}:{})},state:actor.reaction,stimuli,tick:sim.tick,dodgeOverrideActive:false,routineVelocity:{vx:dsin(actor.heading)*speed,vz:-dcos(actor.heading)*speed}});
    if(reaction.state.mode==="glance"&&actor.reaction.mode!=="glance")actor.glanced=sim.tick;
    actor.reaction=reaction.state;
    if(reaction.movement.kind==="hold")speed=0;
    else if(reaction.movement.reason==="reaction"||reaction.movement.reason==="leash"){goal={x:actor.x+reaction.movement.vx,z:actor.z+reaction.movement.vz};speed=Math.sqrt(reaction.movement.vx*reaction.movement.vx+reaction.movement.vz*reaction.movement.vz);}
    }
  }
  if(sim.version>=21 && actor.firmware!=="none" && actor.model!=="person" && actor.model!=="walker" && !animal(actor.model)) {
    speed *= Number.isFinite(options.speedMultiplier) ? clamp(options.speedMultiplier!, .5, 1) : 1;
  }
  if(speed<=0||frozen||actor.posted){delete actor.stall;state.proposals.push(proposalOf(actor,actor.legacyId,actor.model==="drone"?"flying":"walker",actor.x,actor.y,actor.z,actor.heading,0));return;}
  // (The last few metres to a shelter leave the sidewalk line for the wall or the stop itself.)
  if(graph?.nodes.length&&actor.model!=="drone"&&actor.reaction.mode!=="avoid"&&!direct){
    // A walker that has wanted to walk for WALKER_STALL_TICKS without getting anywhere picks a
    // new way (a corner it cannot get round, a crossing that never clears): it never stands frozen.
    let stalled=false;
    if(!actor.stall||distance(actor,actor.stall)>WALKER_STALL_M)actor.stall={x:actor.x,z:actor.z,tick:sim.tick};
    else if(sim.tick-actor.stall.tick>=WALKER_STALL_TICKS){stalled=true;actor.route=null;actor.detour=null;actor.stall={x:actor.x,z:actor.z,tick:sim.tick};}
    const node=goal&&!stalled?nearestSidewalkNode(graph,goal):actor.goalNode;
    if(!actor.route||actor.goalNode!==node||actor.cursor.stepIndex>=actor.route.steps.length){
      const start=nearestSidewalkNode(graph,actor);
      const candidates=goal?[node]:nearbyNodes(graph,actor,60).filter(n=>n.id!==start).map(n=>n.id);
      if(candidates.length){
        const end=candidates[hash(`${actor.id}:${stalled?sim.tick:sim.tick>>9}`)%candidates.length]!;
        const route=shortestSidewalkRoute(graph,start,end);
        actor.route=route;actor.cursor={stepIndex:0,distanceM:0};actor.goalNode=end;actor.detour=null;
      }
    }
    if(actor.route&&actor.route.steps.length){
      const around=detourGoal(world,sim,graph,actor,speed,stopped,edge=>Boolean(options.crossingBlocked?.(edge.id)));
      if(around){goal=around;actor.pendingCursor=null;}
      else{
        const next=advanceSidewalkRoute(graph,actor.route,actor.cursor,speed*DT,edge=>Boolean(options.crossingBlocked?.(edge.id)));
        goal=next.point;actor.pendingCursor=next.cursor;
        // A sidewalk line that runs too close to a facade for this body: walk straight to the first
        // point of the route ahead with room for it (as a detour, so the route carries on from there).
        // A step the physical layer would refuse (into a facade, or nearer a vehicle it is already
        // pressed against): walk to the first clear point of the route ahead instead, or, wedged in a
        // nook, step out to the nearest free spot towards it. Either way, never stand frozen.
        const near=vehicles.filter(v=>Math.abs(v.x-actor.x)<8&&Math.abs(v.z-actor.z)<8);
        if(stepRefused(world,actor,goal,speed,near)){
          const ahead=clearAhead(world,graph,actor,near,edge=>Boolean(options.crossingBlocked?.(edge.id)))??stepOut(world,actor,near,advanceSidewalkRoute(graph,actor.route,actor.cursor,2,edge=>Boolean(options.crossingBlocked?.(edge.id))).point);
          if(ahead){goal={x:ahead.x,z:ahead.z};actor.pendingCursor=null;actor.detour={...ahead,until:sim.tick+DETOUR_TICKS};}
        }
      }
    }
  }
  const straightOn=!goal;
  if(!goal)goal={x:actor.x+dsin(actor.heading),z:actor.z-dcos(actor.heading)};
  // A bad robot's brain chasing or fleeing straight at something, or a walker with no route walking
  // straight on (route walking has its own recovery above): a step the physical layer would refuse becomes a step out to the nearest free
  // spot towards where it wants to go, instead of pressing against a vehicle for good.
  if(actor.model!=="drone"&&!direct){
    const near=vehicles.filter(v=>Math.abs(v.x-actor.x)<8&&Math.abs(v.z-actor.z)<8);
    const brain=intent?.movement?.kind==="pursue"||intent?.movement?.kind==="flee";
    // Walking straight on, only a vehicle's refusal counts (a wall it stands at is where it waits).
    if((brain&&stepRefused(world,actor,goal,speed,near))||(straightOn&&!brain&&stepRefused(world,actor,goal,speed,near)&&!stepRefused(world,actor,goal,speed,[]))){const out=stepOut(world,actor,near,goal);if(out){goal={x:out.x,z:out.z};actor.pendingCursor=null;}}
  }
  const length=distance(actor,goal),travel=Math.min(length,speed*DT);
  const dx=length>1e-8?(goal.x-actor.x)/length:0,dz=length>1e-8?(goal.z-actor.z)/length:0;
  const x=actor.x+dx*travel,z=actor.z+dz*travel;
  const clear=!segmentBlocked(world,actor.x,actor.z,x,z)&&(!lure||lureStepAllowed(lure,actor,{x,z}));
  const y=actor.model==="drone"?actor.y+clamp(groundHeight(world,x,z)+6-actor.y,-2*DT,2*DT):groundHeight(world,x,z);
  const actualX=clear?x:actor.x,actualZ=clear?z:actor.z;
  actor.pendingPoint={x:actualX,z:actualZ};
  state.proposals.push(proposalOf(actor,actor.legacyId,actor.model==="drone"?"flying":"walker",actualX,clear?y:actor.y,actualZ,length>1e-8?datan2(dx,-dz):actor.heading,clear?speed:0));
}

function contentGoalWeights(actor:RuntimeActor,wave:number,encounters=false):Partial<Record<RobotGoal,number>>|undefined{
  if(!actor.archetype||!ROBOT_GOALS.archetypes[actor.archetype])return undefined;
  const weights:Partial<Record<RobotGoal,number>>={shove:0,grocerySnatch:0,adBlast:0,phoneHack:0,handshake:0,forcedUpdate:0};
  const sabotage:Record<string,RobotGoal>={snatchGroceries:"grocerySnatch",pushUpdate:"forcedUpdate",stickAd:"adBlast",harvestData:"phoneHack"};
  for(const goal of goalsInWave(actor.archetype,actor.brain?.mode??"disguised",wave)){
    const kind=goal.attack&&goal.attack in weights?goal.attack as RobotGoal:goal.sabotage?sabotage[goal.sabotage]:undefined;
    if(kind)weights[kind]=Math.max(weights[kind]??0,goal.weight);
  }
  // The fake-courier profile only has robot sabotage goals. Once an encounter is
  // hostile, a wave-3 Trundle can use its existing phone-hack instead of silently
  // following an on-foot player with no legal player-facing action.
  if(encounters&&wave>=3&&actor.model==="trundle"&&(actor.brain?.mode==="alerted"||actor.brain?.mode==="attack")&&(weights.phoneHack??0)<=0)weights.phoneHack=1;
  return weights;
}

function queueAttack(state:AgentsRuntimeState,actor:RuntimeActor,intent:RobotBrainIntent,sim:Readonly<SimState>,options:AgentRuntimeOptions):void{
  const action=intent.action;
  let kind:AttackKind|undefined,target:BrainTarget|undefined,token="";
  if(action.kind==="windup"){kind=attackKinds[action.attack];target=action.target;token=`${actor.brain?.windup?.startedTick}:${kind}:${target.kind}:${target.id}`;}
  else if(action.kind==="update"&&action.phase==="start"){kind="forced-update";target={kind:"robot",id:action.targetId};token=`${sim.tick}:update:${target.id}`;}
  if(!kind||!target||token===actor.actionToken||kind==="phone-hack"&&(options.wave??2)<3)return;
  const targetActor=target.kind==="robot"?keys(state.actors).map(id=>state.actors[id]!).find(other=>other.numericId===target!.id):undefined;
  if(target.kind==="robot"&&!targetActor)return;
  actor.actionToken=token;actor.attackSequence++;
  state.attacks.push({id:`${actor.id}:${actor.attackSequence}`,sequence:actor.attackSequence,attackerId:actor.id,targetId:target.kind==="player"?String(target.id):targetActor!.id,kind});
}

const graphCache=new WeakMap<World,SidewalkGraph>();
export function fallbackGraph(world:World):SidewalkGraph|undefined{
  if(!world.roads)return undefined;
  let graph=graphCache.get(world);
  if(!graph){graph=buildFallbackSidewalkGraph(world.roads);graphCache.set(world,graph);}
  return graph;
}

/** Pure pre-movement planner. Core applies proposals once and owns final clearance. */
export function planAgentRuntime(world:World,sim:Readonly<SimState>,inputs:InputFrame,options:AgentRuntimeOptions={}):AgentsRuntimeState{
  const previous=agentsRuntimeOf(sim)??createAgentsRuntime(sim,options);
  const {state}=synchronize(previous,sim,options);
  const people=players(sim);
  const anchors=options.anchors??people.map(player=>({id:player.id,x:player.x,z:player.z}));
  const graph=options.graph??fallbackGraph(world);
  const list=keys(state.actors).map(id=>state.actors[id]!);
  const presentLegacy=new Set(agentsOf(sim).map(actor=>actor.id));
  const physical=new Set((sim.ext.agents?.list??[]).map(actor=>actor.runtimeId));
  const controlled=new Set(options.controlledActorIds??[]);
  const badCount=list.filter(actor=>actor.firmware==="bad"&&!actor.retired&&phase(sim,actor.id)==="active").length;
  const naturalBad=naturalBadCount(sim,state);
  const stopped=stoppedVehicles(sim);
  const vehicles=vehicleBoxes(sim);
  if(options.densityAt){const density:Record<string,Record<string,number>>={};for(const player of people)density[player.id]=options.densityAt(player.x,player.z);state.density=density;}
  for(const actor of list){
    if(actor.retired)continue;
    if(controlled.has(actor.id)){actor.intent=null;actor.behavior="controlled";continue;}
    if(actor.legacyId!==null&&!presentLegacy.has(actor.legacyId)){actor.fidelity="abstract";continue;}
    const fidelity=planFidelity(actor,anchors,activeWorldTick(sim));actor.fidelity=fidelity.tier;
    if(fidelity.tier==="despawn"){
      actor.retired=true;actor.intent=null;
      event(state,"actor.retired",actor.id,"outside-fidelity");
      continue;
    }
    if(!fidelity.allowCombat)continue;
    if(actor.behavior==="pending-admission"&&actor.legacyId===null&&actor.model!=="drone"&&!physical.has(actor.id)){
      // Retry only the stationary source pose. An unadmitted actor has no perception,
      // navigation or attack progress until core has actually placed its physical body.
      actor.fidelity="abstract";actor.intent=null;
      state.proposals.push({id:actor.id,numericId:actor.numericId,legacyId:null,...motionMetadata(actor),
        kind:vehicle(actor.model)?"vehicle":"walker",x:actor.x,y:actor.y,z:actor.z,heading:actor.heading,speed:0,
        radius:actor.radius,height:actor.height,...(actor.halfLength?{halfLength:actor.halfLength}:{}),
        ...(actor.halfWidth?{halfWidth:actor.halfWidth}:{}),sourceX:actor.x,sourceY:actor.y,sourceZ:actor.z});
      continue;
    }
    let intent:RobotBrainIntent|undefined=actor.intent??undefined;
    if(actor.firmware==="bad"&&!vehicle(actor.model)&&phase(sim,actor.id)==="active"&&(fidelity.run||actor.brain?.windup||actor.brain?.update)){
      actor.brain??=createRobotBrain({id:actor.numericId,archetype:archetype(actor.model),tick:sim.tick});
      if(actor.brain.lastTick>=sim.tick)continue;
      const own=activeCombat(sim)?.targets[actor.id];
      // From wave 4, a staged mission body keeps its script in fog (as it ignores weather refuges):
      // fog breaks off ambient pursuit, not an authored scene the founder walked into.
      const scripted=(options.wave??2)>=4&&actor.significant&&actor.id.startsWith("mission:");
      // The protection predicate is unchanged between sensing and conversion. Its
      // default geographic query allocates projected polygons, so evaluate it once.
      const protectedActor=(options.protectedArea??defaultProtected)(actor.x,actor.z);
      const step=stepRobotBrain(actor.brain,{tick:sim.tick,self:{x:actor.x,z:actor.z,heading:actor.heading,rust:own?.rust??0,fogDensity:scripted?0:clamp(options.fogAt?.(actor.x,actor.z)??options.fog??0,0,1),shoved:(own?.stoppedUntil??0)>sim.tick},
        observations:observationSet(world,sim,actor,list,inputs,people,options,protectedActor),conversion:{withinFidelity:fidelity.allowConversion,protectedArea:protectedActor,baseBadCount:naturalBad,badCount},
        acknowledgedUpdates:(activeCombat(sim)?.events??[]).filter(event=>event.kind==="robot.converted"&&event.sourceId===actor.id).flatMap(event=>state.actors[event.targetId]?[{targetId:state.actors[event.targetId]!.numericId,completedTick:event.tick}]:[]),
        goalWeights:{...contentGoalWeights(actor,options.wave??2,sim.version>=17&&options.engagePlayers===true),...(options.conversionCap!==undefined&&badCount>=options.conversionCap?{forcedUpdate:0}:{})}});
      actor.brain=step.state;intent=step.intent;actor.intent=intent;actor.behavior=step.state.mode;actor.hiddenTellId=step.intent.hideOneTell?actor.tellIds[0]??null:null;queueAttack(state,actor,intent,sim,options);
    }
    propose(world,state,actor,graph,intent,options,sim,inputs,list,people,stopped,vehicles);
  }
  return state;
}

/** Shared combat snapshots use the core's observed positions, never unaccepted proposals. */
/**
 * The conversion budget's base: bad robots active now that were not converted. Converted
 * robots may at most match it (brain canConvert, combat conversionCap). The start-of-run
 * baseBadCount goes stale as the city admits more robots, which froze every forced update.
 */
export function naturalBadCount(sim:Readonly<SimState>,runtime:Readonly<AgentsRuntimeState>|undefined=agentsRuntimeOf(sim)):number{
  if(!runtime)return 0;
  return keys(runtime.actors).filter(id=>{const actor=runtime.actors[id]!;return actor.firmware==="bad"&&!actor.converted&&!actor.retired&&phase(sim,id)==="active";}).length;
}

export function runtimeCombatActors(sim:Readonly<SimState>):CombatActor[]{
  const state=agentsRuntimeOf(sim);if(!state)return [];
  const out:CombatActor[]=[];
  for(const id of keys(state.actors)){
    const actor=state.actors[id]!;
    if(actor.retired||actor.fidelity==="abstract"||actor.fidelity==="despawn")continue;
    const model=actor.model,isAnimal=animal(model),isHuman=human(model);
    // Field by field: the same record the old spread literal built.
    const body:Record<string,unknown>={id:actor.id,kind:isAnimal?"animal":isHuman?"person":"robot",x:actor.x,y:actor.y,z:actor.z,heading:actor.heading,speed:actor.speed,radius:actor.radius,height:actor.height,firmware:actor.firmware};
    if(model!=="person"&&model!=="associate")body.model=model==="pigeon"||model==="dog"||model==="van"||model==="bus"?"footman":model;
    body.protected=model==="van"||model==="bus"?true:actor.protected??(isAnimal||(isHuman&&(Boolean(actor.child)||Boolean(actor.mobilityAid)||(actor.posture??"standing")!=="standing")));
    if(actor.rustScale!==undefined)body.rustScale=actor.rustScale;
    if(actor.level!==undefined)body.subtlety=actor.level;
    if(actor.child)body.child=true;
    if(actor.posture)body.posture=actor.posture;
    if(actor.mobilityAid)body.mobilityAid=true;
    if(vehicle(model))body.obeysTraffic=true;
    body.pursuing=actor.behavior==="attack";body.inFidelity=true;
    out.push(body as unknown as CombatActor);
  }
  return out;
}

/** Refresh accepted body poses after core movement without running decisions twice. */
export function observeAgentRuntime(sim:Readonly<SimState>,options:AgentRuntimeOptions={}):AgentsRuntimeState{
  const previous=agentsRuntimeOf(sim)??createAgentsRuntime(sim,options);
  const {state:observed,own}=synchronize(previous,sim,options,true);
  let attacks=previous.attacks;
  if(options.observedBodies!==undefined){
    // Core may defer a blocked spawn. Keep its durable staging record, but do not publish
    // a ghost body to combat, mission watching or rendering while physical admission waits.
    // Drones deliberately use the flying path and have no ground collision proxy.
    const physical=new Set((sim.ext.agents?.list??[]).map(actor=>actor.runtimeId));
    const waiting=new Set<string>();
    const anchors=options.anchors??players(sim).map(player=>({id:player.id,x:player.x,z:player.z}));
    for(const id of keys(observed.actors)){
      const actor=observed.actors[id]!;
      if(actor.retired||actor.legacyId!==null||actor.model==="drone")continue;
      if(!physical.has(id)){
        waiting.add(id);
        if(actor.fidelity!=="abstract"||actor.behavior!=="pending-admission"||actor.speed!==0||actor.intent!==null){const body=own(id);body.fidelity="abstract";body.behavior="pending-admission";body.speed=0;body.intent=null;}
      }else if(actor.behavior==="pending-admission"){
        const body=own(id);body.fidelity=planFidelity(body,anchors,activeWorldTick(sim)).tier;body.behavior="idle";
      }
    }
    if(waiting.size)attacks=attacks.filter(attack=>!waiting.has(attack.attackerId)&&!waiting.has(attack.targetId));
  }
  return {...observed,attacks,proposals:previous.proposals,events:[...previous.events,...observed.events]};
}

export function runtimeAttackRequests(sim:Readonly<SimState>):readonly AttackRequest[]{return agentsRuntimeOf(sim)?.attacks??[];}
