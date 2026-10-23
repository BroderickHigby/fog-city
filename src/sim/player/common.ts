import { clamp } from "../dmath.ts";
import type { GameplayBody,GameplayCommand,GameplayContext,GameplayEvent,GameplayFact,Position } from "./types.ts";

export const MAX_HISTORY=4096;
export const TICKS=60;
export function compare(a:string,b:string):number{return a<b?-1:a>b?1:0;}
export function distanceSquared(a:Position,b:Position):number {const x=a.x-b.x,y=a.y-b.y,z=a.z-b.z;return x*x+y*y+z*z;}
export function bodyOf(ctx:GameplayContext,id:string):GameplayBody|undefined{return ctx.bodies.find(body=>body.id===id);}
export function sortedBodies(ctx:GameplayContext):GameplayBody[]{return [...ctx.bodies].sort((a,b)=>compare(a.id,b.id));}
export function validId(id:unknown):id is string{return typeof id==="string"&&id.length>0&&id.length<=128&&!Object.hasOwn(Object.prototype,id)&&id!=="prototype";}
export function commands(ctx:GameplayContext,id:string,kinds:readonly GameplayCommand["kind"][],after:number):GameplayCommand[]{
  return ctx.commands.filter(command=>command.playerId===id&&kinds.includes(command.kind)&&Number.isSafeInteger(command.sequence)&&command.sequence>after)
    .sort((a,b)=>a.sequence-b.sequence||compare(a.kind,b.kind));
}
export function facts(ctx:GameplayContext,tick:number,cursors:Record<string,number>):GameplayFact[]{
  const after={...cursors};
  const key=(fact:GameplayFact)=>`${fact.source}:${fact.id.split(":",1)[0]}`;
  const out=ctx.facts.filter(fact=>fact.tick===tick&&validId(fact.id)&&["combat","agents","world","modes"].includes(fact.source)&&Number.isSafeInteger(fact.sequence)&&fact.sequence>0&&fact.sequence>(after[key(fact)]??0))
    .sort((a,b)=>compare(key(a),key(b))||a.sequence-b.sequence||compare(a.id,b.id));
  return out.filter(fact=>{const cursor=key(fact);if(fact.sequence<=(cursors[cursor]??0))return false;cursors[cursor]=fact.sequence;return true;});
}
export function event(state:{tick:number;nextId:number;events:GameplayEvent[]},kind:string,playerId:string,targetId="",amount=0,detail=""):GameplayEvent {
  const value={id:state.nextId++,tick:state.tick,kind,playerId,targetId,amount,detail};state.events.push(value);return value;
}
export function bounded(value:number,min:number,max:number):number{return Number.isFinite(value)?clamp(value,min,max):min;}
export function finiteContext(ctx:GameplayContext):void {
  if(ctx.bodies.length>64||ctx.facts.length>8192||ctx.commands.length>1024)throw new Error("Gameplay context exceeds its tick budget");
  const ids=new Set<string>();
  for(const body of ctx.bodies){if(!validId(body.id)||ids.has(body.id)||![body.x,body.y,body.z,body.speed].every(Number.isFinite))throw new Error("Gameplay body must have a unique ID and finite pose");ids.add(body.id);}
}
export function cloneEvents<T extends {tick:number;nextId:number;events:GameplayEvent[]}>(state:T,tick:number):T {return {...state,tick,events:[]};}
