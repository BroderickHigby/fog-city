export interface LookInput {readonly pixelsX:number;readonly pixelsY:number;readonly stickX:number;readonly stickY:number;readonly reset:boolean}
export interface AimPose {readonly yaw:number;readonly pitch:number}
export const NO_LOOK:Readonly<LookInput>=Object.freeze({pixelsX:0,pixelsY:0,stickX:0,stickY:0,reset:false});
const finite=(value:number)=>Number.isFinite(value)?value:0;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const wrap=(value:number)=>((value+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI;
/** Device look becomes explicit recorded angles; no sim body or camera mutates here. */
export class AimController {
  private pose:AimPose|undefined;
  reset():void{this.pose=undefined;}
  update(heading:number,look:LookInput,dt:number):AimPose|undefined {
    if(look.reset)this.reset();
    const x=clamp(finite(look.pixelsX),-1000,1000)*.003+clamp(finite(look.stickX),-1,1)*2.3*clamp(finite(dt),0,.1);
    const y=-clamp(finite(look.pixelsY),-1000,1000)*.003-clamp(finite(look.stickY),-1,1)*1.6*clamp(finite(dt),0,.1);
    if(!this.pose&&x===0&&y===0)return undefined;
    this.pose={yaw:wrap((this.pose?.yaw??finite(heading))+x),pitch:clamp((this.pose?.pitch??0)+y,-1.2,1.2)};
    return this.pose;
  }
  current():AimPose|undefined{return this.pose;}
}
