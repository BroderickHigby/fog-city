import { agentsOf, type AgentKind, type AgentState } from "../sim/agents.ts";
import type { SimState } from "../sim/contract.ts";

interface RuntimeVisualActor {readonly id:string;readonly numericId:number;readonly legacyId:number|null;readonly model:string;readonly x:number;readonly y:number;readonly z:number;readonly heading:number;readonly speed:number;readonly retired:boolean;readonly fidelity:string;readonly bag?:string;readonly statusLight?:string}
const renderCache=new WeakMap<SimState,SimState>();
function kindFor(model:string):AgentKind {
  if(model==="trundle")return "sidewalkBot";
  if(["robotaxi","van","bus","patrol"].includes(model))return "robotaxi";
  if(["person","walker","associate"].includes(model))return "person";
  return "errandRobot";
}
/** Adapt accepted runtime poses to the existing instanced models, solely for drawing. */
export function renderWithRuntimeActors(state:SimState,actors:readonly RuntimeVisualActor[]):SimState {
  const cached=renderCache.get(state);if(cached)return cached;
  const metadata=new Map(actors.map(actor=>[actor.legacyId??actor.numericId,actor]));
  const decorate=(agent:AgentState,actor:RuntimeVisualActor|undefined)=>({...agent,tell:actor?.bag==="empty"?"emptyBag":"fullBag",visualFlash:actor?.statusLight==="flicker",visualHeightScale:actor?state.ext.combat?.targets[actor.id]?.heightScale??1:1});
  const extras:AgentState[]=actors.filter(actor=>actor.legacyId===null&&!actor.retired&&["full","active"].includes(actor.fidelity)).map(actor=>({
    id:actor.numericId,kind:kindFor(actor.model),x:actor.x,y:actor.y,z:actor.z,heading:actor.heading,pitch:0,speed:actor.speed,vmax:Math.abs(actor.speed),
    edge:"",dir:1,lane:1,s:0,next:"",ndir:1,nlane:1,conn:null,node:"",resume:0,lat:0,wait:0,dwell:0,ghost:0,mode:Math.abs(actor.speed)<.05?"wait":"go",rng:1,dodge:null,
  }));
  if(!actors.length)return state;
  const list=[...agentsOf(state),...extras].map(agent=>decorate(agent,metadata.get(agent.id))).sort((a,b)=>a.id-b.id);
  const original=state.ext.agents as {nextId?:number}|undefined;
  const rendered={...state,ext:{...state.ext,agents:{nextId:original?.nextId??1,list}}};renderCache.set(state,rendered);return rendered;
}
