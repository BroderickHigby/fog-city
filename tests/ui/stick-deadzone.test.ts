import { describe, expect, it } from "vitest";
import { InputController, type PadLike } from "../../src/input/controller.ts";
import { STICK_DEAD_ZONE, radialDeadZone } from "../../src/input/stick.ts";
import { createTouchControls } from "../../src/ui/touch.ts";

const length=(v:{x:number;y:number}):number=>Math.hypot(v.x,v.y);
const pad=(...axes:number[]):PadLike=>({connected:true,axes,buttons:[]});

describe("radial dead zone",()=>{
  it("reads zero anywhere inside the round zone, on and off the axes",()=>{
    for(const [x,y] of [[0,0],[0.1,0],[0,-0.1],[-0.14,0],[0.1,0.1],[-0.1,0.1],[0.105,-0.105]])expect(radialDeadZone(x!,y!)).toEqual({x:0,y:0});
  });
  it("reads zero exactly at the edge of the zone",()=>{
    expect(radialDeadZone(STICK_DEAD_ZONE,0)).toEqual({x:0,y:0});
    expect(radialDeadZone(0,-STICK_DEAD_ZONE)).toEqual({x:0,y:0});
    const s=STICK_DEAD_ZONE/Math.SQRT2;expect(radialDeadZone(s,s)).toEqual({x:0,y:0});
  });
  it("starts from zero just past the edge instead of jumping",()=>{
    const v=radialDeadZone(STICK_DEAD_ZONE+0.01,0);expect(v.x).toBeGreaterThan(0);expect(v.x).toBeLessThan(0.02);
  });
  it("reaches 1 at full deflection in every direction",()=>{
    expect(radialDeadZone(1,0).x).toBeCloseTo(1,12);expect(radialDeadZone(-1,0).x).toBeCloseTo(-1,12);
    expect(radialDeadZone(0,1).y).toBeCloseTo(1,12);expect(radialDeadZone(0,-1).y).toBeCloseTo(-1,12);
    const d=Math.SQRT1_2;expect(length(radialDeadZone(d,-d))).toBeCloseTo(1,12);
  });
  it("never exceeds 1 when a square-gated stick reports a corner",()=>{
    expect(length(radialDeadZone(1,-1))).toBeCloseTo(1,12);expect(length(radialDeadZone(40,30))).toBeCloseTo(1,12);
  });
  it("rescales the travel past the zone linearly",()=>{
    const mid=(1+STICK_DEAD_ZONE)/2;expect(radialDeadZone(mid,0).x).toBeCloseTo(0.5,12);
  });
  it("keeps the direction of the push",()=>{
    for(const [x,y] of [[0.6,0.3],[-0.3,0.5],[0.2,-0.9],[-0.2,-0.2]]){
      const v=radialDeadZone(x!,y!);expect(v.x*y!).toBeCloseTo(v.y*x!,12);
      expect(Math.sign(v.x)).toBe(Math.sign(x!));expect(Math.sign(v.y)).toBe(Math.sign(y!));
    }
  });
  it("treats nonfinite input as a centred stick",()=>{
    expect(radialDeadZone(NaN,Infinity)).toEqual({x:0,y:0});expect(radialDeadZone(-Infinity,NaN)).toEqual({x:0,y:0});
  });
});

describe("gamepad drive stick",()=>{
  it("ignores a resting stick that drifts inside the round zone",()=>{
    const c=new InputController(undefined,()=>[pad(0.1,-0.1)]);
    expect(c.sample()).toEqual({throttle:0,steer:0,brake:0,actions:0});
  });
  it("steers and drives at full deflection",()=>{
    expect(new InputController(undefined,()=>[pad(1,0)]).sample().steer).toBeCloseTo(1,12);
    expect(new InputController(undefined,()=>[pad(0,-1)]).sample().throttle).toBeCloseTo(1,12);
    expect(new InputController(undefined,()=>[pad(0,1)]).sample().throttle).toBeCloseTo(-1,12);
  });
  it("keeps the angle of a diagonal push instead of dropping the small axis",()=>{
    const s=new InputController(undefined,()=>[pad(0.5,-0.1)]).sample();
    expect(s.steer).toBeGreaterThan(0);expect(s.throttle).toBeGreaterThan(0);expect(s.throttle/s.steer).toBeCloseTo(0.1/0.5,12);
  });
  it("lets the touch stick and the pad share one dead zone rule",()=>{
    const c=new InputController(undefined,()=>[pad(0.1,0)]);c.setStick(0.5,0);
    expect(c.sample().steer).toBeCloseTo(0.5,12);
  });
  it("after a menu, waits for the pad stick to leave its round zone, and only that",()=>{
    let axes=[0.3,0];const c=new InputController(undefined,()=>[{...pad(0,0),axes}]);
    c.setBlocked(true);c.setBlocked(false);
    expect(c.sample().steer).toBe(0);
    axes=[0.13,0.13];expect(c.sample()).toEqual({throttle:0,steer:0,brake:0,actions:0});
    axes=[0.6,0];expect(c.sample().steer).toBeGreaterThan(0);
  });
  it("keeps a worn pad resting at (0.15, 0.15) under the sim's 0.05 hold-still check",()=>{
    const s=new InputController(undefined,()=>[pad(0.15,0.15)]).sample();
    expect(Math.abs(s.steer)).toBeLessThan(0.05);expect(Math.abs(s.throttle)).toBeLessThan(0.05);
  });
});

/** The smallest stand-in for a DOM element that touch.ts needs. */
class FakeElement {
  className="";type="";textContent="";hidden=false;style:Record<string,string>={};children:FakeElement[]=[];
  private readonly listeners=new Map<string,((e:unknown)=>void)[]>();
  setAttribute(){}
  append(...nodes:FakeElement[]){this.children.push(...nodes);}
  remove(){}
  setPointerCapture(){}
  getBoundingClientRect(){return{left:0,top:0,width:100,height:100};}
  addEventListener(type:string,fn:(e:unknown)=>void){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn]);}
  removeEventListener(type:string,fn:(e:unknown)=>void){this.listeners.set(type,(this.listeners.get(type)??[]).filter(f=>f!==fn));}
  fire(type:string,e:unknown){for(const fn of this.listeners.get(type)??[])fn(e);}
}
function mountTouch(){
  const calls:[number,number][]=[];
  const controller={setStick:(x:number,y:number)=>{calls.push([x,y]);},setAction(){}} as unknown as InputController;
  const doc={createElement:()=>new FakeElement()} as unknown as Document;
  const touch=createTouchControls(doc,controller,key=>key);
  const stick=(touch.element as unknown as FakeElement).children[0]!;
  const event=(clientX:number,clientY:number)=>({pointerId:7,clientX,clientY,preventDefault(){}});
  return{calls,stick,event,last:()=>calls[calls.length-1]!,knob:()=>stick.children[0]!.style.transform??""};
}

describe("touch stick",()=>{
  it("sends zero for a small drag inside the dead zone, while the knob still follows the finger",()=>{
    const t=mountTouch();t.stick.fire("pointerdown",t.event(55,50));
    expect(t.last()).toEqual([0,0]);expect(Number.parseFloat(t.knob().slice("translate(".length))).toBeCloseTo(3.4,9);
    t.stick.fire("pointermove",t.event(50,43));expect(t.last()).toEqual([0,0]);
  });
  it("sends a rescaled value for a drag past the zone and 1 at the rim",()=>{
    const t=mountTouch();t.stick.fire("pointerdown",t.event(75,50));
    expect(t.last()[0]).toBeCloseTo((0.5-STICK_DEAD_ZONE)/(1-STICK_DEAD_ZONE),12);expect(t.last()[1]).toBe(0);
    t.stick.fire("pointermove",t.event(100,50));expect(t.last()[0]).toBeCloseTo(1,12);
    t.stick.fire("pointermove",t.event(900,50));expect(t.last()[0]).toBeCloseTo(1,12);
  });
  it("keeps the direction of a diagonal drag and resets on release",()=>{
    const t=mountTouch();t.stick.fire("pointerdown",t.event(50+30,50-40));
    const [x,y]=t.last();expect(x).toBeGreaterThan(0);expect(y).toBeLessThan(0);expect(y/x).toBeCloseTo(-40/30,12);
    t.stick.fire("pointerup",t.event(0,0));expect(t.last()).toEqual([0,0]);expect(t.knob()).toBe("");
  });
});
