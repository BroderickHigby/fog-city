import { expect,it } from "vitest";
import { MISSIONS } from "../../../src/content/catalog.ts";
import type { Mission,ObjectiveStep } from "../../../src/content/missions.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import { Action } from "../../../src/sim/contract.ts";
import { createMissionProgress,createMissions,missionPlace,stepMissions } from "../../../src/sim/missions/system.ts";
import { createHeat } from "../../../src/sim/heat/system.ts";
import { createPlayer } from "../../../src/sim/player/system.ts";
import { createMissionObserved,observeMission } from "../../../src/sim/missions/observed.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext,GameplayFact } from "../../../src/sim/player/types.ts";

const mission=(id:string)=>MISSIONS.find(m=>m.id===id)!;
const objective=(m:Mission,event:string)=>m.steps.find(s=>s.type==="objective"&&s.objective.kind==="event"&&s.objective.event===event) as ObjectiveStep;
const body={id:"p",x:0,y:0,z:0,speed:0,mode:"foot" as const};
const actor=(id:string,firmware:"good"|"bad"="bad"):CombatActor=>({id,firmware,x:0,y:0,z:0,kind:"robot",model:"footman",speed:0,heading:0,radius:.4,height:1.8});
const ctx=(changes:Partial<GameplayContext>={}):GameplayContext=>({...DEFAULT_CATALOG,wave:8,bodies:[body],actors:[],actorBodies:[],observations:[],facts:[],commands:[],missions:[],day:0,month:1,hour:22,...changes});
const fact=(kind:string,actorId:string,detail=""):GameplayFact=>({id:"combat:1",sequence:1,source:"combat",tick:1,kind,actorId,playerId:"p",detail});

it("requires a real false-positive scan on the good courier before acknowledging it",()=>{
 const m=mission("launch-day"),step=objective(m,"botCheck.falsePositiveSeen"),courier=`mission:${m.id}:courier`;
 const base=ctx({actors:[{id:courier,firmware:"good"}]});
 expect(observeMission(undefined,m,step,{...base,actions:{p:Action.interact}},"p",1,0,[]).complete).toBe(false);
 const scanned=observeMission(undefined,m,step,base,"p",1,0,[fact("scan.result",courier,"bad")]);expect(scanned.complete).toBe(false);
 expect(observeMission(scanned.state,m,step,{...base,actions:{p:Action.interact}},"p",2,0,[]).complete).toBe(true);
});

it("only approves the observed three-robot demo after the bad one melts and the others stay dry",()=>{
 const m=mission("demoed-correctly"),step=objective(m,"demo.robotPresented"),ids=["demoBad","demoGoodA","demoGoodB"].map(id=>`mission:${m.id}:${id}`);
 const base=ctx({actorBodies:[actor(ids[0]!),actor(ids[1]!,"good"),actor(ids[2]!,"good")]});let state=createMissionObserved();
 for(const id of ids)state=observeMission(state,m,step,{...base,observations:[{playerId:"p",seenByBad:false,seenByAssociate:false,associateWithin200:false,fog:0,protectedArea:false,watchingActorId:id,watchedTicks:180}]},"p",1,0,[]).state;
 expect(observeMission(state,m,step,base,"p",2,0,[fact("robot.heap",ids[0]!)]).complete).toBe(true);
 expect(observeMission(state,m,step,base,"p",2,0,[fact("robot.heap",ids[0]!),fact("person.wet","partner")]).complete).toBe(false);
});

it("counts three separated pitch acknowledgements during quiet gaps",()=>{
 const m=mission("fleet-week"),open=objective(m,"pitch.windowOpened"),pitch=objective(m,"pitch.windowCompleted"),start=m.steps.find(s=>s.type==="trigger")!;
 if(start.type!=="trigger")throw Error("fixture");const base=ctx({bodies:[{...body,...missionPlace(start.event.place)}]});
 const loud=observeMission(undefined,m,open,base,"p",119,0,[]);expect(loud.complete).toBe(false);
 const quiet=observeMission(loud.state,m,open,base,"p",120,0,[]);expect(quiet.complete).toBe(true);let state=quiet.state;
 for(const [n,tick] of [180,240,300].entries()){
  const next=observeMission(state,m,pitch,{...base,commands:[{sequence:n+1,kind:"mission-ack",playerId:"p"}]},"p",tick,120,[]);expect(next.complete).toBe(n===2);state=next.state;
 }
});

it("requests a stopped coned car but waits for accepted ownership and the player body",()=>{
 const m=mission("fleet-week"),step=objective(m,"vehicle.recovered"),id=`mission:${m.id}:escapeCar`,base=ctx({actorBodies:[actor(id)]});
 const request=observeMission(undefined,m,step,{...base,actions:{p:Action.interact}},"p",1,0,[fact("cone.placed",id)]);expect(request.complete).toBe(false);expect(request.requests[0]?.kind).toBe("mission.vehicle-recovery-request");
 expect(observeMission(request.state,m,step,base,"p",2,0,[]).complete).toBe(false);
 expect(observeMission(request.state,m,step,{...base,bodies:[{...body,mode:"vehicle"}],recoveredVehicleIds:{p:[id]}},"p",2,0,[]).complete).toBe(true);
});

it("opens the fog scene only after the requested weather is observable",()=>{
 const m=mission("marine-layer"),step=objective(m,"fog.nightWindowOpened");
 const clear=observeMission(undefined,m,step,ctx(),"p",1,0,[]);expect(clear.complete).toBe(false);expect(clear.requests[0]?.kind).toBe("mission.weather-request");
 const fog=ctx({observations:[{playerId:"p",seenByBad:false,seenByAssociate:false,associateWithin200:false,protectedArea:false,fog:.8}]});
 expect(observeMission(clear.state,m,step,fog,"p",2,0,[]).complete).toBe(true);
 expect(observeMission(clear.state,m,step,{...fog,hour:12},"p",2,0,[]).complete).toBe(false);
});

it("requires the actual fleet to follow 250m along the fog route",()=>{
 const m=mission("marine-layer"),step=objective(m,"fog.betaFleetLured"),stage=m.steps.find(s=>s.type==="stage")!;if(stage.type!=="stage")throw Error("fixture");const start=missionPlace(stage.place);let state=createMissionObserved();let complete=false;
 for(let n=0;n<=500;n++){
  const current={...body,...start,z:start.z+n*.5},actors=m.actors!.fleet!.members!.map(id=>({...actor(`mission:${m.id}:${id}`),x:current.x,z:current.z+10}));
  const out=observeMission(state,m,step,ctx({bodies:[current],actorBodies:actors,observations:[{playerId:"p",seenByBad:false,seenByAssociate:false,associateWithin200:false,protectedArea:false,fog:.8}]}),"p",n,0,[]);state=out.state;complete=out.complete;
 }
 expect(complete).toBe(true);
 const point={...body,...start,z:start.z+250};
 const aliases=Object.fromEntries(m.actors!.fleet!.members!.map(id=>[id,"one-robot"]));
 expect(observeMission(state,m,step,ctx({bodies:[point],actorBodies:[{...actor("one-robot"),x:point.x,z:point.z}],observations:[{playerId:"p",seenByBad:false,seenByAssociate:false,associateWithin200:false,protectedArea:false,fog:.8,actorBindings:aliases}]}),"p",501,0,[]).complete).toBe(false);
 expect(observeMission(state,m,step,ctx({bodies:[{...body,...start,z:start.z+250}],actorBodies:[]}),"p",501,0,[]).complete).toBe(false);
});
it("clears failed-attempt evidence on an explicit mission retry",()=>{
 const m=mission("demoed-correctly"),state=createMissions();state.players.p={...createMissionProgress(),missionId:m.id,status:"retry",retryFrom:"demo-stage",observed:{...createMissionObserved(),missionId:m.id,dirty:true,watched:["old"],melted:["old"]}};
 const next=stepMissions(state,ctx({missions:[m],commands:[{sequence:1,kind:"mission-retry",playerId:"p"}]}),1,createHeat(),createPlayer());
 expect(next.players.p!.observed?.dirty).toBe(false);expect(next.players.p!.observed?.watched).toEqual([]);expect(next.players.p!.observed?.melted).toEqual([]);
});
