import { describe, expect, it } from "vitest";
import { agentsOf, buildWorld, createInitialState, step, type AgentMotionProposal, type SimSystem, prepareMotionBodies, applyMotionBodies } from "../../src/sim/index.ts";
import { deepFreeze } from "../helpers.ts";

describe("core movement acceptance", () => {
  const world = buildWorld([]);
  const initial = () => createInitialState(world, 1, ["p1"], { x: 0, z: 0, heading: 0 });
  const motion = (changes: Partial<AgentMotionProposal> = {}): AgentMotionProposal => ({
    id:"mission:spill:robot",numericId:100,legacyId:null,kind:"walker",x:10,y:0,z:9.98,heading:0,speed:1.2,radius:.4,height:1.8,sourceX:10,sourceY:0,sourceZ:10,...changes,
  });
  it("runs preparation before movement and exposes exactly one accepted move after clearance", () => {
    const before = deepFreeze(initial());
    let observed = 0;
    const system: SimSystem = { key:"robots", prepare:ctx=>{
      expect(ctx.state.tick).toBe(1);
      expect(ctx.previous.tick).toBe(0);
      return {state:ctx.state,motions:[motion()]};
    },step:ctx=>{
      observed++;
      expect(ctx.observedBodies?.[0]).toMatchObject({id:"mission:spill:robot",x:10,y:0,z:9.98,heading:0});
      expect(ctx.observedBodies?.[0]?.speed).toBeCloseTo(1.2);
      return ctx.state;
    }};
    const next=step(world,before,{},[],[system]);
    expect(next.ext.agents!.list).toHaveLength(1);
    expect(agentsOf(next)).toHaveLength(0);
    expect(before.ext).toEqual({});
    expect(observed).toBe(1);
  });
  it("bounds untrusted desired displacement and rejects vehicle-overlapping spawns", () => {
    const system: SimSystem = { key:"robots",prepare:ctx=>({state:ctx.state,motions:[motion({z:-500})]}),step:ctx=>ctx.state };
    const next=step(world,initial(),{},[],[system]);
    expect(Math.abs(next.ext.agents!.list[0]!.z-10)).toBeLessThanOrEqual(.021);
    const overlapping: SimSystem={...system,prepare:ctx=>({state:ctx.state,motions:[motion({sourceX:0,sourceZ:0})]})};
    expect(()=>step(world,initial(),{},[],[overlapping])).toThrow("overlaps");
  });
  it("retires a physical proxy without recycling its numeric ID", () => {
    const spawn:SimSystem={key:"robots",prepare:ctx=>({state:ctx.state,motions:[motion()]}),step:ctx=>ctx.state};
    const old=step(world,initial(),{},[],[spawn]);
    const retire:SimSystem={key:"robots",prepare:ctx=>({state:ctx.state,motions:[],retirements:["mission:spill:robot"]}),step:ctx=>ctx.state};
    const next=step(world,old,{},[],[retire]);
    expect(next.ext.agents!.list).toHaveLength(0);
    expect(next.ext.agents!.nextId).toBe(101);
  });
  it("claims legacy bodies without hiding them from the combat adapter and rejects identity hijacks",()=>{
    const body=prepareMotionBodies(world,initial(),[motion()]).ext.agents!.list[0]!;
    const {runtimeId:_,runtimeLegacy:__,...legacy}=body;
    const state={...initial(),ext:{agents:{nextId:101,list:[legacy]}}};
    const claimed=prepareMotionBodies(world,state,[motion({id:"agent:100",legacyId:100})]);
    expect(claimed.ext.agents!.list[0]!.runtimeId).toBe("agent:100");
    expect(agentsOf(claimed)).toHaveLength(1);
    expect(()=>prepareMotionBodies(world,claimed,[motion({id:"intruder",legacyId:100})])).toThrow("identity");
    expect(()=>prepareMotionBodies(world,initial(),[motion(),motion({numericId:101})])).toThrow("Duplicate");
    expect(()=>prepareMotionBodies(world,state,[motion({halfLength:NaN})])).toThrow("Invalid");
    expect(JSON.parse(JSON.stringify(claimed))).toEqual(claimed);
  });
  it("checks the swept vehicle hull and rotation instead of just its centre",()=>{
    const w=buildWorld([{tileId:"wall",ground:null,buildings:[{id:"wall",baseY:0,topY:8,footprint:[[11,0],[15,0],[15,20],[11,20]]}]}]);
    const m=motion({kind:"vehicle",sourceX:10,x:10,sourceZ:10,z:10,radius:1.6,height:1.5,halfLength:2.2,halfWidth:.95,speed:0,heading:0});
    const ready=prepareMotionBodies(w,initial(),[m]);
    const next=applyMotionBodies(w,ready,[{...m,heading:Math.PI/2}]);
    expect(next.ext.agents!.list[0]!.heading).toBe(0);
    expect(()=>prepareMotionBodies(w,initial(),[{...m,sourceX:10.1}])).toThrow("spawn");
  });
  it("holds service vehicles before their full hull overlaps a player car",()=>{
    const m=motion({kind:"vehicle",sourceX:0,x:0,sourceZ:5,z:4.2,radius:1.6,height:1.5,halfLength:2.2,halfWidth:.95,speed:48});
    const ready=prepareMotionBodies(world,initial(),[m]);
    const next=applyMotionBodies(world,ready,[m]);
    expect(next.ext.agents!.list[0]!.z).toBe(5);
    expect(next.ext.agents!.list[0]!.speed).toBe(0);
  });

  it("rejects simultaneous closing hulls and unbounded proposal speeds",()=>{
    const left=motion({id:"left",kind:"vehicle",numericId:100,sourceX:10,x:10.2,sourceZ:10,z:10,heading:Math.PI/2,speed:12,halfLength:1,halfWidth:.5});
    const right=motion({id:"right",kind:"vehicle",numericId:101,sourceX:12.3,x:12.1,sourceZ:10,z:10,heading:-Math.PI/2,speed:12,halfLength:1,halfWidth:.5});
    const ready=prepareMotionBodies(world,initial(),[left,right]);
    const next=applyMotionBodies(world,ready,[left,right]);
    expect(next.ext.agents!.list.map(body=>body.x)).toEqual([10,12.3]);
    expect(()=>prepareMotionBodies(world,initial(),[motion({speed:1e12})])).toThrow("Invalid");
  });

});

describe("service vehicle controls",()=>{
  it("applies normal car physics once and preserves its controller state",()=>{
    const world=buildWorld([]);
    let state=createInitialState(world,1,["p"],{x:0,z:0,heading:0});
    const proposal:AgentMotionProposal={id:"service:one",numericId:100,legacyId:null,kind:"vehicle",bodyKind:"robot",sourceX:10,sourceY:0,sourceZ:20,x:10,y:0,z:20,heading:0,speed:0,radius:1.6,height:1.8,halfLength:2.7,halfWidth:1.1,controls:{throttle:1,steer:0,brake:0,actions:0}};
    const system:SimSystem={key:"robots",prepare:ctx=>({state:ctx.state,motions:[proposal]}),step:ctx=>ctx.state};
    for(let tick=0;tick<120;tick++)state=step(world,state,{},[],[system]);
    const body=state.ext.agents!.list[0]!;
    expect(body.z).toBeLessThan(10);
    expect(body.speed).toBeGreaterThan(8);
    expect(body.vehicle!.speed).toBe(body.speed);
    expect(body.vehicle!.x).toBe(body.x);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
