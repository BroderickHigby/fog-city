import { describe,expect,it } from "vitest";
import { createCrowdState,stepCrowd,CROWD_RULES,crowdSpeedLimit,type CrowdContext } from "../../../src/sim/modes/crowd.ts";
import { canonicalJson } from "../../../src/sim/serialize.ts";
const tasks=["cone","update","ad","groceries"].map((kind,i)=>({id:`task-${i}`,kind:kind as "cone"|"update"|"ad"|"groceries",x:200+i*10,y:0,z:0}));
const create=()=>createCrowdState({seed:7,players:["a","b","c","d"],hiders:["a"],tasks,solo:true});
const ctx:CrowdContext={positions:{a:{x:200,y:0,z:0},b:{x:0,y:0,z:0},c:{x:0,y:0,z:5},d:{x:0,y:0,z:10},puppet:{x:200,y:0,z:0}},availableUnits:[{id:"puppet",playerId:"a",x:200,y:0,z:0,clear:true}]};
describe("Hide in the Crowd rules",()=>{
  it("waits for a clear replacement body at least150m from every spotter",()=>{
    const initial=create();const near=stepCrowd(initial,{...ctx,availableUnits:[{id:"puppet",playerId:"a",x:1,y:0,z:0,clear:true}]});
    expect(near.players.a!.unitId).toBe("");
    const accepted=stepCrowd(initial,ctx);expect(accepted.players.a!.unitId).toBe("puppet");expect(initial.players.a!.unitId).toBe("");
  });
  it("requires a real continuous task hold and delays the corner ping five seconds",()=>{
    let s=stepCrowd(create(),ctx);const task=tasks.find(task=>s.activeTasks.includes(task.id))!;
    const context={...ctx,positions:{...ctx.positions,puppet:task},inputs:{a:{interact:true,taskId:task.id}}};
    const hold={cone:300,update:360,ad:240,groceries:120}[task.kind];
    for(let i=0;i<hold-1;i++)s=stepCrowd(s,context);
    expect(s.players.a!.score).toBe(0);s=stepCrowd(s,context);expect(s.players.a!.score).toBe(200);
    expect(s.activeTasks).not.toContain(task.id);expect(s.events.some(e=>e.kind==="crowd.corner-ping")).toBe(false);
    for(let i=0;i<CROWD_RULES.pingTicks;i++)s=stepCrowd(s,ctx);
    expect(s.events.some(e=>e.kind==="crowd.corner-ping")).toBe(true);
  });
  it("drops a melted puppet once and waits ten seconds for replacement",()=>{
    let s=stepCrowd(create(),ctx);
    const event={id:1,tick:2,kind:"robot.heap",sourceId:"b",targetId:"puppet",amount:1,detail:""};
    s=stepCrowd(s,{...ctx,combatEvents:[event,event]});expect(s.players.b!.score).toBe(500);expect(s.players.a!.unitId).toBe("");
    for(let i=0;i<CROWD_RULES.reconnectTicks-1;i++)s=stepCrowd(s,ctx);
    expect(s.players.a!.unitId).toBe("");s=stepCrowd(s,ctx);expect(s.players.a!.unitId).toBe("");
    s=stepCrowd(s,{...ctx,availableUnits:[{id:"new-unit",playerId:"a",x:200,y:0,z:0,clear:true}]});expect(s.players.a!.unitId).toBe("new-unit");
  });
  it("limits burst speed and freezes logical time during global pauses",()=>{
    let s=stepCrowd(create(),{...ctx,inputs:{a:{burst:true}}});expect(crowdSpeedLimit(s,"a")).toBe(3);
    const elapsed=s.elapsedTicks;s=stepCrowd(s,{...ctx,tick:200,paused:true});expect(s.elapsedTicks).toBe(elapsed);
    for(let i=0;i<120;i++)s=stepCrowd(s,ctx);expect(crowdSpeedLimit(s,"a")).toBe(1.6);
  });
  it("resolves a six-minute solo round and swaps roles only in multiplayer",()=>{
    const solo=create();solo.elapsedTicks=CROWD_RULES.halfTicks-1;
    expect(stepCrowd(solo,ctx).phase).toBe("finished");
    const multi=createCrowdState({seed:7,players:["a","b","c","d"],hiders:["a","b"],tasks});multi.elapsedTicks=CROWD_RULES.halfTicks-1;
    const next=stepCrowd(multi,ctx);expect(next.half).toBe(2);expect(next.players.a!.role).toBe("spotter");expect(next.players.c!.role).toBe("hider");
  });
  it("is deterministic and never rewards a good AI robot melt",()=>{
    const input={...ctx,combatEvents:[{id:1,tick:1,kind:"robot.heap",sourceId:"b",targetId:"good",amount:1,detail:""}]};
    expect(canonicalJson(stepCrowd(create(),input))).toBe(canonicalJson(stepCrowd(create(),input)));
    expect(stepCrowd(create(),input).players.b!.score).toBe(0);
  });
});
