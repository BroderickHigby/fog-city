import type { Assets } from "../io/assets.ts";
import type { CombatState } from "../sim/combat-contract.ts";

type Sound="spray"|"splash"|"melt-fizz"|"rust-creak"|"moat-jingle";
/** Existing licensed sound assets, bounded voices, and explicit user-gesture unlock. */
export class GameAudio {
  private readonly samples=new Map<Sound,HTMLAudioElement>();
  private readonly urls:string[]=[];
  private readonly voices:HTMLAudioElement[]=[];
  private enabled=false;
  private volume=.45;
  private lastEvent=0;
  private spraying=false;
  async load(assets:Assets):Promise<void>{
    await Promise.all((["spray","splash","melt-fizz","rust-creak","moat-jingle"] as const).map(async id=>{
      const bytes=await assets.bytes(`audio/${id}.ogg`),url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:"audio/ogg"}));
      this.urls.push(url);const sample=new Audio(url);sample.preload="auto";sample.volume=this.volume;sample.loop=id==="spray";this.samples.set(id,sample);
    }));
  }
  unlock():void {this.enabled=true;if(this.spraying)this.play("spray");}
  setVolume(volume:number):void{this.volume=Number.isFinite(volume)?Math.max(0,Math.min(1,volume)):.45;for(const sample of this.samples.values())sample.volume=this.volume;for(const voice of this.voices)voice.volume=this.volume;}
  private play(id:Sound):void {
    if(!this.enabled)return;const source=this.samples.get(id);if(!source)return;
    if(id==="spray"){if(source.paused)void source.play().catch(()=>{});return;}
    while(this.voices.length>=6)this.voices.shift()?.pause();const voice=source.cloneNode() as HTMLAudioElement;voice.volume=this.volume;this.voices.push(voice);void voice.play().catch(()=>{});
  }
  /** Reset event cursors when switching between isolated simulations or loading a save. */
  reset(state?:CombatState):void{this.lastEvent=Math.max(0,(state?.nextId??1)-1);this.spraying=false;for(const sample of this.samples.values())sample.pause();for(const voice of this.voices)voice.pause();this.voices.length=0;}
  update(state:CombatState|undefined,playerId:string,muted:boolean):void{
    const spraying=!muted&&!!state?.projectiles.some(p=>p.ownerId===playerId&&p.kind==="water"&&p.bornTick>=state.tick-12);
    if(spraying&&!this.spraying)this.play("spray");if(!spraying&&this.spraying)this.samples.get("spray")?.pause();this.spraying=spraying;
    for(const event of state?.events??[]){if(event.id<=this.lastEvent)continue;this.lastEvent=event.id;if(muted)continue;if(event.kind==="robot.heap")this.play("melt-fizz");else if(event.kind==="robot.seized")this.play("rust-creak");}
  }
  dispose():void{for(const sample of this.samples.values())sample.pause();for(const voice of this.voices)voice.pause();for(const url of this.urls)URL.revokeObjectURL(url);this.samples.clear();this.voices.length=0;this.urls.length=0;}
}
