import type { ProgressionDocument, SaveStore } from "./store.ts";

/** Called from the host after sim steps; this clock never drives the simulation. */
export class Autosave {
  private lastTick=0;
  private checkpoint="";
  private pending:Promise<unknown>|undefined;
  private dirty=false;
  private readonly store:SaveStore;
  private readonly capture:()=>ProgressionDocument;
  private readonly failed:(error:unknown)=>void;
  constructor(store:SaveStore,capture:()=>ProgressionDocument,failed:(error:unknown)=>void=()=>{}){this.store=store;this.capture=capture;this.failed=failed;}
  observe(tick:number,checkpoint:string):void {
    if(!Number.isSafeInteger(tick)||tick<0)return;
    if(tick<this.lastTick){this.lastTick=tick;this.checkpoint=checkpoint;return;}
    if(checkpoint===this.checkpoint&&tick-this.lastTick<18000)return;
    this.lastTick=tick;this.checkpoint=checkpoint;this.flush();
  }
  flush():void {if(this.pending){this.dirty=true;return;}this.dirty=false;this.pending=this.store.save("auto",this.capture()).catch(this.failed).finally(()=>{this.pending=undefined;if(this.dirty)this.flush();});}
}
