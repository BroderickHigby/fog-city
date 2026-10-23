import { expect,it } from "vitest";
import { MISSIONS } from "../../../src/content/catalog.ts";
import type { ObjectiveStep } from "../../../src/content/missions.ts";
import { Action } from "../../../src/sim/contract.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import { stepTeleoperation } from "../../../src/sim/missions/teleoperation.ts";
import { createMissions,createMissionProgress,stepMissions } from "../../../src/sim/missions/system.ts";
import { createHeat } from "../../../src/sim/heat/system.ts";
import { createPlayer } from "../../../src/sim/player/system.ts";
import { createFinale,stepFinale } from "../../../src/sim/missions/finale.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext } from "../../../src/sim/player/types.ts";

const mission=(id:string)=>MISSIONS.find(m=>m.id===id)!;
const objective=(id:string,event:string)=>mission(id).steps.find(s=>s.type==="objective"&&s.objective.event===event) as ObjectiveStep;
const body={id:"p",x:100,y:0,z:0,speed:0,mode:"foot" as const};
const actor=(id:string,x=0,height=1.8,firmware:"good"|"bad"="bad"):CombatActor=>({id,x,y:0,z:0,height,firmware,model:height>=400?"walker":"footman",kind:"robot",radius:.4,heading:0,speed:0});
const context=(patch:Partial<GameplayContext>={}):GameplayContext=>({...DEFAULT_CATALOG,bodies:[body],actors:[],actorBodies:[],facts:[],commands:[],observations:[],missions:[],wave:8,day:0,month:1,...patch});

it("requires accepted robot control, actual delivery interactions, then accepted disconnection",()=>{
 const m=mission("acqui-hire-offer"),prefix=`mission:${m.id}:`,unit=prefix+"unit",actors=[actor(prefix+"van",0,2,"good"),actor(unit,2,1.8,"good"),actor(prefix+"pickup",10,1.8,"good"),actor(prefix+"recipient",20,1.8,"good"),actor(prefix+"server",30,1.8,"good")];
 const run=(state:Parameters<typeof stepTeleoperation>[0],event:string,tick:number,x:number,press:boolean,controlled=unit)=>stepTeleoperation(state,m,objective(m.id,event),context({actorBodies:actors.map(a=>a.id===unit?{...a,x}:a),bodies:[{...body,x}],actions:{p:press?Action.interact:0},controlledActorIds:{p:controlled}}),"p",tick);
 let out=run(undefined,"teleoperation.connected",1,0,true,"");expect(out.complete).toBe(false);expect(out.requests.some(r=>r.kind==="mission.control-request")).toBe(true);
 out=run(out.state,"teleoperation.connected",2,2,false);expect(out.complete).toBe(true);
 out=run(out.state,"teleoperation.coverTaskCompleted",3,10,true);expect(out.complete).toBe(false);
 out=run(out.state,"teleoperation.coverTaskCompleted",4,10,false);
 out=run(out.state,"teleoperation.coverTaskCompleted",5,20,true);expect(out.complete).toBe(true);
 out=run(out.state,"teleoperation.serverFound",6,30,false);
 out=run(out.state,"teleoperation.serverFound",7,30,true);expect(out.complete).toBe(true);
 out=run(out.state,"teleoperation.disconnected",8,30,false);
 out=run(out.state,"teleoperation.disconnected",9,30,true);expect(out.complete).toBe(false);
 out=run(out.state,"teleoperation.disconnected",10,0,false,"");expect(out.complete).toBe(false);
 out=run(out.state,"teleoperation.disconnected",11,20,false,"");expect(out.complete).toBe(true);
});

it("fails exposed teleoperation and rejects a different controlled robot",()=>{
 const m=mission("acqui-hire-offer"),unit=`mission:${m.id}:unit`,ctx=context({actorBodies:[actor(unit,0,1.8,"good")],bodies:[{...body,x:0}],controlledActorIds:{p:"another-unit"}});
 expect(stepTeleoperation(undefined,m,objective(m.id,"teleoperation.connected"),ctx,"p",1).complete).toBe(false);
 const exposed=stepTeleoperation(undefined,m,objective(m.id,"teleoperation.coverTaskCompleted"),{...ctx,controlledActorIds:{p:unit},actions:{p:Action.fire}},"p",2);
 expect(exposed.failed).toBe(true);expect(exposed.requests.some(r=>r.kind==="mission.control-request"&&JSON.parse(r.detail!).action==="exit")).toBe(true);
 expect(stepTeleoperation(undefined,m,objective(m.id,"teleoperation.connected"),{...ctx,controlledActorIds:{p:unit}},"p",3).complete).toBe(false);
});

it("observes the giant for three seconds and will not manufacture an entrance without a body",()=>{
 const m=mission("comeback-round"),step=objective(m.id,"boss.entranceSeen"),walker=`mission:${m.id}:walker`;
 expect(stepFinale(undefined,m,step,context(),"p",1,0).complete).toBe(false);
 const ctx=context({actorBodies:[actor(walker,0,500)],bodies:[{...body,x:0,z:100}],lookHeadingByPlayer:{p:0},visibleActorIds:{p:[walker]},actions:{p:Action.watch}});let state=createFinale(),complete=false;
 for(let tick=1;tick<=180;tick++){const out=stepFinale(state,m,step,ctx,"p",tick,0);state=out.state;complete=out.complete;expect(complete).toBe(tick===180);}
});

it("requires both actually rusted joints owned by this player",()=>{
 const m=mission("comeback-round"),step=objective(m.id,"boss.anklesRusted"),prefix=`mission:${m.id}:`,ids=[prefix+"ankle-left",prefix+"ankle-right"],state={...createFinale(),sawEntrance:true};
 const ctx=context({actorBodies:[actor(prefix+"walker",0,500),...ids.map(id=>actor(id))],rustByActor:{[ids[0]!]:1,[ids[1]!]:1},damageOwnerIds:{[ids[0]!] :"p",[ids[1]!]:"other"}});
 expect(stepFinale(state,m,step,ctx,"p",1,0).complete).toBe(false);
 expect(stepFinale(state,m,step,{...ctx,damageOwnerIds:{[ids[0]!] :"p",[ids[1]!]:"p"}},"p",2,0).complete).toBe(true);
});

it("does not request a footfall through people or animals",()=>{
 const m=mission("comeback-round"),step=objective(m.id,"boss.anklesRusted"),walker=actor(`mission:${m.id}:walker`,0,500),person={...actor("person",12),kind:"person" as const,z:6,firmware:"none" as const};
 const blocked=stepFinale(undefined,m,step,context({actorBodies:[walker,person]}),"p",300,0);expect(blocked.requests.some(r=>r.kind==="mission.footfall-request")).toBe(false);
 const clear=stepFinale(undefined,m,step,context({actorBodies:[walker]}),"p",300,0);expect(clear.requests.some(r=>r.kind==="mission.footfall-request")).toBe(true);
});

it("waits for the restored fleet and removed shell before the finale ends",()=>{
 const m=mission("comeback-round"),step=objective(m.id,"boss.robotsFreed"),prefix=`mission:${m.id}:`,state={...createFinale(),rusted:[prefix+"knee-left",prefix+"knee-right"]};
 const requested=stepFinale(state,m,step,context(),"p",1,0);expect(requested.complete).toBe(false);expect(requested.requests.some(r=>r.kind==="mission.restore-fleet-request")).toBe(true);
 const restored=Array.from({length:6},(_,n)=>actor(prefix+`freed-${n}`,n,1.8,"good"));
 expect(stepFinale(requested.state,m,step,context({actorBodies:restored}),"p",2,0).complete).toBe(true);
});


it("keeps a witnessed entrance across a boat retry while discarding prior joint damage",()=>{
 const m=mission("comeback-round"),state=createMissions();
 state.players.p={...createMissionProgress(),missionId:m.id,status:"retry",retryFrom:"boat",finale:{...createFinale(),sawEntrance:true,rusted:["old-joint"],requested:["old-scene"]}};
 const next=stepMissions(state,context({missions:[m],commands:[{sequence:1,kind:"mission-retry",playerId:"p"}]}),1,createHeat(),createPlayer());
 expect(next.players.p!.status).toBe("active");expect(next.players.p!.stepId).toBe("boat");
 expect(next.players.p!.finale?.sawEntrance).toBe(true);expect(next.players.p!.finale?.rusted).toEqual([]);expect(next.players.p!.finale?.requested).not.toContain("old-scene");
});
