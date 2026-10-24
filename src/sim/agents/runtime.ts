import { BOT_TELLS, botAtLevel } from "../../content/botTells.ts";
import { ROBOT_GOALS, goalsInWave } from "../../content/robotGoals.ts";
import { badRobotRate, protectedAreaAt } from "../../content/places.ts";
import { toLatLon } from "../../geo/project.ts";
import { Action, type InputFrame, type SimInput, type SimState } from "../contract.ts";
import { AGENT_SPEC, agentsOf, personIsChild, type AgentState } from "../agents.ts";
import { dcos, dsin, datan2, clamp } from "../dmath.ts";
import type { AgentMotionProposal as CoreAgentMotionProposal } from "../motion.ts";
import { groundHeight, segmentBlocked, type World } from "../world.ts";
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
}

export interface AgentRuntimeOptions {
  graph?: SidewalkGraph;
  services?: boolean;
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
  crossingBlocked?: (edgeId:string)=>boolean;
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
function bodyOf(player:SimState["players"][string]){return player.mode==="foot"&&player.foot?player.foot:player.car;}
function players(state:Readonly<SimState>){return keys(state.players).map(id=>({id,mode:state.players[id]!.mode,...bodyOf(state.players[id]!)}));}
function hash(value:string):number{let out=2166136261;for(let i=0;i<value.length;i++)out=Math.imul(out^value.charCodeAt(i),16777619);return out>>>0;}
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

function legacySpawn(agent:AgentState,seed:number,options:AgentRuntimeOptions):RuntimeSpawn{
  const id=`agent:${agent.id}`, model=agent.kind==="errandRobot"?"footman":agent.kind==="sidewalkBot"?"trundle":agent.kind;
  const firmware=options.firmware?.[id]??(model==="person"?"none":hash(`${seed}:${id}`)/4294967296<clamp((options.badRateAt??defaultBadRate)(agent.x,agent.z),0,1)?"bad":"good");
  const profiles=BOT_TELLS.archetypes.filter(profile=>profile.kind===firmware&&profile.model===(model==="trundle"?"sidewalk-bot":model==="robotaxi"?"robotaxi":"errand-robot"));
  const profile=profiles[hash(id)%Math.max(1,profiles.length)];
  return {id,numericId:agent.id,model,firmware,...(profile?{archetype:profile.id,level:1+hash(`${id}:level`)%5}:{}),x:agent.x,y:agent.y,z:agent.z,heading:agent.heading,speed:agent.speed,
    radius:AGENT_SPEC[agent.kind].radius,height:model==="trundle"?.7:1.8,
    ...(model==="person"?{posture:"standing" as const,protected:personIsChild(agent.id),child:personIsChild(agent.id),mobilityAid:false}:{})};
}

export function createAgentsRuntime(state:Readonly<SimState>,options:AgentRuntimeOptions={}):AgentsRuntimeState{
  const actors:Record<string,RuntimeActor>={};
  for(const agent of [...agentsOf(state)].sort((a,b)=>a.id-b.id)) {const spawn=legacySpawn(agent,state.seed,options);actors[spawn.id]=initialize(spawn,state.tick,agent.id);}
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

function synchronize(previous:AgentsRuntimeState,sim:Readonly<SimState>,options:AgentRuntimeOptions):AgentsRuntimeState{
  const state:AgentsRuntimeState={...previous,tick:sim.tick,actors:{},attacks:[],proposals:[],events:[]};
  const known=new Set<string>();
  const bound=new Set(Object.keys(previous.missionBindings).map(key=>previous.missionBindings[key]!));
  const embodied=new Set((sim.ext.agents?.list??[]).map(actor=>actor.runtimeId??`agent:${actor.id}`));
  for(const agent of [...agentsOf(sim)].sort((a,b)=>a.id-b.id)){
    const id=`agent:${agent.id}`, old=previous.actors[id];known.add(id);
    state.actors[id]=old?{...old,x:agent.x,y:agent.y,z:agent.z,heading:agent.heading,speed:agent.speed}:initialize(legacySpawn(agent,sim.seed,options),sim.tick,agent.id);
  }
  for(const spawn of [...(options.spawns??[])].sort((a,b)=>compare(a.id,b.id))){
    if(known.has(spawn.id))throw new Error("Duplicate runtime actor ID");known.add(spawn.id);
    state.actors[spawn.id]=previous.actors[spawn.id]?{...previous.actors[spawn.id]!}:initialize(spawn,sim.tick,null);
  }
  for(const id of keys(previous.actors)){
    const old=previous.actors[id]!;
    if(known.has(id)||old.retired&&!bound.has(id)&&!embodied.has(id))continue;
    // Ordinary traffic needs its original lane-route body. Once population
    // culling removes that body, retain no motionless virtual replacement.
    // Authored/service vehicles have legacyId=null and keep their own follower.
    if(old.legacyId!==null&&vehicle(old.model)&&!embodied.has(id)&&!bound.has(id))continue;
    if(old.significant||old.legacyId===null)state.actors[id]={...old,
      // A significant ambient actor can return after its physical body was
      // culled. Its stable ID survives; it now needs normal physical admission.
      ...(old.legacyId!==null&&!embodied.has(id)?{legacyId:null}:{}),
      fidelity:old.legacyId===null?old.fidelity:"abstract"};
  }
  for(const observed of options.observedBodies??[]){const actor=state.actors[observed.id];if(actor&&[observed.x,observed.y,observed.z,observed.heading,observed.speed??0].every(Number.isFinite))Object.assign(actor,observed);}
  const ids=Object.keys(state.actors).sort(compare);
  if(ids.length>MAX_RUNTIME_ACTORS)throw new Error("Runtime actor budget exceeded");
  const numericIds=new Set<number>();
  for(const id of ids){
    const actor=state.actors[id]!;
    if(numericIds.has(actor.numericId))throw new Error("Duplicate numeric runtime actor ID");numericIds.add(actor.numericId);
    if(actor.pendingCursor&&actor.pendingPoint&&distance(actor,actor.pendingPoint)<=BODY_EPSILON)actor.cursor={...actor.pendingCursor};
    actor.pendingCursor=null;actor.pendingPoint=null;
    const effects=activeCombat(sim)?.targets[id];
    if(effects&&(effects.rust>0||effects.waryUntil>sim.tick||effects.phase!=="active"))actor.significant=true;
  }
  const combat=activeCombat(sim);
  if(combat&&combat.tick>state.lastCombatTick){
    for(const received of combat.events){
      const actor=state.actors[received.targetId];
      if(received.kind==="robot.inventory"){
        if(actor)actor.bag="empty";
        const source=state.actors[received.sourceId];if(source)source.bag="full";
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
  return state;
}

function observationSet(world:World,sim:Readonly<SimState>,actor:RuntimeActor,others:RuntimeActor[],inputs:InputFrame,people:ReturnType<typeof players>):RobotObservations{
  const sight:RobotObservations["sight"][number][]=[],sounds:RobotObservations["sounds"][number][]=[],scans:RobotObservations["scans"][number][]=[],watches:RobotObservations["watches"][number][]=[];
  for(const player of people){
    const near=distance(actor,player)<=40;
    if(!near)continue;
    const visible=!segmentBlocked(world,actor.x,actor.z,player.x,player.z);
    const input=inputs[player.id];
    if(distance(actor,player)<=30)sight.push({kind:"player",id:player.id,x:player.x,z:player.z,heading:player.heading,inVehicle:player.mode==="vehicle",lineOfSight:visible,threatening:(activeCombat(sim)?.events??[]).some(event=>event.sourceId===player.id&&event.kind==="weapon.water")});
    if(input&&(input.actions&Action.horn))sounds.push({kind:"horn",playerId:player.id,x:player.x,z:player.z});
    if(input&&(input.actions&Action.watch))watches.push({playerId:player.id,x:player.x,z:player.z,lineOfSight:visible});
  }
  for(const other of others){
    if(other.id===actor.id||other.retired||other.behavior==="pending-admission"||distance(actor,other)>30)continue;
    const visible=!segmentBlocked(world,actor.x,actor.z,other.x,other.z);
    if(human(other.model))sight.push({kind:"person",id:other.numericId,x:other.x,z:other.z,lineOfSight:visible});
    else if(!animal(other.model))sight.push({kind:"robot",id:other.numericId,x:other.x,z:other.z,lineOfSight:visible,alignment:other.firmware==="bad"?"bad":"good",operational:phase(sim,other.id)==="active"});
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
    for(const known of source.brain.knowledge)broadcasts.push({sourceId:source.numericId,sourcePosition:{x:source.x,z:source.z},sourceSeized:phase(sim,source.id)==="seized",emittedTick:sim.tick,observedTick:known.observedTick,playerId:known.playerId,position:{x:known.x,z:known.z}});
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

function motionMetadata(actor:RuntimeActor):Pick<AgentMotionProposal,"bodyKind"|"protected"|"child"|"mobilityAid"|"posture">{
  return {bodyKind:animal(actor.model)?"animal":human(actor.model)?"person":"robot",...(actor.protected!==undefined?{protected:actor.protected}:{}),...(actor.child!==undefined?{child:actor.child}:{}),...(actor.mobilityAid!==undefined?{mobilityAid:actor.mobilityAid}:{}),...(actor.posture?{posture:actor.posture}:{})};
}
function propose(world:World,state:AgentsRuntimeState,actor:RuntimeActor,graph:SidewalkGraph|undefined,intent:RobotBrainIntent|undefined,options:AgentRuntimeOptions,sim:Readonly<SimState>,inputs:InputFrame,others:RuntimeActor[],people:ReturnType<typeof players>):void{
  if(vehicle(actor.model)){
    // Legacy traffic keeps its route mover. New service/mission bodies await shared steering.
    const controls=options.vehicleControls?.[actor.id];
    if(actor.legacyId===null||controls)state.proposals.push({id:actor.id,numericId:actor.numericId,legacyId:null,kind:"vehicle",...(controls?{controls}:{}),...motionMetadata(actor),x:actor.x,y:actor.y,z:actor.z,heading:actor.heading,speed:0,radius:actor.radius,height:actor.height,...(actor.halfLength?{halfLength:actor.halfLength}:{}),...(actor.halfWidth?{halfWidth:actor.halfWidth}:{}),sourceX:actor.x,sourceY:actor.y,sourceZ:actor.z});
    return;
  }
  const wanted=desiredMovement(actor,intent,others);
  const effect=activeCombat(sim)?.targets[actor.id];
  const updating=(activeCombat(sim)?.attacks??[]).some(attack=>attack.kind==="forced-update"&&attack.targetId===actor.id);
  const frozen=Boolean(effect&&effect.phase!=="active"||updating);
  let speed=frozen?0:wanted.speed*(effect?.movementScale??1);
  let goal=wanted.goal,direct=false;
  // Bad firmware has no splash seal: in the rain an idle bad robot heads for shelter (a tell),
  // and on a King-tide day it keeps off the flooded waterfront. Chases and flight still win, and
  // authored mission and scene bodies (significant) keep their scripts.
  if(actor.firmware==="bad"&&!actor.significant&&!wanted.goal&&intent?.movement?.kind!=="hold"&&options.weatherRefuge){
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
      if(distance(actor,player)<=4)observed.push({sourceId:player.id,kind:"nearby",x:player.x,z:player.z,seen,heard:false});
      if(input&&(input.actions&Action.horn))observed.push({sourceId:player.id,kind:"horn",x:player.x,z:player.z,seen,heard:true});
      if(player.mode==="vehicle")observed.push({sourceId:player.id,kind:"vehicle",x:player.x,z:player.z,seen,heard:false,speedMps:Math.abs(player.speed)});
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
    actor.reaction=reaction.state;
    if(reaction.movement.kind==="hold")speed=0;
    else if(reaction.movement.reason==="reaction"||reaction.movement.reason==="leash"){goal={x:actor.x+reaction.movement.vx,z:actor.z+reaction.movement.vz};speed=Math.sqrt(reaction.movement.vx*reaction.movement.vx+reaction.movement.vz*reaction.movement.vz);}
    }
  }
  if(speed<=0||frozen||actor.posted){state.proposals.push({id:actor.id,numericId:actor.numericId,legacyId:actor.legacyId,...motionMetadata(actor),kind:actor.model==="drone"?"flying":"walker",x:actor.x,y:actor.y,z:actor.z,heading:actor.heading,speed:0,radius:actor.radius,height:actor.height,...(actor.halfLength?{halfLength:actor.halfLength}:{}),...(actor.halfWidth?{halfWidth:actor.halfWidth}:{}),sourceX:actor.x,sourceY:actor.y,sourceZ:actor.z});return;}
  // (The last few metres to a shelter leave the sidewalk line for the wall or the stop itself.)
  if(graph?.nodes.length&&actor.model!=="drone"&&actor.reaction.mode!=="avoid"&&!direct){
    const node=goal?nearestSidewalkNode(graph,goal):actor.goalNode;
    if(!actor.route||actor.goalNode!==node||actor.cursor.stepIndex>=actor.route.steps.length){
      const start=nearestSidewalkNode(graph,actor);
      const candidates=goal?[node]:nearbyNodes(graph,actor,60).filter(n=>n.id!==start).map(n=>n.id);
      if(candidates.length){
        const end=candidates[hash(`${actor.id}:${sim.tick>>9}`)%candidates.length]!;
        const route=shortestSidewalkRoute(graph,start,end);
        actor.route=route;actor.cursor={stepIndex:0,distanceM:0};actor.goalNode=end;
      }
    }
    if(actor.route&&actor.route.steps.length){
      const next=advanceSidewalkRoute(graph,actor.route,actor.cursor,speed*DT,edge=>Boolean(options.crossingBlocked?.(edge.id)));
      goal=next.point;actor.pendingCursor=next.cursor;
    }
  }
  if(!goal)goal={x:actor.x+dsin(actor.heading),z:actor.z-dcos(actor.heading)};
  const length=distance(actor,goal),travel=Math.min(length,speed*DT);
  const dx=length>1e-8?(goal.x-actor.x)/length:0,dz=length>1e-8?(goal.z-actor.z)/length:0;
  const x=actor.x+dx*travel,z=actor.z+dz*travel;
  const clear=!segmentBlocked(world,actor.x,actor.z,x,z);
  const y=actor.model==="drone"?actor.y+clamp(groundHeight(world,x,z)+6-actor.y,-2*DT,2*DT):groundHeight(world,x,z);
  const actualX=clear?x:actor.x,actualZ=clear?z:actor.z;
  actor.pendingPoint={x:actualX,z:actualZ};
  state.proposals.push({id:actor.id,numericId:actor.numericId,legacyId:actor.legacyId,...motionMetadata(actor),kind:actor.model==="drone"?"flying":"walker",x:actualX,y:clear?y:actor.y,z:actualZ,heading:length>1e-8?datan2(dx,-dz):actor.heading,speed:clear?speed:0,radius:actor.radius,height:actor.height,...(actor.halfLength?{halfLength:actor.halfLength}:{}),...(actor.halfWidth?{halfWidth:actor.halfWidth}:{}),sourceX:actor.x,sourceY:actor.y,sourceZ:actor.z});
}

function contentGoalWeights(actor:RuntimeActor,wave:number):Partial<Record<RobotGoal,number>>|undefined{
  if(!actor.archetype||!ROBOT_GOALS.archetypes[actor.archetype])return undefined;
  const weights:Partial<Record<RobotGoal,number>>={shove:0,grocerySnatch:0,adBlast:0,phoneHack:0,handshake:0,forcedUpdate:0};
  const sabotage:Record<string,RobotGoal>={snatchGroceries:"grocerySnatch",pushUpdate:"forcedUpdate",stickAd:"adBlast",harvestData:"phoneHack"};
  for(const goal of goalsInWave(actor.archetype,actor.brain?.mode??"disguised",wave)){
    const kind=goal.attack&&goal.attack in weights?goal.attack as RobotGoal:goal.sabotage?sabotage[goal.sabotage]:undefined;
    if(kind)weights[kind]=Math.max(weights[kind]??0,goal.weight);
  }
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
function fallbackGraph(world:World):SidewalkGraph|undefined{
  if(!world.roads)return undefined;
  let graph=graphCache.get(world);
  if(!graph){graph=buildFallbackSidewalkGraph(world.roads);graphCache.set(world,graph);}
  return graph;
}

/** Pure pre-movement planner. Core applies proposals once and owns final clearance. */
export function planAgentRuntime(world:World,sim:Readonly<SimState>,inputs:InputFrame,options:AgentRuntimeOptions={}):AgentsRuntimeState{
  const previous=agentsRuntimeOf(sim)??createAgentsRuntime(sim,options);
  const state=synchronize(previous,sim,options);
  const people=players(sim);
  const anchors=options.anchors??people.map(player=>({id:player.id,x:player.x,z:player.z}));
  const graph=options.graph??fallbackGraph(world);
  const list=keys(state.actors).map(id=>state.actors[id]!);
  const presentLegacy=new Set(agentsOf(sim).map(actor=>actor.id));
  const physical=new Set((sim.ext.agents?.list??[]).map(actor=>actor.runtimeId));
  const controlled=new Set(options.controlledActorIds??[]);
  const badCount=list.filter(actor=>actor.firmware==="bad"&&!actor.retired&&phase(sim,actor.id)==="active").length;
  for(const actor of list){
    if(actor.retired)continue;
    if(controlled.has(actor.id)){actor.intent=null;actor.behavior="controlled";continue;}
    if(actor.legacyId!==null&&!presentLegacy.has(actor.legacyId)){actor.fidelity="abstract";continue;}
    const fidelity=planFidelity(actor,anchors,sim.tick);actor.fidelity=fidelity.tier;
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
      const step=stepRobotBrain(actor.brain,{tick:sim.tick,self:{x:actor.x,z:actor.z,heading:actor.heading,rust:own?.rust??0,fogDensity:clamp(options.fogAt?.(actor.x,actor.z)??options.fog??0,0,1),shoved:(own?.stoppedUntil??0)>sim.tick},
        observations:observationSet(world,sim,actor,list,inputs,people),conversion:{withinFidelity:fidelity.allowConversion,protectedArea:(options.protectedArea??defaultProtected)(actor.x,actor.z),baseBadCount:state.baseBadCount,badCount},
        acknowledgedUpdates:(activeCombat(sim)?.events??[]).filter(event=>event.kind==="robot.converted"&&event.sourceId===actor.id).flatMap(event=>state.actors[event.targetId]?[{targetId:state.actors[event.targetId]!.numericId,completedTick:event.tick}]:[]),
        goalWeights:{...contentGoalWeights(actor,options.wave??2),...(options.conversionCap!==undefined&&badCount>=options.conversionCap?{forcedUpdate:0}:{})}});
      actor.brain=step.state;intent=step.intent;actor.intent=intent;actor.behavior=step.state.mode;actor.hiddenTellId=step.intent.hideOneTell?actor.tellIds[0]??null:null;queueAttack(state,actor,intent,sim,options);
    }
    propose(world,state,actor,graph,intent,options,sim,inputs,list,people);
  }
  return state;
}

/** Shared combat snapshots use the core's observed positions, never unaccepted proposals. */
export function runtimeCombatActors(sim:Readonly<SimState>):CombatActor[]{
  const state=agentsRuntimeOf(sim);if(!state)return [];
  return keys(state.actors).map(id=>state.actors[id]!).filter(actor=>!actor.retired&&actor.fidelity!=="abstract"&&actor.fidelity!=="despawn").map(actor=>({id:actor.id,kind:animal(actor.model)?"animal":human(actor.model)?"person":"robot",x:actor.x,y:actor.y,z:actor.z,heading:actor.heading,speed:actor.speed,radius:actor.radius,height:actor.height,firmware:actor.firmware,
    ...(actor.model==="person"||actor.model==="associate"?{}:{model:actor.model==="pigeon"||actor.model==="dog"||actor.model==="van"||actor.model==="bus"?"footman":actor.model}),
    protected:actor.protected??(animal(actor.model)||(human(actor.model)&&(Boolean(actor.child)||Boolean(actor.mobilityAid)||(actor.posture??"standing")!=="standing"))),...(actor.rustScale!==undefined?{rustScale:actor.rustScale}:{}),...(actor.level!==undefined?{subtlety:actor.level}:{}),...(actor.child?{child:true}:{}),...(actor.posture?{posture:actor.posture}:{}),...(actor.mobilityAid?{mobilityAid:true}:{}),
    ...(vehicle(actor.model)?{obeysTraffic:true}:{}),...(actor.model==="van"||actor.model==="bus"?{protected:true}:{}),pursuing:actor.behavior==="attack",inFidelity:true}));
}

/** Refresh accepted body poses after core movement without running decisions twice. */
export function observeAgentRuntime(sim:Readonly<SimState>,options:AgentRuntimeOptions={}):AgentsRuntimeState{
  const previous=agentsRuntimeOf(sim)??createAgentsRuntime(sim,options);
  const observed=synchronize(previous,sim,options);
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
        waiting.add(id);actor.fidelity="abstract";actor.behavior="pending-admission";actor.speed=0;actor.intent=null;
      }else if(actor.behavior==="pending-admission"){
        actor.fidelity=planFidelity(actor,anchors,sim.tick).tier;actor.behavior="idle";
      }
    }
    if(waiting.size)attacks=attacks.filter(attack=>!waiting.has(attack.attackerId)&&!waiting.has(attack.targetId));
  }
  return {...observed,attacks,proposals:previous.proposals,events:[...previous.events,...observed.events]};
}

export function runtimeAttackRequests(sim:Readonly<SimState>):readonly AttackRequest[]{return agentsRuntimeOf(sim)?.attacks??[];}
