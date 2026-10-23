import type {SimState} from "../contract.ts";
import type {MaintenanceRequest} from "../combat-contract.ts";
import {circleBlocked,groundHeight,type World} from "../world.ts";
import {dcos,dsin,PI} from "../dmath.ts";
import {isGameplayId} from "../gameplay-contract.ts";
import {agentsRuntimeOf,type RuntimeMovementGoal,type RuntimeSpawn} from "./runtime.ts";
import type {ActorBlueprint} from "./mission-actors.ts";
export interface MaintenanceJob {sequence:number;actorId:string;phase:"collect"|"carry"|"restore"|"readmit";kioskId:string;sourcePlayerId?:string;requestId?:string}
export interface MaintenanceRuntimeState {version:1;tick:number;jobs:Record<string,MaintenanceJob>;requests:MaintenanceRequest[];kiosks:{id:string;x:number;y:number;z:number}[]}
export interface MaintenanceFrame {state:MaintenanceRuntimeState;spawns:ActorBlueprint[];goals:Record<string,RuntimeMovementGoal>;restorationPoints:Record<string,{x:number;y:number;z:number}>}
const distance=(a:{x:number;z:number},b:{x:number;z:number})=>Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.z-b.z)*(a.z-b.z));
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Tasks propose travel and sustained work intent; combat alone times and validates maintenance. */
export function planMaintenanceRuntime(world:World,sim:Readonly<SimState>,previous?:MaintenanceRuntimeState,reserved:readonly RuntimeSpawn[]=[]):MaintenanceFrame {
 const runtime=agentsRuntimeOf(sim),actors=Object.keys(runtime?.actors??{}).sort().map(id=>runtime!.actors[id]!);
 const kiosks=(world.gameplay?.anchors??[]).filter(anchor=>anchor.kind==="repair-kiosk").map(anchor=>({id:anchor.id,x:anchor.x,y:anchor.y,z:anchor.z})).sort((a,b)=>compare(a.id,b.id));
 const jobs:Record<string,MaintenanceJob>={};for(const id of Object.keys(previous?.jobs??{}).sort())jobs[id]={...previous!.jobs[id]!};
 const repairRequests:{id:string;actorId:string;playerId:string;kioskId:string;requestTick:number}[]=[];
 for(const event of sim.ext.activities?.events??[]){
  if(event.kind!=="activity.repair-request")continue;
  let request:Record<string,unknown>;try{request=JSON.parse(event.detail) as Record<string,unknown>;}catch{continue;}
  if(!request||!isGameplayId(request.id)||!isGameplayId(request.actorId)||!isGameplayId(request.playerId)||!isGameplayId(request.kioskId)||request.actorId!==event.targetId||request.playerId!==event.playerId||!Number.isSafeInteger(request.requestTick)||(request.requestTick as number)<0||(request.requestTick as number)>sim.tick||!sim.players[request.playerId])continue;
  const target=sim.ext.combat?.targets[request.actorId];
  if(!target?.repair||target.sourceId!==request.playerId)continue;
  repairRequests.push({id:request.id,actorId:request.actorId,playerId:request.playerId,kioskId:request.kioskId,requestTick:request.requestTick as number});
 }
 repairRequests.sort((a,b)=>a.requestTick-b.requestTick||compare(a.id,b.id));
 const state:MaintenanceRuntimeState={version:1,tick:sim.tick,jobs,requests:[],kiosks:[]},frame:MaintenanceFrame={state,spawns:[],goals:{},restorationPoints:{}};
 const people=Object.keys(sim.players).sort().flatMap(id=>{const p=sim.players[id]!;return [{...p.car,radius:2.5},...(p.foot?[{...p.foot,radius:.4}]:[])];});
 const clear=(point:{x:number;z:number},radius:number,ignore:string[]=[])=>!circleBlocked(world,point.x,point.z,radius)&&[...actors.filter(a=>!a.retired&&!ignore.includes(a.id)),...people,...reserved,...frame.spawns].every(a=>distance(a,point)>radius+(a.radius??.4)+.15);
 for(const kiosk of kiosks){
  if(frame.spawns.length+actors.filter(a=>a.model==="tidy"&&!a.posted).length>=8)break;
  const id=`tidy:${kiosk.id}`;if(!isGameplayId(id)||runtime?.actors[id]||reserved.some(actor=>actor.id===id)||!people.some(p=>distance(p,kiosk)<180))continue;
  for(let i=0;i<16;i++){const angle=i*2*PI/16,point={x:kiosk.x+dsin(angle)*3.5,z:kiosk.z+dcos(angle)*3.5};if(clear(point,.45)){frame.spawns.push({id,model:"tidy",firmware:"good",...point,y:groundHeight(world,point.x,point.z),heading:0,radius:.45,height:1.8,significant:true});break;}}
 }
 for(const worker of actors.filter(a=>a.model==="tidy"&&!a.retired&&!a.posted&&a.firmware==="good")){
  let job=jobs[worker.id];
  if(job){
   if(runtime?.events.some(e=>e.kind==="actor.restored"&&e.actorId===job!.actorId)){delete jobs[worker.id];job=undefined;}
   else for(const event of sim.ext.combat?.events??[]){
    if(event.sourceId!==worker.id||event.targetId!==job.actorId)continue;
    if(event.kind==="robot.heap-cleared"&&job.phase==="collect"){if(sim.ext.combat?.targets[job.actorId]?.converted||sim.ext.combat?.targets[job.actorId]?.repair){job.phase="carry";job.sequence++;}else {delete jobs[worker.id];job=undefined;break;}}
    if(event.kind==="robot.restored")job.phase="readmit";
   }
  }
  if(!job){
   const claimed=new Set(Object.keys(jobs).map(id=>jobs[id]!.actorId));
   const target=actors.filter(a=>a.id!==worker.id&&!a.retired&&!a.protected&&!claimed.has(a.id)&&a.model!=="person"&&a.model!=="associate"&&a.model!=="dog"&&a.model!=="pigeon"&&a.model!=="robotaxi"&&a.model!=="van"&&a.model!=="bus"&&distance(worker,a)<120&&(sim.ext.combat?.targets[a.id]?.phase==="heap"||sim.ext.combat?.targets[a.id]?.repair===true)).sort((a,b)=>distance(worker,a)-distance(worker,b)||compare(a.id,b.id))[0];
   if(!target)continue;
   const kiosk=[...kiosks].sort((a,b)=>distance(worker,a)-distance(worker,b)||compare(a.id,b.id))[0];if(!kiosk)continue;
   job={sequence:(sim.ext.combat?.maintenanceSequence?.[worker.id]??0)+1,actorId:target.id,phase:sim.ext.combat?.targets[target.id]?.phase==="heap"?"collect":"restore",kioskId:kiosk.id};jobs[worker.id]=job;
  }
  const repair=repairRequests.find(request=>request.actorId===job!.actorId&&kiosks.some(k=>k.id===request.kioskId));
  if(repair&&!job.sourcePlayerId){job.sourcePlayerId=repair.playerId;job.requestId=repair.id;job.kioskId=repair.kioskId;}
  const target=runtime?.actors[job.actorId],kiosk=kiosks.find(k=>k.id===job.kioskId);
  if(!target||!kiosk){delete jobs[worker.id];continue;}
  if(job.phase==="collect")frame.goals[worker.id]={x:target.x,z:target.z,speed:1.4,stopDistance:2};
  else {
   frame.goals[worker.id]={x:kiosk.x,z:kiosk.z,speed:1.4,stopDistance:1.8};
   if(job.phase==="carry"&&distance(worker,kiosk)<=2.2)job.phase="restore";
   for(let ring=1;ring<=2;ring++)for(let i=0;i<16;i++){
    const angle=i*2*PI/16,point={x:kiosk.x+dsin(angle)*ring*.9,z:kiosk.z+dcos(angle)*ring*.9};
    if(!frame.restorationPoints[target.id]&&distance(worker,point)<2.9&&clear(point,target.radius,[target.id]))frame.restorationPoints[target.id]={...point,y:groundHeight(world,point.x,point.z)};
   }
  }
  if(job.phase!=="readmit")state.requests.push({id:`maintenance:${worker.numericId}:${job.sequence}`,sequence:job.sequence,kind:job.phase==="collect"?"collect-heap":"restore",workerId:worker.id,actorId:target.id,...(job.phase!=="collect"?{kioskId:kiosk.id}:{})});
 }
 const requestedKiosks=new Set(state.requests.map(request=>request.kioskId));state.kiosks=kiosks.filter(kiosk=>requestedKiosks.has(kiosk.id));
 return frame;
}
