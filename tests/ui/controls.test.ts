import { describe, expect, it } from "vitest";
import { Action } from "../../src/sim/contract.ts";
import { InputController, type PadLike } from "../../src/input/controller.ts";
import { assistedAim } from "../../src/input/aim-assist.ts";
import { route } from "../../src/ui/navigation.ts";
import { gateText } from "../../src/ui/free-text.ts";

describe("combined controls",()=>{
  it("holds spray but consumes discrete actions once",()=>{
    const controls=new InputController(undefined,()=>[]);controls.setAction("fire",true);controls.setAction("cone",true);
    expect(controls.sample().actions).toBe(Action.fire|Action.cone);expect(controls.sample().actions).toBe(Action.fire);
    controls.setAction("fire",false);expect(controls.sample().actions).toBe(0);
  });
  it("keeps refill interaction held for the complete fill duration",()=>{
    const controls=new InputController(undefined,()=>[]);controls.setAction("interact",true);
    for(let tick=0;tick<180;tick++)expect(controls.sample().actions&Action.interact).toBe(Action.interact);
    controls.setAction("interact",false);expect(controls.sample().actions&Action.interact).toBe(0);
  });
  it("blocks and releases every device while typing",()=>{
    const pad:PadLike={connected:true,axes:[0,-1],buttons:Array.from({length:12},()=>({pressed:true,value:1}))};
    let pads:readonly(PadLike|null)[]=[pad];const controls=new InputController(undefined,()=>pads);controls.setStick(1,-1);controls.setAction("fire",true);controls.setBlocked(true);
    expect(controls.sample()).toEqual({throttle:0,steer:0,brake:0,actions:0});
    controls.setAction("fire",true);controls.setBlocked(false);expect(controls.sample().throttle).toBe(0);
    pads=[];expect(controls.sample().actions).toBe(0);pads=[pad];expect(controls.sample().throttle).toBe(1);
  });
  it("ignores disconnected controllers and nonfinite joystick data",()=>{
    const controls=new InputController(undefined,()=>[{connected:false,axes:[1,-1],buttons:[]}]);controls.setStick(NaN,Infinity);
    expect(controls.sample()).toEqual({throttle:0,steer:0,brake:0,actions:0});
  });
});
describe("directed navigation",()=>{
  const nodes=[{id:"a",x:0,z:0},{id:"b",x:10,z:0},{id:"c",x:10,z:10}];
  const edges=[{from:"a",to:"b"},{from:"b",to:"c"}];
  it("uses one-way roads without creating reverse routes",()=>{
    expect(route(nodes,edges,nodes[0]!,nodes[2]!).map(n=>n.id)).toEqual(["a","b","c"]);
    expect(route(nodes,edges,nodes[2]!,nodes[0]!)).toEqual([]);
  });
  it("ignores invalid edge lengths",()=>expect(route(nodes,[{from:"a",to:"c",length:-1}],nodes[0]!,nodes[2]!)).toEqual([]));
});
describe("typed input boundary",()=>{
  it("runs crisis handling before length, content and parser gates",()=>{
    const result=gateText("startup",`${"x".repeat(400)} I want to kill myself`);expect(result.kind).toBe("crisis");
  });
  it("caps startup without silently truncating the sentence",()=>expect(gateText("startup","a".repeat(141))).toEqual({kind:"invalid",reason:"tooLong"}));
  it("strips contact information and delimiters before a resolver sees text",()=>{
    const result=gateText("support","Reach me at test@example.com or 415-555-0123 <hello>");
    expect(result.kind).toBe("ready");if(result.kind==="ready"){expect(result.text).not.toContain("test@example.com");expect(result.text).not.toContain("415-555-0123");expect(result.text).not.toContain("<");}
  });
});
describe("gentle aim assist",()=>{
  it("never selects protected, hidden or friendly targets",()=>{
    const targets=[{id:"a",x:0,z:-10,visible:true,robot:true,protected:true},{id:"b",x:0,z:-10,visible:false,robot:true},{id:"c",x:0,z:-10,visible:true,robot:false}];
    expect(assistedAim({x:0,z:0},0,targets)).toBe(0);
  });
  it("keeps assistance within its six degree limit",()=>{
    const target={id:"a",x:1.7,z:-10,visible:true,robot:true};
    expect(assistedAim({x:0,z:0},0,[target],true)).toBeCloseTo(Math.PI/30);
  });
});
