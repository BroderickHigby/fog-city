import {describe,expect,it} from "vitest";
import {buildWorld} from "../../../src/sim/world.ts";
import {createInitialState} from "../../../src/sim/step.ts";
import {planModeRoster} from "../../../src/sim/agents/mode-roster.ts";
const world=buildWorld([]),sim=createInitialState(world,1,[],{x:100,z:100,heading:0});
const request={id:"embarcadero",mode:"bot-sweep" as const,playerCount:1,center:{x:0,y:0,z:0},radius:80,contains:(x:number,z:number)=>Math.abs(x)<70&&Math.abs(z)<70};
describe("physical mode roster blueprints",()=>{
  it("places 120 robots and an armoured relay without overlap inside the approved region",()=>{
    const result=planModeRoster(world,sim,request);
    expect(result.blocked).toEqual([]);
    expect(result.actors).toHaveLength(121);
    expect(result.actors.filter(a=>a.firmware==="bad")).toHaveLength(15);
    expect(result.actors.find(a=>a.id.endsWith(":update-relay"))).toMatchObject({rustScale:.2,firmware:"bad"});
    for(const actor of result.actors)expect(request.contains(actor.x,actor.z)).toBe(true);
    for(let i=0;i<result.actors.length;i++)for(let j=i+1;j<result.actors.length;j++)expect(Math.hypot(result.actors[i]!.x-result.actors[j]!.x,result.actors[i]!.z-result.actors[j]!.z)).toBeGreaterThan(1.3);
    expect(planModeRoster(world,sim,request)).toEqual(result);
  });
  it("uses thirty bad units for Clean Streets and scales Bot Sweep to 24 players",()=>{
    expect(planModeRoster(world,sim,{...request,mode:"clean-streets"}).actors.filter(a=>a.firmware==="bad")).toHaveLength(30);
    expect(planModeRoster(world,sim,{...request,playerCount:24}).actors.filter(a=>a.firmware==="bad")).toHaveLength(107);
    expect(()=>planModeRoster(world,sim,{...request,playerCount:25})).toThrow();
  });
  it("reports unavailable placements rather than placing outside an approved instance",()=>{
    const result=planModeRoster(world,sim,{...request,contains:()=>false});
    expect(result.actors).toEqual([]);expect(result.blocked).toHaveLength(121);
  });
});
