import { SIM_VERSION } from "../sim/contract.ts";

export type SaveSlot=0|1|2|"auto";
export const SAVE_SLOTS:readonly SaveSlot[]=[0,1,2,"auto"];
export const SAVE_SCHEMA_VERSION=1;
export type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
export type ProgressionDocument=Readonly<Record<string,Json>>;
export interface SaveBackend {readonly name:string;read(key:string):Promise<string|null>;write(key:string,value:string):Promise<void>;remove(key:string):Promise<void>}
export interface SaveEnvelope {readonly schemaVersion:number;readonly simVersion:number;readonly contentHash:string;readonly savedAt:number;readonly data:ProgressionDocument;readonly checksum:string}
export class SaveError extends Error {
  readonly code:"invalid"|"incompatible"|"unavailable";
  constructor(code:SaveError["code"],message:string){super(message);this.name="SaveError";this.code=code;}
}
const ALLOWED_ROOT=new Set(["wallet","progression","missions","activities","player","profile","unlockedDistrictIds"]);
const FORBIDDEN=new Set(["__proto__","constructor","prototype","ext","players","agents","projectiles","bodies","rng","traffic"]);
const LIMIT=1024*1024;

/** A persistence DTO, never a mid-action SimState. Domain validators run after this gate. */
export function assertProgressionDocument(value:unknown):asserts value is ProgressionDocument {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new SaveError("invalid","Progression must be an object");
  const roots=Object.keys(value);if(!roots.length||roots.some(key=>!ALLOWED_ROOT.has(key)))throw new SaveError("invalid","Save contains transient or unknown state");
  let nodes=0;
  function visit(item:unknown,depth:number):void {
    if(++nodes>50000||depth>12)throw new SaveError("invalid","Save exceeds structural limits");
    if(item===null||typeof item==="boolean")return;
    if(typeof item==="number"){if(!Number.isFinite(item)||Math.abs(item)>Number.MAX_SAFE_INTEGER)throw new SaveError("invalid","Invalid save number");return;}
    if(typeof item==="string"){if(item.length>256)throw new SaveError("invalid","Save text is too long");return;}
    if(Array.isArray(item)){for(const entry of item)visit(entry,depth+1);return;}
    if(typeof item!=="object")throw new SaveError("invalid","Save is not plain JSON");
    const prototype=Object.getPrototypeOf(item);if(prototype!==Object.prototype&&prototype!==null)throw new SaveError("invalid","Save is not a plain object");
    for(const [key,entry]of Object.entries(item)){if(FORBIDDEN.has(key))throw new SaveError("invalid","Save contains transient state");visit(entry,depth+1);}
  }
  visit(value,0);
}
function stable(value:Json):string {
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key]!)}`).join(",")}}`;
}
function checksum(value:string):string {let hash=0x811c9dc5;for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,0x01000193);}return (hash>>>0).toString(16).padStart(8,"0");}
function slotKey(slot:SaveSlot):string {if(!SAVE_SLOTS.includes(slot))throw new SaveError("invalid","Invalid save slot");return `fog-city.progression.${slot}`;}
export interface SaveStoreOptions {
  readonly backends:readonly SaveBackend[];
  readonly contentHash:string;
  /** Clone/project known progression fields and validate IDs/ranges against the loaded catalog. */
  readonly validate:(data:ProgressionDocument)=>ProgressionDocument;
  readonly migrate?:(envelope:SaveEnvelope)=>ProgressionDocument;
  readonly now?:()=>number;
}
export class SaveStore {
  private readonly options:SaveStoreOptions;
  private readonly writes=new Map<SaveSlot,Promise<unknown>>();
  constructor(options:SaveStoreOptions){if(!options.backends.length)throw new SaveError("unavailable","No save backend");this.options=options;}
  private validate(data:unknown):ProgressionDocument {assertProgressionDocument(data);const clean=this.options.validate(data);assertProgressionDocument(clean);return JSON.parse(JSON.stringify(clean)) as ProgressionDocument;}
  private decode(text:string):SaveEnvelope {
    if(new TextEncoder().encode(text).length>LIMIT)throw new SaveError("invalid","Save file is too large");
    let raw:unknown;try{raw=JSON.parse(text);}catch{throw new SaveError("invalid","Save is not valid JSON");}
    if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new SaveError("invalid","Invalid save envelope");
    const value=raw as SaveEnvelope;
    if(Object.keys(value).some(key=>!["schemaVersion","simVersion","contentHash","savedAt","data","checksum"].includes(key))||!Number.isSafeInteger(value.schemaVersion)||value.schemaVersion<1||!Number.isSafeInteger(value.simVersion)||value.simVersion<1||!Number.isSafeInteger(value.savedAt)||value.savedAt<0||typeof value.contentHash!=="string"||value.contentHash.length>256||typeof value.checksum!=="string")throw new SaveError("invalid","Invalid save metadata");
    assertProgressionDocument(value.data);
    const {checksum:expected,...body}=value;if(checksum(stable(body as unknown as Json))!==expected)throw new SaveError("invalid","Save checksum mismatch");
    if(value.schemaVersion!==SAVE_SCHEMA_VERSION&&!this.options.migrate)throw new SaveError("incompatible","Unsupported progression version");
    const data=this.validate(value.schemaVersion===SAVE_SCHEMA_VERSION?value.data:this.options.migrate!(value));
    const canonical={schemaVersion:SAVE_SCHEMA_VERSION,simVersion:value.simVersion,contentHash:this.options.contentHash,savedAt:value.savedAt,data};
    return {...canonical,checksum:checksum(stable(canonical as unknown as Json))};
  }
  async save(slot:SaveSlot,data:ProgressionDocument):Promise<{envelope:SaveEnvelope;localOnly:boolean}> {
    const clean=this.validate(data),savedAt=(this.options.now??Date.now)();
    if(!Number.isSafeInteger(savedAt)||savedAt<0)throw new SaveError("invalid","Invalid save clock");
    const body={schemaVersion:SAVE_SCHEMA_VERSION,simVersion:SIM_VERSION,contentHash:this.options.contentHash,savedAt,data:clean};
    const envelope:SaveEnvelope={...body,checksum:checksum(stable(body as unknown as Json))};
    const text=JSON.stringify(envelope);if(new TextEncoder().encode(text).length>LIMIT)throw new SaveError("invalid","Save file is too large");
    const key=slotKey(slot),before=this.writes.get(slot)??Promise.resolve();
    const operation=before.catch(()=>{}).then(async()=>{
      const results=await Promise.allSettled(this.options.backends.map(backend=>backend.write(key,text)));
      if(!results.some(result=>result.status==="fulfilled"))throw new SaveError("unavailable","Every save backend failed");
      return {envelope,localOnly:results[0]?.status!=="fulfilled"};
    });
    this.writes.set(slot,operation);try{return await operation;}finally{if(this.writes.get(slot)===operation)this.writes.delete(slot);}
  }
  async load(slot:SaveSlot):Promise<SaveEnvelope|null> {
    await this.writes.get(slot)?.catch(()=>{});
    const reads=await Promise.allSettled(this.options.backends.map(backend=>backend.read(slotKey(slot))));
    const valid:SaveEnvelope[]=[];let failure:unknown;
    for(const result of reads){if(result.status==="rejected"){failure=result.reason;continue;}if(result.value===null)continue;try{valid.push(this.decode(result.value));}catch(error){failure=error;}}
    if(valid.length)return valid.sort((a,b)=>b.savedAt-a.savedAt)[0]!;
    if(failure)throw failure instanceof SaveError?failure:new SaveError("unavailable","Save backends unavailable");return null;
  }
  async list():Promise<readonly {slot:SaveSlot;save:SaveEnvelope|null}[]> {return Promise.all(SAVE_SLOTS.map(async slot=>({slot,save:await this.load(slot)})));}
  async export(slot:SaveSlot):Promise<string> {const value=await this.load(slot);if(!value)throw new SaveError("invalid","Save slot is empty");return JSON.stringify(value,null,2);}
  /** Confirmation happens after validation, before the first write. No current game state is touched. */
  async import(slot:SaveSlot,text:string,confirm:(save:SaveEnvelope)=>boolean|Promise<boolean>):Promise<boolean> {
    const value=this.decode(text);if(!await confirm(value))return false;await this.save(slot,value.data);return true;
  }
}

export class MemorySaveBackend implements SaveBackend {
  readonly name="memory";private readonly data=new Map<string,string>();
  async read(key:string):Promise<string|null>{return this.data.get(key)??null;}
  async write(key:string,value:string):Promise<void>{this.data.set(key,value);}
  async remove(key:string):Promise<void>{this.data.delete(key);}
}
