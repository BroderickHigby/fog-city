import { badRobotRate, protectedAreaAt } from "../../content/places.ts";
import { toLatLon } from "../../geo/project.ts";
import { Action, type InputFrame, type SimState } from "../contract.ts";
import { AGENT_SPEC, agentsOf, type AgentState } from "../agents.ts";
import { dcos, dsin, datan2, clamp } from "../dmath.ts";
import { groundHeight, segmentBlocked, type World } from "../world.ts";
import type { AttackKind, AttackRequest, CombatActor, CombatState } from "../combat-contract.ts";
import { createRobotBrain, stepRobotBrain, type RobotBrainState, type RobotBrainIntent, type RobotObservations, type BrainTarget } from "../robots/brain.ts";
import { buildFallbackSidewalkGraph, shortestSidewalkRoute, advanceSidewalkRoute, type SidewalkGraph, type SidewalkRoute, type SidewalkCursor } from "./navigation.ts";
import { planFidelity, type FidelityAnchor } from "./fidelity.ts";
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
  child?: boolean;
  posture?: "standing" | "seated" | "lying";
  mobilityAid?: boolean;
  ownerId?: string;
  significant?: boolean;
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
}

export interface AgentMotionProposal {
  id: string;
  numericId: number;
  legacyId: number | null;
  kind: "walker" | "vehicle" | "flying";
  x: number; y: number; z: number; heading: number; speed: number;
  radius: number; height: number;
  halfLength?: number; halfWidth?: number;
  /** This is a desired step. Core collision/clearance owns acceptance. */
  sourceX: number; sourceY: number; sourceZ: number;
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
  baseBadCount: number;
  lastCombatTick: number;
  attacks: AttackRequest[];
  proposals: AgentMotionProposal[];
  events: AgentRuntimeEvent[];
}

export interface AgentRuntimeOptions {
  graph?: SidewalkGraph;
  spawns?: readonly RuntimeSpawn[];
  /** Core's resulting positions from the previous proposal; absence preserves the old body. */
  observedBodies?: readonly Pick<RuntimeSpawn,"id"|"x"|"y"|"z"|"heading"|"speed">[];
  firmware?: Readonly<Record<string,"good"|"bad"|"none">>;
  wave?: number;
  badRateAt?: (x:number,z:number)=>number;
  fog?: number;
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
function keys<T>(record:Readonly<Record<string,T>>):string[]{return Object.keys(record).sort(compare);}
function distance(a:{x:number;z:number},b:{x:number;z:number}):number{return Math.hypot(a.x-b.x,a.z-b.z);}
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
  if(!spawn.id||!Number.isSafeInteger(spawn.numericId)||spawn.numericId<0||![spawn.x,spawn.y,spawn.z,spawn.heading,spawn.radius,spawn.height].every(Number.isFinite)||spawn.radius<=0||spawn.height<=0)throw new Error("Invalid runtime actor");
  return {...spawn,...(vehicle(spawn.model)?{halfLength:spawn.halfLength??(spawn.model==="bus"?6.6:spawn.model==="van"?2.7:2.2),halfWidth:spawn.halfWidth??(spawn.model==="bus"?1.35:spawn.model==="van"?1.1:.95)}:{}),legacyId,speed:spawn.speed??0,bornTick:tick,retired:false,converted:false,significant:spawn.significant??false,
    brain:spawn.firmware==="bad"&&!vehicle(spawn.model)?createRobotBrain({id:spawn.numericId,archetype:archetype(spawn.model),tick}):null,
    intent:null,reaction:IDLE_REACTION,route:null,cursor:{stepIndex:0,distanceM:0},goalNode:"",pendingCursor:null,pendingPoint:null,attackSequence:0,actionToken:"",fidelity:"full",behavior:"idle"};
}

function legacySpawn(agent:AgentState,seed:number,options:AgentRuntimeOptions):RuntimeSpawn{
  const id=`agent:${agent.id}`, model=agent.kind==="errandRobot"?"footman":agent.kind==="sidewalkBot"?"trundle":agent.kind;
  const firmware=options.firmware?.[id]??(model==="person"?"none":hash(`${seed}:${id}`)/4294967296<clamp((options.badRateAt??defaultBadRate)(agent.x,agent.z),0,1)?"bad":"good");
  return {id,numericId:agent.id,model,firmware,x:agent.x,y:agent.y,z:agent.z,heading:agent.heading,speed:agent.speed,
    radius:AGENT_SPEC[agent.kind].radius,height:model==="trundle"?.7:1.8,
    ...(model==="person"?{posture:"standing" as const,child:false,mobilityAid:false}:{})};
}

export function createAgentsRuntime(state:Readonly<SimState>,options:AgentRuntimeOptions={}):AgentsRuntimeState{
  const actors:Record<string,RuntimeActor>={};
  for(const agent of [...agentsOf(state)].sort((a,b)=>a.id-b.id)) {const spawn=legacySpawn(agent,state.seed,options);actors[spawn.id]=initialize(spawn,state.tick,agent.id);}
  for(const spawn of [...(options.spawns??[])].sort((a,b)=>compare(a.id,b.id))){if(actors[spawn.id])throw new Error("Duplicate runtime actor ID");actors[spawn.id]=initialize(spawn,state.tick,null);}
  if(keys(actors).length>MAX_RUNTIME_ACTORS)throw new Error("Runtime actor budget exceeded");
  return {version:1,tick:state.tick,actors,baseBadCount:keys(actors).filter(id=>actors[id]!.firmware==="bad").length,lastCombatTick:-1,attacks:[],proposals:[],events:[]};
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
  for(const agent of [...agentsOf(sim)].sort((a,b)=>a.id-b.id)){
    const id=`agent:${agent.id}`, old=previous.actors[id];known.add(id);
    state.actors[id]=old?{...old,x:agent.x,y:agent.y,z:agent.z,heading:agent.heading,speed:agent.speed}:initialize(legacySpawn(agent,sim.seed,options),sim.tick,agent.id);
  }
  for(const spawn of [...(options.spawns??[])].sort((a,b)=>compare(a.id,b.id))){
    if(known.has(spawn.id))throw new Error("Duplicate runtime actor ID");known.add(spawn.id);
    state.actors[spawn.id]=previous.actors[spawn.id]?{...previous.actors[spawn.id]!}:initialize(spawn,sim.tick,null);
  }
  for(const id of keys(previous.actors))if(!known.has(id)&&(previous.actors[id]!.significant||previous.actors[id]!.legacyId===null))state.actors[id]={...previous.actors[id]!,fidelity:"abstract"};
  for(const observed of options.observedBodies??[]){const actor=state.actors[observed.id];if(actor&&[observed.x,observed.y,observed.z,observed.heading,observed.speed??0].every(Number.isFinite))Object.assign(actor,observed);}
  if(keys(state.actors).length>MAX_RUNTIME_ACTORS)throw new Error("Runtime actor budget exceeded");
  const numericIds=new Set<number>();
  for(const id of keys(state.actors)){
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
      if(!actor)continue;
      if(received.kind==="robot.converted"){
        actor.firmware="bad";actor.converted=true;actor.significant=true;
        actor.brain=createRobotBrain({id:actor.numericId,archetype:archetype(actor.model),tick:sim.tick});event(state,"actor.converted",actor.id);
      }
      if(received.kind==="robot.heap-cleared"){actor.retired=true;event(state,"actor.retired",actor.id,"heap-cleared");}
    }
    state.lastCombatTick=combat.tick;
  }
  if(state.baseBadCount===0)state.baseBadCount=keys(state.actors).filter(id=>state.actors[id]!.firmware==="bad"&&!state.actors[id]!.converted).length;
  return state;
}

function observationSet(world:World,sim:Readonly<SimState>,actor:RuntimeActor,others:RuntimeActor[],inputs:InputFrame):RobotObservations{
  const sight:RobotObservations["sight"][number][]=[],sounds:RobotObservations["sounds"][number][]=[],scans:RobotObservations["scans"][number][]=[],watches:RobotObservations["watches"][number][]=[];
  const people=players(sim);
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
    if(other.id===actor.id||other.retired||distance(actor,other)>30)continue;
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
function nearestNode(graph:SidewalkGraph,point:{x:number;z:number}):string{
  let best="",d=Infinity;
  // Most moving bodies have a nearby graph node; a full scan is only a remote-spawn fallback.
  const local=nearbyNodes(graph,point,75);
  for(const node of local.length?local:graph.nodes){const next=distance(node,point);if(next<d||next===d&&compare(node.id,best)<0){d=next;best=node.id;}}
  return best;
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

function propose(world:World,state:AgentsRuntimeState,actor:RuntimeActor,graph:SidewalkGraph|undefined,intent:RobotBrainIntent|undefined,options:AgentRuntimeOptions,sim:Readonly<SimState>,inputs:InputFrame):void{
  if(vehicle(actor.model))return; // Shared steering drives vehicles and acknowledges measured service progress.
  const others=keys(state.actors).map(id=>state.actors[id]!);
  const wanted=desiredMovement(actor,intent,others);
  const effect=activeCombat(sim)?.targets[actor.id];
  const frozen=effect&&effect.phase!=="active";
  let speed=frozen?0:wanted.speed*(effect?.movementScale??1);
  let goal=wanted.goal;
  if(actor.model==="person"||animal(actor.model)||actor.firmware==="good"){
    const stimuli:PerceivedStimulus[]=players(sim).flatMap(player=>{
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
    const reaction=reactToPerception({actor:{id:actor.id,kind:actor.model==="pigeon"?"pigeon":actor.model==="dog"?"dog":actor.firmware==="good"?"good-robot":"person",x:actor.x,z:actor.z,wet:(effect?.wetUntil??0)>sim.tick,...(actor.child?{child:true}:{}),...(actor.posture?{posture:actor.posture}:{}),...(actor.mobilityAid?{mobilityAid:true}:{}),...(actor.model==="dog"&&actor.ownerId&&others.find(other=>other.id===actor.ownerId)?{leash:{ownerId:actor.ownerId,ownerX:others.find(other=>other.id===actor.ownerId)!.x,ownerZ:others.find(other=>other.id===actor.ownerId)!.z,lengthM:4}}:{})},state:actor.reaction,stimuli,tick:sim.tick,dodgeOverrideActive:false,routineVelocity:{vx:dsin(actor.heading)*speed,vz:-dcos(actor.heading)*speed}});
    actor.reaction=reaction.state;
    if(reaction.movement.kind==="hold")speed=0;
    else if(reaction.movement.reason==="reaction"||reaction.movement.reason==="leash"){goal={x:actor.x+reaction.movement.vx,z:actor.z+reaction.movement.vz};speed=Math.hypot(reaction.movement.vx,reaction.movement.vz);}
    }
  }
  if(speed<=0||frozen){state.proposals.push({id:actor.id,numericId:actor.numericId,legacyId:actor.legacyId,kind:actor.model==="drone"?"flying":"walker",x:actor.x,y:actor.y,z:actor.z,heading:actor.heading,speed:0,radius:actor.radius,height:actor.height,...(actor.halfLength?{halfLength:actor.halfLength}:{}),...(actor.halfWidth?{halfWidth:actor.halfWidth}:{}),sourceX:actor.x,sourceY:actor.y,sourceZ:actor.z});return;}
  if(graph?.nodes.length&&actor.model!=="drone"&&actor.reaction.mode!=="avoid"){
    const node=goal?nearestNode(graph,goal):actor.goalNode;
    if(!actor.route||actor.goalNode!==node||actor.cursor.stepIndex>=actor.route.steps.length){
      const start=nearestNode(graph,actor);
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
  state.proposals.push({id:actor.id,numericId:actor.numericId,legacyId:actor.legacyId,kind:actor.model==="drone"?"flying":"walker",x:actualX,y:clear?y:actor.y,z:actualZ,heading:length>1e-8?datan2(dx,-dz):actor.heading,speed:clear?speed:0,radius:actor.radius,height:actor.height,...(actor.halfLength?{halfLength:actor.halfLength}:{}),...(actor.halfWidth?{halfWidth:actor.halfWidth}:{}),sourceX:actor.x,sourceY:actor.y,sourceZ:actor.z});
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
  const anchors=options.anchors??players(sim).map(player=>({id:player.id,x:player.x,z:player.z}));
  const graph=options.graph??fallbackGraph(world);
  const list=keys(state.actors).map(id=>state.actors[id]!);
  const presentLegacy=new Set(agentsOf(sim).map(actor=>actor.id));
  const badCount=list.filter(actor=>actor.firmware==="bad"&&!actor.retired&&phase(sim,actor.id)==="active").length;
  for(const actor of list){
    if(actor.retired)continue;
    if(actor.legacyId!==null&&!presentLegacy.has(actor.legacyId)){actor.fidelity="abstract";continue;}
    const fidelity=planFidelity(actor,anchors,sim.tick);actor.fidelity=fidelity.tier;
    if(!fidelity.allowCombat)continue;
    let intent:RobotBrainIntent|undefined=actor.intent??undefined;
    if(actor.firmware==="bad"&&!vehicle(actor.model)&&phase(sim,actor.id)==="active"&&(fidelity.run||actor.brain?.windup||actor.brain?.update)){
      actor.brain??=createRobotBrain({id:actor.numericId,archetype:archetype(actor.model),tick:sim.tick});
      if(actor.brain.lastTick>=sim.tick)continue;
      const own=activeCombat(sim)?.targets[actor.id];
      const step=stepRobotBrain(actor.brain,{tick:sim.tick,self:{x:actor.x,z:actor.z,heading:actor.heading,rust:own?.rust??0,fogDensity:clamp(options.fog??0,0,1),shoved:(own?.stoppedUntil??0)>sim.tick},
        observations:observationSet(world,sim,actor,list,inputs),conversion:{withinFidelity:fidelity.allowConversion,protectedArea:(options.protectedArea??defaultProtected)(actor.x,actor.z),baseBadCount:state.baseBadCount,badCount},
        acknowledgedUpdates:(activeCombat(sim)?.events??[]).filter(event=>event.kind==="robot.converted"&&event.sourceId===actor.id).flatMap(event=>state.actors[event.targetId]?[{targetId:state.actors[event.targetId]!.numericId,completedTick:event.tick}]:[]),
        ...(options.conversionCap!==undefined?{goalWeights:{forcedUpdate:badCount>=options.conversionCap?0:8}}:{})});
      actor.brain=step.state;intent=step.intent;actor.intent=intent;actor.behavior=step.state.mode;queueAttack(state,actor,intent,sim,options);
    }
    propose(world,state,actor,graph,intent,options,sim,inputs);
  }
  return state;
}

/** Shared combat snapshots use the core's observed positions, never unaccepted proposals. */
export function runtimeCombatActors(sim:Readonly<SimState>):CombatActor[]{
  const state=agentsRuntimeOf(sim);if(!state)return [];
  return keys(state.actors).map(id=>state.actors[id]!).filter(actor=>!actor.retired&&actor.fidelity!=="abstract"&&actor.fidelity!=="despawn").map(actor=>({id:actor.id,kind:animal(actor.model)?"animal":human(actor.model)?"person":"robot",x:actor.x,y:actor.y,z:actor.z,heading:actor.heading,speed:actor.speed,radius:actor.radius,height:actor.height,firmware:actor.firmware,
    ...(actor.model==="person"||actor.model==="associate"?{}:{model:actor.model==="pigeon"||actor.model==="dog"||actor.model==="van"||actor.model==="bus"?"footman":actor.model}),
    protected:animal(actor.model)||(human(actor.model)&&(Boolean(actor.child)||Boolean(actor.mobilityAid)||(actor.posture??"standing")!=="standing")),...(actor.child?{child:true}:{}),...(actor.posture?{posture:actor.posture}:{}),...(actor.mobilityAid?{mobilityAid:true}:{}),
    ...(vehicle(actor.model)?{obeysTraffic:true}:{}),...(actor.model==="van"||actor.model==="bus"?{protected:true}:{}),pursuing:actor.behavior==="attack",inFidelity:true}));
}

/** Refresh accepted body poses after core movement without running decisions twice. */
export function observeAgentRuntime(sim:Readonly<SimState>,options:AgentRuntimeOptions={}):AgentsRuntimeState{
  const previous=agentsRuntimeOf(sim)??createAgentsRuntime(sim,options);
  const observed=synchronize(previous,sim,options);
  return {...observed,attacks:previous.attacks,proposals:previous.proposals,events:[...previous.events,...observed.events]};
}

export function runtimeAttackRequests(sim:Readonly<SimState>):readonly AttackRequest[]{return agentsRuntimeOf(sim)?.attacks??[];}
