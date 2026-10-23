import { agentsOf, type AgentKind, type AgentState } from "../sim/agents.ts";
import type { SimState } from "../sim/contract.ts";
import type { TargetCombat } from "../sim/combat-contract.ts";
import { EFFECTS } from "../sim/combat/effects.ts";

/** A robot reads wet this long after water last hit it (ticks), fading out. */
export const ROBOT_WET_TICKS = 180;
/** A soaked person's wetness fades over the last this many ticks of it. */
export const PERSON_WET_FADE_TICKS = 60;

/**
 * The combat presentation of one target at `tick` (render-only): rust as the sim holds it, how
 * wet it reads, and how far it has toppled (0 until it seizes, rising over the sim's slump to 1
 * as a heap). Pure: the same state draws the same way.
 */
export function combatLook(t: Readonly<TargetCombat> | undefined, tick: number, person: boolean): { rust: number; wet: number; topple: number } {
  if (!t) return { rust: 0, wet: 0, topple: 0 };
  const wet = person
    ? t.wetUntil > tick ? Math.min(1, (t.wetUntil - tick) / PERSON_WET_FADE_TICKS) : 0
    : Math.max(0, 1 - (tick - t.lastWaterTick) / ROBOT_WET_TICKS);
  const age = tick - t.phaseTick;
  const topple =
    t.phase === "slumping" ? Math.max(0, Math.min(1, (age - EFFECTS.seizedTicks) / (EFFECTS.collapseTicks - EFFECTS.seizedTicks))) :
    t.phase === "heap" || t.phase === "cleared" ? 1 : 0;
  return { rust: person ? 0 : Math.max(0, Math.min(1, t.rust)), wet, topple };
}

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
  const decorate=(agent:AgentState,actor:RuntimeVisualActor|undefined)=>{
    const target=actor?state.ext.combat?.targets[actor.id]:undefined;
    const look=combatLook(target,state.tick,agent.kind==="person");
    return {...agent,tell:actor?.bag==="empty"?"emptyBag":"fullBag",visualFlash:actor?.statusLight==="flicker",visualHeightScale:target?.heightScale??1,visualRust:look.rust,visualWet:look.wet,visualTopple:look.topple};
  };
  const extras:AgentState[]=actors.filter(actor=>actor.legacyId===null&&!actor.retired&&["full","active"].includes(actor.fidelity)).map(actor=>({
    id:actor.numericId,kind:kindFor(actor.model),x:actor.x,y:actor.y,z:actor.z,heading:actor.heading,pitch:0,speed:actor.speed,vmax:Math.abs(actor.speed),
    edge:"",dir:1,lane:1,s:0,next:"",ndir:1,nlane:1,conn:null,node:"",resume:0,lat:0,wait:0,dwell:0,ghost:0,mode:Math.abs(actor.speed)<.05?"wait":"go",rng:1,dodge:null,
  }));
  if(!actors.length)return state;
  const list=[...agentsOf(state),...extras].map(agent=>decorate(agent,metadata.get(agent.id))).sort((a,b)=>a.id-b.id);
  const original=state.ext.agents as {nextId?:number}|undefined;
  const rendered={...state,ext:{...state.ext,agents:{nextId:original?.nextId??1,list}}};renderCache.set(state,rendered);return rendered;
}
