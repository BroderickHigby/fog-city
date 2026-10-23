import { voiceFiles, voiceKey } from "./voice-files.ts";
import type { Assets } from '../io/assets.ts';
/** Audio begins only after the player's gesture; browser speech is a fallback to rendered dialogue. */
export class AudioDirector {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private voice: AudioBufferSourceNode | null = null;
  private voiceGain: GainNode | null = null;
  private effects:GainNode|null=null;
  private radioMuted=false;
  private loading=false;
  private lastEffect=0;
  private effectTick=-1;
  private source: AudioBufferSourceNode | null = null;
  private started = false;
  private muted = false;
  private speaking = false;
  private lastLine = '';
  private generation = 0;
  private readonly assets: Assets;
  constructor(assets: Assets) {
    this.assets=assets;
    document.addEventListener('visibilitychange',()=>{if(this.started&&this.context){if(document.hidden)void this.context.suspend();else void this.context.resume();}});
  }
  async enable():Promise<void>{
    if(this.context){await this.context.resume();this.started=true;return;}
    const ctx=new AudioContext();this.context=ctx;this.gain=ctx.createGain();this.gain.gain.value=0.27;this.gain.connect(ctx.destination);this.voiceGain=ctx.createGain();this.voiceGain.connect(ctx.destination);
    this.effects=ctx.createGain();this.effects.gain.value=.16;this.effects.connect(ctx.destination);
    await ctx.resume();this.started=true;
  }
  async start():Promise<void>{
    await this.enable();const ctx=this.context!;if(this.source||this.loading)return;this.loading=true;
    try {const bytes=await this.assets.bytes('audio/music/neon-tide.ogg');const buffer=await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);if(!this.started)return;const source=ctx.createBufferSource();source.buffer=buffer;source.loop=true;source.connect(this.gain!);source.start();this.source=source;this.level();}
    catch(error){console.warn('Radio unavailable:',error);}finally{this.loading=false;}
  }
  setRadioMuted(muted:boolean):void{this.radioMuted=muted;this.level();}
  effect(kind:string):void{
    const ctx=this.context;if(!ctx||!this.effects||this.muted||!this.started)return;
    const oscillator=ctx.createOscillator(),volume=ctx.createGain();const spray=kind==="weapon.water";
    oscillator.type=spray?"triangle":"sine";const frequency=spray?180:kind==="scan.result"?760:kind==="refill.complete"?520:240;
    oscillator.frequency.setValueAtTime(frequency,ctx.currentTime);oscillator.frequency.exponentialRampToValueAtTime(frequency*(spray?.5:1.6),ctx.currentTime+.09);volume.gain.setValueAtTime(.001,ctx.currentTime);volume.gain.exponentialRampToValueAtTime(.2,ctx.currentTime+.006);volume.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.13);oscillator.connect(volume);volume.connect(this.effects);oscillator.start();oscillator.stop(ctx.currentTime+.15);oscillator.onended=()=>{oscillator.disconnect();volume.disconnect();};
  }
  feedback(tick:number,events:readonly {id:number;sourceId:string;kind:string}[],id:string):void{if(tick<this.effectTick)this.lastEffect=0;this.effectTick=tick;for(const event of events){if(event.id<=this.lastEffect)continue;this.lastEffect=event.id;if(event.sourceId===id&&["weapon.water","scan.result","refill.complete","robot.heap"].includes(event.kind))this.effect(event.kind);}}
  setMuted(muted:boolean):void {this.muted=muted;if(this.effects)this.effects.gain.value=muted?0:.16;if(this.voiceGain)this.voiceGain.gain.value=muted?0:1;this.level();if(muted&&'speechSynthesis'in window)window.speechSynthesis.cancel();}
  private level():void {if(this.context&&this.gain)this.gain.gain.setTargetAtTime(this.muted||this.radioMuted?0:this.speaking?0.07:0.27,this.context.currentTime,0.2);}
  setThreat(level:number):void {if(this.source&&this.context)this.source.playbackRate.setTargetAtTime(level>0?1.04:1,this.context.currentTime,2);}
  async speak(speaker:string,text:string):Promise<void> {
    if(!this.started||this.muted||!text||this.lastLine===speaker+text)return;
    this.lastLine=speaker+text;this.voice?.stop();this.voice=null;const generation=++this.generation;
    const file=voiceFiles[voiceKey(speaker,text)];
    if(file&&this.context&&this.gain){
      try{const bytes=await this.assets.bytes(file);if(generation!==this.generation)return;const buffer=await this.context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);if(generation!==this.generation)return;const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.voiceGain!);this.voice=source;this.speaking=true;this.level();source.onended=()=>{if(generation===this.generation){this.speaking=false;this.level();}};source.start();return;}catch(error){console.warn('Voice asset unavailable',error);}
    }
    if(!('speechSynthesis'in window))return;
    window.speechSynthesis.cancel();
    const utterance=new SpeechSynthesisUtterance(text);utterance.lang='en-US';
    const voices=window.speechSynthesis.getVoices().filter(v=>v.lang.startsWith('en'));
    const slot=speaker==='dispatch'?1:speaker==='host'?2:0;
    utterance.voice=voices[slot%Math.max(1,voices.length)]??null;
    utterance.rate=speaker==='dispatch'?1.02:speaker==='cofounder'?1.1:0.96;
    utterance.pitch=speaker==='dispatch'?0.8:speaker==='host'?1.05:1;
    this.speaking=true;this.level();
    const end=()=>{if(generation===this.generation){this.speaking=false;this.level();}};
    utterance.onend=end;utterance.onerror=end;window.speechSynthesis.speak(utterance);
  }
  dispose():void {this.started=false;this.source?.stop();void this.context?.close();if('speechSynthesis'in window)window.speechSynthesis.cancel();}
}
