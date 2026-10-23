import {isGameplayId} from "../gameplay-contract.ts";
import {ROBOTAXI_BODY,agentsOf} from "../agents.ts";
import {boxDistance} from "../dodge.ts";
import type {SimState} from "../contract.ts";
import {dcos,dsin,PI} from "../dmath.ts";
import {circleBlocked,groundHeight,type World} from "../world.ts";
import {agentsRuntimeOf,type RuntimeSpawn} from "./runtime.ts";
import type {ActorBlueprint} from "./mission-actors.ts";
import type {SidewalkGraph} from "./navigation.ts";
import {serviceRoadPoint} from "./service-runtime.ts";
export interface SceneActor {
 id:string;role:string;model:"van"|"footman"|"person"|"tidy";firmware:"good"|"bad"|"none";
 offset:{x:number;z:number};radius:number;height:number;protected?:boolean;
}
export interface MissionScene {missionId:string;anchor:{x:number;y:number;z:number};actors:SceneActor[]}
const distance=(a:{x:number;z:number},b:{x:number;z:number})=>Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.z-b.z)*(a.z-b.z));
function vehicleBox(other:{x:number;z:number}):{heading:number;hl:number;hw:number}|null {
 const o=other as {kind?:string;model?:string;heading?:number;halfLength?:number;halfWidth?:number};
 if(o.kind!=="robotaxi"&&o.halfLength===undefined&&o.model!=="van"&&o.model!=="bus"&&o.model!=="robotaxi")return null;
 return {heading:o.heading??0,hl:o.halfLength??ROBOTAXI_BODY.halfLength,hw:o.halfWidth??ROBOTAXI_BODY.halfWidth};
}
export function decodeMissionScene(event:{kind:string;detail:string}):MissionScene|null {
 if(event.kind!=="mission.scene-request")return null;
 let value:MissionScene;try{value=JSON.parse(event.detail) as MissionScene;}catch{return null;}
 if(!value||!isGameplayId(value.missionId)||!value.anchor||![value.anchor.x,value.anchor.y,value.anchor.z].every(Number.isFinite)||!Array.isArray(value.actors)||value.actors.length>32)return null;
 const seen=new Set<string>();
 for(const actor of value.actors){
  if(!actor||!isGameplayId(actor.id)||!actor.id.startsWith(`mission:${value.missionId}:`)||seen.has(actor.id)||!isGameplayId(actor.role)||!["van","footman","person","tidy"].includes(actor.model)||!["good","bad","none"].includes(actor.firmware)||!actor.offset||![actor.offset.x,actor.offset.z,actor.radius,actor.height].every(Number.isFinite)||distance(actor.offset,{x:0,z:0})>1000||actor.radius<=0||actor.radius>4||actor.height<=0||actor.height>12||actor.model==="tidy"&&actor.firmware!=="good"||actor.protected!==undefined&&typeof actor.protected!=="boolean")return null;
  seen.add(actor.id);
 }
 return {missionId:value.missionId,anchor:{...value.anchor},actors:value.actors.map(actor=>({...actor,offset:{...actor.offset}}))};
}
/** Scene offsets are search anchors; every resulting body still needs core clearance acceptance. */
export function planSceneActors(world:World,sim:Readonly<SimState>,scene:MissionScene,graph?:SidewalkGraph,reserved:readonly Pick<RuntimeSpawn,"x"|"z"|"radius">[]=[]):{actors:ActorBlueprint[];blocked:string[]} {
 const runtime=agentsRuntimeOf(sim),actors:ActorBlueprint[]=[],blocked:string[]=[];
 const occupied=[...agentsOf(sim),...Object.keys(runtime?.actors??{}).sort().map(id=>runtime!.actors[id]!).filter(actor=>!actor.retired),...reserved,...Object.keys(sim.players).sort().flatMap(id=>{const p=sim.players[id]!;return [{...p.car,radius:2.5},...(p.foot?[{...p.foot,radius:.4}]:[])];})];
 for(const definition of [...scene.actors].sort((a,b)=>a.id<b.id?-1:1)){
  if(runtime?.actors[definition.id])continue;
  const anchor={x:scene.anchor.x+definition.offset.x,z:scene.anchor.z+definition.offset.z};
  const clear=(p:{x:number;z:number})=>!circleBlocked(world,p.x,p.z,definition.radius)&&[...occupied,...actors].every(other=>{
   // A vehicle body (a legacy robotaxi has no radius; a van's or bus's is not its hull) by its box.
   const box=vehicleBox(other);
   return box?boxDistance(p.x,p.z,other.x,other.z,dsin(box.heading),-dcos(box.heading),box.hl,box.hw)>definition.radius+.5:distance(p,other)>definition.radius+("radius" in other&&other.radius||.5)+.5;
  });
  let spot:{x:number;z:number;heading?:number}|undefined;
  if(definition.model==="van")spot=serviceRoadPoint(world,anchor,0,25,0,[...occupied,...actors],2.7,1.1)??undefined;
  else {
   const candidates=(graph?.nodes??[]).filter(node=>distance(anchor,node)<=25).map(node=>({x:node.x,z:node.z})).sort((a,b)=>distance(anchor,a)-distance(anchor,b)||a.x-b.x||a.z-b.z);
   candidates.push(anchor);
   for(let ring=1;ring<=8;ring++)for(let index=0;index<ring*8;index++){const angle=index*2*PI/(ring*8);candidates.push({x:anchor.x+dsin(angle)*ring*3,z:anchor.z+dcos(angle)*ring*3});}
   spot=candidates.find(clear);
  }
  if(!spot){blocked.push(definition.id);continue;}
  actors.push({id:definition.id,model:definition.model,firmware:definition.firmware,x:spot.x,y:groundHeight(world,spot.x,spot.z),z:spot.z,heading:spot.heading??0,radius:definition.radius,height:definition.height,protected:definition.protected??definition.model==="person",significant:true,posted:definition.role!=="unit"});
 }
 return {actors,blocked};
}
