import {Action,NEUTRAL_INPUT,type InputFrame,type SimInput,type SimState} from "../contract.ts";
import {isGameplayId,type GameplayCommand} from "../gameplay-contract.ts";
import {clamp,datan2,dcos,dsin,wrapAngle} from "../dmath.ts";
import {segmentBlocked,type World} from "../world.ts";
import {createFollowerState,stepVehicleFollower,type FollowerState} from "../vehicles/follower.ts";

export type RivalBotRole="hunter"|"spotter"|"hider";
/** This boundary intentionally contains no firmware, hidden role, heat or omniscient target. */
export interface BotVisibleActor {
 id:string;kind:"robot"|"person"|"animal"|"player";x:number;y:number;z:number;
 visible:boolean;operational:boolean;height?:number;suspicion?:number;rival?:boolean;
}
export interface BotRefill {id:string;x:number;y:number;z:number;radius:number}
export interface BotObservation {
 playerId:string;actors:readonly BotVisibleActor[];refills:readonly BotRefill[];
 objective?:{x:number;z:number};paused?:boolean;
}
export interface BotKnowledge {
 id:string;kind:BotVisibleActor["kind"];x:number;y:number;z:number;seenTick:number;expiresTick:number;
 status:"unknown"|"good"|"bad";scanTick:number;suspicion:number;rival:boolean;
}
export interface RivalBotMemory {
 id:string;role:RivalBotRole;knowledge:BotKnowledge[];lastX:number;lastZ:number;lastProgressTick:number;
 lastMove:boolean;recoverUntil:number;commandSequence:number;targetId:string;goal:"idle"|"travel"|"scan"|"spray"|"refill"|"recover"|"hide";
 follower:FollowerState|null;
}
export interface RivalBotState {version:1;tick:number;bots:Record<string,RivalBotMemory>}
export interface RivalBotPlan {state:RivalBotState;inputs:InputFrame;commands:GameplayCommand[]}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const distance=(a:{x:number;z:number},b:{x:number;z:number})=>Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.z-b.z)*(a.z-b.z));
const finite=(p:{x:number;y?:number;z:number})=>Number.isFinite(p.x)&&Number.isFinite(p.z)&&(p.y===undefined||Number.isFinite(p.y));
function activeBody(sim:Readonly<SimState>,id:string){const p=sim.players[id]!;return p.mode==="foot"&&p.foot?p.foot:p.car;}
function hash(id:string){let out=2166136261;for(let i=0;i<id.length;i++)out=Math.imul(out^id.charCodeAt(i),16777619);return out>>>0;}
export function createRivalBotState(roles:Readonly<Record<string,RivalBotRole>>):RivalBotState {
 const bots:Record<string,RivalBotMemory>={};
 if(Object.keys(roles).length>24)throw new Error("Bot capacity exceeded");
 for(const id of Object.keys(roles).sort()){
  if(!isGameplayId(id)||!["hunter","spotter","hider"].includes(roles[id]!))throw new Error("Invalid bot identity or role");
  bots[id]={id,role:roles[id]!,knowledge:[],lastX:0,lastZ:0,lastProgressTick:0,lastMove:false,recoverUntil:0,commandSequence:0,targetId:"",goal:"idle",follower:null};
 }
 return {version:1,tick:-1,bots};
}
function observe(world:World,sim:Readonly<SimState>,memory:RivalBotMemory,input:BotObservation):{knowledge:BotKnowledge[];visible:BotVisibleActor[]}{
 if(input.actors.length>256||input.refills.length>512)throw new Error("Bot perception capacity exceeded");
 const body=activeBody(sim,memory.id),known=new Map(memory.knowledge.filter(k=>k.expiresTick>sim.tick).map(k=>[k.id,{...k}]));
 const visible:BotVisibleActor[]=[],seen=new Set<string>();
 for(const actor of [...input.actors].sort((a,b)=>compare(a.id,b.id))){
  if(!isGameplayId(actor.id)||seen.has(actor.id)||!finite(actor)||!Number.isFinite(actor.suspicion??0))throw new Error("Invalid bot observation");seen.add(actor.id);
  const dx=actor.x-body.x,dz=actor.z-body.z,d=distance(body,actor);
  if(!actor.visible||!actor.operational||d>40||(d>.01&&(dx*dsin(body.heading)-dz*dcos(body.heading))/d<.6427876096865394)||segmentBlocked(world,body.x,body.z,actor.x,actor.z))continue;
  visible.push(actor);
  const old=known.get(actor.id);
  known.set(actor.id,{id:actor.id,kind:actor.kind,x:actor.x,y:actor.y,z:actor.z,seenTick:sim.tick,expiresTick:sim.tick+600,status:old?.status??"unknown",scanTick:old?.scanTick??-1,suspicion:clamp(actor.suspicion??0,0,1),rival:actor.kind==="player"&&actor.rival===true});
 }
 const scan=sim.ext.combat?.players[memory.id]?.scan;
 if(scan&&scan.tick<=sim.tick){const actor=known.get(scan.targetId);if(actor&&actor.kind==="robot"&&scan.tick>actor.scanTick){actor.status=scan.bad?"bad":"good";actor.scanTick=scan.tick;}}
 const knowledge=[...known.keys()].sort((a,b)=>known.get(b)!.seenTick-known.get(a)!.seenTick||compare(a,b)).slice(0,64).map(id=>known.get(id)!).sort((a,b)=>compare(a.id,b.id));
 return {knowledge,visible};
}
function footInput(body:{x:number;z:number;heading:number},goal:{x:number;z:number},role:RivalBotRole):SimInput {
 const d=distance(body,goal);if(d<1)return {...NEUTRAL_INPUT};
 const error=wrapAngle(datan2(goal.x-body.x,-(goal.z-body.z))-body.heading);
 return {throttle:d<1?0:Math.abs(error)>1.2?.2:1,steer:clamp(error*1.8,-1,1),brake:role!=="hider"&&d>12&&Math.abs(error)<.5?1:0,actions:0};
}
function wander(world:World,body:{x:number;z:number},id:string,tick:number):{x:number;z:number}{
 const phase=(hash(id)+Math.floor(tick/600))%4;
 const directions=[[1,0],[0,1],[-1,0],[0,-1]] as const;
 for(let i=0;i<4;i++){const dir=directions[(phase+i)%4]!;const point={x:body.x+dir[0]*12,z:body.z+dir[1]*12};if(!segmentBlocked(world,body.x,body.z,point.x,point.z))return point;}
 return {x:body.x,z:body.z};
}

/** Avoid a spray command when a seen person or animal is in front of the target. */
function clearFireCorridor(body:{x:number;z:number},target:BotKnowledge,visible:readonly BotVisibleActor[]):boolean {
 const d=distance(body,target);if(d<.01)return false;
 const dx=(target.x-body.x)/d,dz=(target.z-body.z)/d;
 for(const actor of visible){
  if(actor.id===target.id||actor.kind!=="person"&&actor.kind!=="animal")continue;
  const x=actor.x-body.x,z=actor.z-body.z,along=x*dx+z*dz;
  if(along>=0&&along<d&&Math.abs(x*dz-z*dx)<1.25)return false;
 }
 return true;
}

/** Plan ordinary player inputs from sensed facts. Core applies the same controllers as humans. */
export function planRivalBotInputs(world:World,sim:Readonly<SimState>,previous:Readonly<RivalBotState>,observations:readonly BotObservation[]):RivalBotPlan {
 if(!Number.isSafeInteger(sim.tick)||sim.tick<0||sim.tick<previous.tick||observations.length>24)throw new Error("Invalid bot tick or capacity");
 const byId=new Map<string,BotObservation>();for(const observation of observations){if(byId.has(observation.playerId))throw new Error("Duplicate bot observation");byId.set(observation.playerId,observation);}
 const state:RivalBotState={version:1,tick:sim.tick,bots:{}},inputs:Record<string,SimInput>={},commands:GameplayCommand[]=[];
 for(const id of Object.keys(previous.bots).sort()){
  const old=previous.bots[id]!,player=sim.players[id];if(!player)continue;
  const body=activeBody(sim,id),input=byId.get(id),memory:RivalBotMemory={...old,knowledge:old.knowledge.map(k=>({...k}))};state.bots[id]=memory;
  if(!input||input.paused){inputs[id]={...NEUTRAL_INPUT};memory.lastMove=false;continue;}
  const sensed=observe(world,sim,memory,input);memory.knowledge=sensed.knowledge;
  const water=sim.ext.combat?.players[id]?.water??8;
  const seenIds=new Set(sensed.visible.map(actor=>actor.id));
  const ranked=memory.knowledge.filter(actor=>(actor.kind==="robot"&&actor.status!=="good")||(actor.kind==="player"&&actor.rival))
   .sort((a,b)=>Number(b.status==="bad"||b.rival)-Number(a.status==="bad"||a.rival)||b.suspicion-a.suspicion||distance(body,a)-distance(body,b)||compare(a.id,b.id));
  let target=ranked[0],goal=input.objective,action=0,aim:BotKnowledge|undefined;
  memory.goal=memory.role==="hider"?"hide":"travel";memory.targetId="";
  if(memory.role!=="hider"&&water<=1.2){
   const refill=[...input.refills].filter(source=>finite(source)&&Number.isFinite(source.radius)&&source.radius>0).sort((a,b)=>distance(body,a)-distance(body,b)||compare(a.id,b.id))[0];
   if(refill){goal=refill;memory.targetId=refill.id;memory.goal="refill";if(distance(body,refill)<=refill.radius&&Math.abs(body.speed)<=3){action|=Action.interact;goal={x:body.x,z:body.z};}}
  }else if(memory.role!=="hider"&&target){
   goal=target;memory.targetId=target.id;aim=target;
   if(seenIds.has(target.id)){
    if((target.status==="bad"||target.rival)&&memory.role!=="spotter"){
     memory.goal="spray";
     if(distance(body,target)<=(player.mode==="vehicle"?7:12)){if(clearFireCorridor(body,target,sensed.visible))action|=Action.fire;goal={x:body.x,z:body.z};}
    }else if(memory.role==="spotter"&&target.status==="bad"){
     memory.goal="scan";action|=Action.watch;if(distance(body,target)<=20)goal={x:body.x,z:body.z};
    }else if(target.kind==="robot"&&target.status==="unknown"){
     memory.goal="scan";
     if(distance(body,target)<=25){action|=Action.scan;goal={x:body.x,z:body.z};}
    }
   }
  }
  goal??=wander(world,body,id,sim.tick);
  let control:SimInput;
  if(player.mode==="vehicle"){
   memory.follower??=createFollowerState(body);
   const follow=stepVehicleFollower(world,body,memory.follower,{kind:"pursue",target:goal,stopDistance:memory.goal==="refill"?1:2,maxSpeed:memory.goal==="travel"?12:5});memory.follower=follow.state;control={...follow.input};
  }else {memory.follower=null;control=footInput(body,goal,memory.role);}
  if(distance(body,{x:old.lastX,z:old.lastZ})>.02||!old.lastMove)memory.lastProgressTick=sim.tick;
  if(old.lastMove&&sim.tick-memory.lastProgressTick>=240&&memory.recoverUntil<=sim.tick)memory.recoverUntil=sim.tick+90;
  if(memory.recoverUntil>sim.tick){memory.goal="recover";control={throttle:player.mode==="vehicle"?-.5:.5,steer:hash(id)%2?1:-1,brake:0,actions:0};action=0;}
  control.actions=action;
  if(aim){control.aimYaw=datan2(aim.x-body.x,-(aim.z-body.z));control.aimPitch=clamp(datan2(aim.y+.9-(body.y+1.2),Math.max(.1,distance(body,aim))),-.8,.8);}
  memory.lastX=body.x;memory.lastZ=body.z;memory.lastMove=Math.abs(control.throttle)>.05;inputs[id]=control;
  // The same recorded command path is used for a bot's popup dismissals and press edges.
  for(const attack of sim.ext.combat?.attacks??[]){if(!attack.active||attack.targetId!==id&&attack.targetId!==`player:${id}`)continue;
   const kind=attack.kind==="ad-blast"?"close-ad":attack.kind==="handshake"&&sim.tick%4===0?"break-free":undefined;
   if(kind)commands.push({playerId:id,sequence:++memory.commandSequence,kind});
  }
 }
 return {state,inputs,commands};
}
