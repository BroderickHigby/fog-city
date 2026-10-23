import { sortedIds } from "../contract.ts";
import { nextU32, seedRng } from "../rng.ts";
import type { RngState } from "../contract.ts";
import type { CombatEvent } from "../combat-contract.ts";

export type CrowdTaskKind="cone"|"update"|"ad"|"groceries";
export interface CrowdPoint {x:number;y:number;z:number}
export interface CrowdTask extends CrowdPoint {id:string;kind:CrowdTaskKind}
export interface CrowdPlayer {
  id:string;team:0|1;role:"hider"|"spotter";score:number;unitId:string;
  reconnectAt:number;survivalTicks:number;scanCharges:number;scanChargeTicks:number;scanReadyAt:number;
  taskId:string;taskTicks:number;burstUntil:number;burstReadyAt:number;quiet:boolean;
}
export interface CrowdEvent {id:number;tick:number;kind:string;playerId:string;targetId:string;amount:number}
export interface CrowdState {
  version:1;tick:number;elapsedTicks:number;half:1|2;solo:boolean;rng:RngState;
  phase:"active"|"finished";players:Record<string,CrowdPlayer>;tasks:CrowdTask[];activeTasks:string[];
  retiredUnitIds:string[];
  pings:{taskId:string;due:number}[];lastCombatTick:number;lastCombatId:number;nextEventId:number;events:CrowdEvent[];
  winnerTeam:0|1|null;
}
export interface CrowdConfig {seed:number;players:readonly string[];hiders:readonly string[];tasks:readonly CrowdTask[];solo?:boolean;quietPlayers?:readonly string[]}
export interface CrowdInput {interact?:boolean;taskId?:string;scanTarget?:string;burst?:boolean;emote?:"wait"|"carry"|"recharge"|"wave"|"apologise"}
export interface CrowdContext {
  tick?:number;paused?:boolean;positions:Readonly<Record<string,CrowdPoint>>;inputs?:Readonly<Record<string,CrowdInput>>;
  combatEvents?:readonly CombatEvent[];badRobotIds?:readonly string[];scannableIds?:readonly string[];
  /** Core-approved replacement bodies, clear of people and >=150m from Spotters. */
  acceptedUnits?:readonly (CrowdPoint&{id:string;playerId:string;clear:boolean;attached:true})[];
}
export const CROWD_RULES={halfTicks:6*60*60,reconnectTicks:10*60,pingTicks:5*60,survivalTicks:2*60*60,chargeTicks:60*60,scanRange:25,attachClearance:150,taskRange:3} as const;
function nextInt(rng:RngState,max:number):[number,RngState]{const [value,next]=nextU32(rng);return [Math.floor(value/4294967296*max),next];}
const duration:Record<CrowdTaskKind,number>={cone:5*60,update:6*60,ad:4*60,groceries:2*60};
const validId=(id:string)=>/^[A-Za-z0-9:_-]{1,96}$/.test(id)&&!Object.hasOwn(Object.prototype,id)&&id!=="prototype";
const finite=(p:CrowdPoint|undefined):p is CrowdPoint=>!!p&&[p.x,p.y,p.z].every(Number.isFinite);
function distance(a:CrowdPoint,b:CrowdPoint):number {const x=a.x-b.x,y=a.y-b.y,z=a.z-b.z;return x*x+y*y+z*z;}
function emit(s:CrowdState,kind:string,playerId="",targetId="",amount=0):void{s.events.push({id:s.nextEventId++,tick:s.tick,kind,playerId,targetId,amount});}
function pickTasks(s:CrowdState):void {
  const remaining=s.tasks.map(task=>task.id).sort();s.activeTasks=[];
  while(s.activeTasks.length<3){const [index,rng]=nextInt(s.rng,remaining.length);s.rng=rng;s.activeTasks.push(remaining.splice(index,1)[0]!);}
  s.activeTasks.sort();
}
export function createCrowdState(config:CrowdConfig):CrowdState {
  const ids=[...config.players].sort(),hiders=new Set(config.hiders);
  if(!Number.isSafeInteger(config.seed)||ids.length<3||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>!validId(id))||hiders.size<1||hiders.size>3||ids.length-hiders.size<2||[...hiders].some(id=>!ids.includes(id)))throw new Error("Invalid crowd participants");
  const tasks=config.tasks.map(task=>({...task})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(tasks.length<4||tasks.length>128||new Set(tasks.map(task=>task.id)).size!==tasks.length||tasks.some(task=>!validId(task.id)||!finite(task)||!Object.hasOwn(duration,task.kind)))throw new Error("Invalid crowd tasks");
  const players:Record<string,CrowdPlayer>={};
  for(const id of ids)players[id]={id,team:hiders.has(id)?0:1,role:hiders.has(id)?"hider":"spotter",score:0,unitId:"",reconnectAt:0,survivalTicks:0,scanCharges:3,scanChargeTicks:0,scanReadyAt:0,taskId:"",taskTicks:0,burstUntil:0,burstReadyAt:0,quiet:config.quietPlayers?.includes(id)??false};
  const state:CrowdState={version:1,tick:0,elapsedTicks:0,half:1,solo:config.solo??false,rng:seedRng(config.seed),phase:"active",players,tasks,activeTasks:[],retiredUnitIds:[],pings:[],lastCombatTick:-1,lastCombatId:-1,nextEventId:1,events:[],winnerTeam:null};
  pickTasks(state);return state;
}
function attachUnits(s:CrowdState,ctx:CrowdContext):void {
  const used=new Set([...s.retiredUnitIds,...sortedIds(s.players).map(id=>s.players[id]!.unitId).filter(Boolean)]);
  const candidates=[...(ctx.acceptedUnits??[])].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  for(const candidate of candidates){
    const player=s.players[candidate.playerId];
    if(!player||player.role!=="hider"||player.unitId||s.elapsedTicks<player.reconnectAt||!validId(candidate.id)||used.has(candidate.id)||!candidate.clear||candidate.attached!==true||!finite(candidate)||!finite(ctx.positions[candidate.id])||distance(candidate,ctx.positions[candidate.id]!)>0.0025)continue;
    const blocked=sortedIds(s.players).some(id=>s.players[id]!.role==="spotter"&&(!finite(ctx.positions[id])||distance(candidate,ctx.positions[id]!)<CROWD_RULES.attachClearance*CROWD_RULES.attachClearance));
    if(blocked)continue;
    player.unitId=candidate.id;used.add(candidate.id);emit(s,"crowd.attached",player.id,candidate.id);
  }
}
function combat(s:CrowdState,ctx:CrowdContext):void {
  const events=[...(ctx.combatEvents??[])].filter(event=>Number.isSafeInteger(event.id)&&event.id>0&&Number.isSafeInteger(event.tick)&&event.tick>=0&&(event.tick>s.lastCombatTick||event.tick===s.lastCombatTick&&event.id>(s.lastCombatId??-1))&&event.tick<=s.tick).sort((a,b)=>a.tick-b.tick||a.id-b.id);
  const seen=new Set<string>();
  for(const event of events){
    const key=`${event.tick}:${event.id}`;if(seen.has(key))continue;seen.add(key);
    const source=s.players[event.sourceId],victim=sortedIds(s.players).map(id=>s.players[id]!).find(player=>player.unitId===event.targetId);
    if(event.kind==="robot.heap"&&victim){
      if(source?.role==="spotter"){source.score+=500;emit(s,"crowd.score",source.id,victim.id,500);}
      if(s.retiredUnitIds.length<4096)s.retiredUnitIds.push(victim.unitId);
      victim.unitId="";victim.reconnectAt=s.elapsedTicks+CROWD_RULES.reconnectTicks;victim.survivalTicks=0;victim.taskTicks=0;victim.taskId="";
      emit(s,"crowd.connection-dropped",victim.id,event.targetId);
    }else if(event.kind==="robot.heap"&&source?.role==="spotter"&&ctx.badRobotIds?.includes(event.targetId)){source.score+=50;emit(s,"crowd.score",source.id,event.targetId,50);}
    else if(event.kind==="economy.penalty"&&source?.role==="spotter"){const amount=event.amount===20?-200:-150;source.score+=amount;emit(s,"crowd.score",source.id,event.targetId,amount);}
  }
  if(events.length){s.lastCombatTick=events[events.length-1]!.tick;s.lastCombatId=events[events.length-1]!.id;}
}
function hider(s:CrowdState,player:CrowdPlayer,ctx:CrowdContext,input:CrowdInput):void {
  if(!player.unitId){if(s.elapsedTicks>=player.reconnectAt)emit(s,"crowd.unit-request",player.id);return;}
  const position=ctx.positions[player.unitId];if(!finite(position)){player.taskId="";player.taskTicks=0;return;}
  player.survivalTicks++;
  if(player.survivalTicks%CROWD_RULES.survivalTicks===0){player.score+=300;emit(s,"crowd.score",player.id,"",300);}
  if(s.elapsedTicks%(player.quiet?2700:1800)===0)emit(s,"crowd.flicker",player.id,player.unitId);
  if(input.burst&&s.elapsedTicks>=player.burstReadyAt){player.burstUntil=s.elapsedTicks+120;player.burstReadyAt=s.elapsedTicks+600;emit(s,"crowd.overdraw",player.id,player.unitId,120);}
  if(input.emote&&["wait","carry","recharge","wave","apologise"].includes(input.emote))emit(s,`crowd.emote.${input.emote}`,player.id,player.unitId);
  const task=s.tasks.find(task=>task.id===input.taskId&&s.activeTasks.includes(task.id));
  if(!input.interact||!task||distance(position,task)>CROWD_RULES.taskRange*CROWD_RULES.taskRange){player.taskId="";player.taskTicks=0;return;}
  if(player.taskId!==task.id){player.taskId=task.id;player.taskTicks=0;}
  player.taskTicks++;
  if(player.taskTicks<duration[task.kind])return;
  player.score+=200;player.taskTicks=0;player.taskId="";emit(s,`crowd.task.${task.kind}`,player.id,task.id,200);
  s.pings.push({taskId:task.id,due:s.elapsedTicks+CROWD_RULES.pingTicks});
  const replacements=s.tasks.map(task=>task.id).filter(id=>!s.activeTasks.includes(id)).sort();
  // Three-site instances retain the site after completion; all progress resets.
  if(replacements.length){const [index,rng]=nextInt(s.rng,replacements.length);s.rng=rng;s.activeTasks=s.activeTasks.map(id=>id===task.id?replacements[index]!:id).sort();}
}
function spotter(s:CrowdState,player:CrowdPlayer,ctx:CrowdContext,input:CrowdInput):void {
  if(player.scanCharges<3&&++player.scanChargeTicks>=CROWD_RULES.chargeTicks){player.scanCharges++;player.scanChargeTicks=0;}
  if(!input.scanTarget||player.scanCharges<=0||player.scanReadyAt>s.elapsedTicks||!ctx.scannableIds?.includes(input.scanTarget))return;
  const source=ctx.positions[player.id],target=ctx.positions[input.scanTarget];
  if(!finite(source)||!finite(target)||distance(source,target)>CROWD_RULES.scanRange*CROWD_RULES.scanRange)return;
  const victim=sortedIds(s.players).map(id=>s.players[id]!).find(p=>p.unitId===input.scanTarget);
  player.scanCharges--;player.scanReadyAt=s.elapsedTicks+60;const [draw,rng]=nextInt(s.rng,10);s.rng=rng;
  const truth=!!victim||!!ctx.badRobotIds?.includes(input.scanTarget);
  emit(s,"crowd.scan",player.id,input.scanTarget,(draw<7?truth:!truth)?1:0);
}
function finishHalf(s:CrowdState):void {
  if(s.solo||s.half===2){
    s.phase="finished";const scores=[0,0];for(const id of sortedIds(s.players)){const p=s.players[id]!;scores[p.team]!+=p.score;}
    s.winnerTeam=scores[0]===scores[1]?null:scores[0]!>scores[1]!?0:1;emit(s,"crowd.finished","","",s.winnerTeam??-1);return;
  }
  s.half=2;s.pings=[];pickTasks(s);
  for(const id of sortedIds(s.players)){const p=s.players[id]!;p.role=p.role==="hider"?"spotter":"hider";p.unitId="";p.reconnectAt=s.elapsedTicks;p.survivalTicks=0;p.scanCharges=3;p.scanChargeTicks=0;p.taskId="";p.taskTicks=0;p.burstUntil=0;p.burstReadyAt=s.elapsedTicks;}
  emit(s,"crowd.roles-swapped");
}
export function stepCrowd(previous:CrowdState,ctx:CrowdContext):CrowdState {
  const tick=ctx.tick??previous.tick+1;if(previous.version!==1||!Number.isSafeInteger(tick)||tick<=previous.tick)throw new Error("Invalid crowd tick");
  const s:CrowdState={...previous,tick,rng:[...previous.rng],players:Object.fromEntries(sortedIds(previous.players).map(id=>[id,{...previous.players[id]!}])),activeTasks:[...previous.activeTasks],retiredUnitIds:[...(previous.retiredUnitIds??[])],pings:previous.pings.map(p=>({...p})),events:[]};
  if(s.phase==="finished"||ctx.paused)return s;s.elapsedTicks++;combat(s,ctx);attachUnits(s,ctx);
  for(const id of sortedIds(s.players)){const p=s.players[id]!,input=ctx.inputs?.[id]??{};if(p.role==="hider")hider(s,p,ctx,input);else spotter(s,p,ctx,input);}
  for(const ping of s.pings)if(ping.due<=s.elapsedTicks)emit(s,"crowd.corner-ping","",ping.taskId);
  s.pings=s.pings.filter(p=>p.due>s.elapsedTicks);
  if(s.elapsedTicks%CROWD_RULES.halfTicks===0)finishHalf(s);
  return s;
}
export function crowdSpeedLimit(state:CrowdState,playerId:string):number {
  const p=state.players[playerId];return p?.role==="hider"?(p.burstUntil>state.elapsedTicks?3:1.6):Infinity;
}
