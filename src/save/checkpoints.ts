import { CAMPAIGN_MISSIONS } from '../content/catalog.ts';
import { SIM_VERSION,type SimState } from '../sim/contract.ts';
import { campaignOf,type MissionRun } from '../sim/missions/runtime.ts';
let hash=2166136261;for(const ch of JSON.stringify(CAMPAIGN_MISSIONS)){hash=Math.imul(hash^ch.charCodeAt(0),16777619);}
export const CHECKPOINT_CONTENT=(hash>>>0).toString(16);
export interface Checkpoint {version:1;simVersion:number;contentId:string;world:string;completed:string[];cash:number;unlocks:string[]}
export interface SaveStore {load(world:string):Promise<unknown>;save(world:string,value:Checkpoint):Promise<void>}
const validUnlocks=new Set(['startup:mobility','startup:climate','startup:community',...CAMPAIGN_MISSIONS.flatMap(m=>m.steps.flatMap(s=>s.type==='reward'?s.grants.flatMap(g=>g.kind==='unlock'?[g.unlock]:[]):[]))]);
const keys=['version','simVersion','contentId','world','completed','cash','unlocks'];
/** Strict, progression-only boundary. A save never restores actors, heat, position or projectiles. */
export function readCheckpoint(value:unknown,world:string):Checkpoint|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k))||v.version!==1||!Number.isInteger(v.simVersion)||(v.simVersion as number)<1||(v.simVersion as number)>SIM_VERSION||v.contentId!==CHECKPOINT_CONTENT||v.world!==world)return null;
 if(!Array.isArray(v.completed)||!v.completed.length||v.completed.length>CAMPAIGN_MISSIONS.length||v.completed.some((id,i)=>id!==CAMPAIGN_MISSIONS[i]?.id))return null;
 if(!Number.isSafeInteger(v.cash)||(v.cash as number)<0||(v.cash as number)>1000000000||!Array.isArray(v.unlocks)||v.unlocks.length>128||v.unlocks.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9:_-]{1,120}$/.test(id)||!validUnlocks.has(id)))return null;
 return {version:1,simVersion:SIM_VERSION,contentId:CHECKPOINT_CONTENT,world,completed:[...v.completed] as string[],cash:v.cash as number,unlocks:[...new Set(v.unlocks)] as string[]};
}
export function checkpointOf(state:Readonly<SimState>,id:string,world:string):Checkpoint|null{
 const run=campaignOf(state)?.players[id];if(!run||run.status!=='success')return null;
 return readCheckpoint({version:1,simVersion:SIM_VERSION,contentId:CHECKPOINT_CONTENT,world,completed:run.completed,cash:run.cash,unlocks:run.unlocks},world);
}
export function restoreCheckpoint(state:SimState,id:string,checkpoint:Checkpoint):SimState {
 const mission=CAMPAIGN_MISSIONS[checkpoint.completed.length-1];if(!mission||!state.players[id])return state;
 const run:MissionRun={missionId:mission.id,stepId:mission.steps.find(s=>s.type==='reward')?.id??mission.steps.at(-1)!.id,entered:state.tick,question:0,watchTicks:0,cash:checkpoint.cash,completed:[...checkpoint.completed],unlocks:[...checkpoint.unlocks],meters:{},sequence:0,status:'success',line:null,threat:0,unseenTicks:0,counted:[],reply:''};
 return {...state,ext:{...state.ext,missions:{players:{[id]:run},actors:{}} as unknown as import("../sim/extensions.ts").JsonObject}};
}
/** IndexedDB backend; failures are reported by the caller and never stop play. */
export class BrowserSaveStore implements SaveStore {
 private db:Promise<IDBDatabase>;
 constructor(factory:IDBFactory=indexedDB){this.db=new Promise((resolve,reject)=>{const req=factory.open('fog-city-progression',1);req.onupgradeneeded=()=>req.result.createObjectStore('checkpoints');req.onsuccess=()=>{req.result.onversionchange=()=>req.result.close();resolve(req.result);};req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('Checkpoint store is busy in another tab'));});}
 async load(world:string):Promise<unknown>{const db=await this.db;return new Promise((resolve,reject)=>{const tx=db.transaction('checkpoints','readonly'),req=tx.objectStore('checkpoints').get(world);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);tx.onabort=()=>reject(tx.error);});}
 async save(world:string,value:Checkpoint):Promise<void>{const db=await this.db;return new Promise((resolve,reject)=>{const tx=db.transaction('checkpoints','readwrite');tx.objectStore('checkpoints').put(value,world);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
}
