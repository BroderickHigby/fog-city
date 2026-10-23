import { Action, type SimInput } from "../sim/contract.ts";
import type { Keyboard } from "./keyboard.ts";

export type VirtualAction = keyof typeof Action | "brake";
export interface PadLike { readonly connected: boolean; readonly axes: readonly number[]; readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[] }
export function availableGamepads(source:Navigator|undefined=typeof navigator==="undefined"?undefined:navigator):readonly(PadLike|null)[]{try{return source?.getGamepads?.()??[];}catch{return[];}}
const CONTINUOUS = new Set<VirtualAction>(["fire", "scan", "watch", "altFire", "interact", "brake"]);
const PAD_ACTIONS: Readonly<Record<number, VirtualAction>> = { 0:"enterExit", 1:"cone", 2:"gadget", 3:"interact", 4:"watch", 5:"altFire", 7:"fire", 10:"horn", 11:"scan", 12:"gear", 13:"streak" };
const neutral = (): SimInput => ({ throttle:0, steer:0, brake:0, actions:0 });
function axis(v:number):number { return Number.isFinite(v) ? Math.max(-1,Math.min(1,v)) : 0; }
function deadzone(v:number):number { return Math.abs(v)<.16 ? 0 : Math.sign(v)*(Math.abs(axis(v))-.16)/.84; }
function strongest(a:number,b:number):number { return Math.abs(a)>=Math.abs(b)?a:b; }

/** Combines input devices into one recorded sim sample. Modal blocking releases all devices. */
export class InputController {
  private readonly held = new Set<VirtualAction>();
  private pressed = 0;
  private x = 0;
  private y = 0;
  private blocked = false;
  private awaitPadRelease = false;
  private previousPad = new Set<number>();
  private readonly keyboard:Keyboard|undefined;
  private readonly gamepads:()=>readonly (PadLike|null)[];
  constructor(keyboard?:Keyboard, gamepads:()=>readonly (PadLike|null)[] = () => availableGamepads()) { this.keyboard=keyboard;this.gamepads=gamepads; }
  setBlocked(value:boolean):void { this.blocked=value; this.keyboard?.setBlocked(value);if(value){this.releaseAll();this.awaitPadRelease=true;} }
  setStick(x:number,y:number):void { if(!this.blocked){this.x=axis(x);this.y=axis(y);} }
  setAction(action:VirtualAction,down:boolean):void {
    if(this.blocked)return;
    if(down&&!this.held.has(action)&&!CONTINUOUS.has(action)&&action!=="brake")this.pressed|=Action[action];
    if(down)this.held.add(action);else this.held.delete(action);
  }
  releaseAll():void {this.held.clear();this.pressed=0;this.x=0;this.y=0;this.previousPad.clear();this.keyboard?.releaseAll();}
  sample():SimInput {
    if(this.blocked)return neutral();
    if(this.awaitPadRelease){
      const held=this.gamepads().some(pad=>pad?.connected&&(pad.buttons.some(button=>button.pressed)||pad.axes.some(value=>Number.isFinite(value)&&Math.abs(value)>.16)));
      if(held)return neutral();this.awaitPadRelease=false;
    }
    const base=this.keyboard?.sample()??neutral();
    let actions=base.actions|this.pressed;
    for(const action of this.held)if(action!=="brake"&&CONTINUOUS.has(action))actions|=Action[action];
    this.pressed=0;
    let steer=strongest(base.steer,this.x),throttle=strongest(base.throttle,-this.y),brake=Math.max(base.brake,this.held.has("brake")?1:0);
    const pad=this.gamepads().find(p=>p?.connected);
    const now=new Set<number>();
    if(pad){
      steer=strongest(steer,deadzone(pad.axes[0]??0));throttle=strongest(throttle,-deadzone(pad.axes[1]??0));
      brake=Math.max(brake,Math.max(0,axis(pad.buttons[6]?.value??0)));
      for(const [index,action] of Object.entries(PAD_ACTIONS))if(pad.buttons[Number(index)]?.pressed){
        now.add(Number(index));if(action!=="brake"&&(CONTINUOUS.has(action)||!this.previousPad.has(Number(index))))actions|=Action[action];
      }
    }
    this.previousPad=now;
    return {throttle,steer,brake,actions};
  }
}
