import { expect,it } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import { restorationFacts,stepRepairTour } from "../../../src/sim/activities/repair.ts";
import { createActivities,stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { createEconomy,createWallet,stepEconomy } from "../../../src/sim/economy/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext,GameplayFact } from "../../../src/sim/player/types.ts";
const body={id:"p",x:0,y:120,z:0,speed:0,mode:"foot" as const};
const actor={id:"good",x:0,y:120,z:0,speed:0,heading:0,kind:"robot" as const,model:"footman" as const,firmware:"good" as const,radius:.4,height:1.8};
const site={id:"actual-kiosk",kind:"repairKiosk" as const,x:20,y:0,z:0,radius:5,wave:2};
const context=(patch:Partial<GameplayContext>={}):GameplayContext=>({...DEFAULT_CATALOG,wave:2,bodies:[body],actorBodies:[actor],actors:[],commands:[],facts:[],observations:[],sites:[site],day:0,month:1,...patch});
const damage:GameplayFact={id:"combat:1",source:"combat",sequence:1,tick:1,kind:"robot.repair",actorId:"good",playerId:"p"};
const restored=(player="p",requestId="request-1")=>restorationFacts([{id:"61:0",tick:61,kind:"actor.restored",actorId:"good",detail:"accepted-body",sourcePlayerId:player,requestId,kioskId:site.id}]);
it("does not request an apology tour for an unowned or unobserved repair",()=>{
 expect(stepRepairTour(undefined,context({actions:{p:Action.interact}}),"p",1,[],"request-1").request).toBeUndefined();
 expect(stepRepairTour(undefined,context({actions:{p:Action.interact}}),"p",1,[{...damage,playerId:"other"}],"request-1").request).toBeUndefined();
 expect(stepRepairTour(undefined,context({actorBodies:[],actions:{p:Action.interact}}),"p",1,[damage],"request-1").request).toBeUndefined();
});
it("awards only a matching accepted restoration after staying with the real robot at the kiosk",()=>{
 let out=stepRepairTour(undefined,context({actions:{p:Action.interact}}),"p",1,[damage],"request-1");
 expect(out.request).toMatchObject({id:"request-1",actorId:"good",playerId:"p",kioskId:site.id});expect(out.completed).toBeUndefined();
 const atKiosk=context({bodies:[{...body,x:20}],actorBodies:[{...actor,x:20}],rustByActor:{good:0}});
 for(let tick=2;tick<=60;tick++)out=stepRepairTour(out.state,atKiosk,"p",tick,[],"unused");
 expect(stepRepairTour(out.state,atKiosk,"p",61,restored("other"),"unused").completed).toBeUndefined();
 expect(stepRepairTour(out.state,atKiosk,"p",61,restored("p","wrong-request"),"unused").completed).toBeUndefined();
 const completed=stepRepairTour(out.state,atKiosk,"p",61,restored(),"unused");expect(completed.completed?.actorId).toBe("good");
 expect(stepRepairTour(completed.state,atKiosk,"p",62,restored(),"unused").completed).toBeUndefined();
});
it("rejects autonomous jobs, raw timer events and a player who abandoned the escort",()=>{
 expect(restorationFacts([{id:"1:0",tick:1,kind:"actor.restored",actorId:"good",detail:"accepted-body",requestId:"job",kioskId:site.id}])).toEqual([]);
 expect(restorationFacts([{id:"1:0",tick:1,kind:"robot.restored",actorId:"good",detail:"accepted-body",sourcePlayerId:"p",requestId:"job",kioskId:site.id}])).toEqual([]);
 const initial=stepRepairTour(undefined,context({actions:{p:Action.interact}}),"p",1,[damage],"request-1");
 const absent=context({bodies:[{...body,x:100}],actorBodies:[{...actor,x:20}]});
 const out=stepRepairTour(initial.state,absent,"p",61,restored(),"unused");expect(out.completed).toBeUndefined();expect(out.state.active).toBeUndefined();
});

it("routes accepted repair reputation through activity grants once",()=>{
 let activities=stepActivities(createActivities(),context({actions:{p:Action.interact},facts:[damage]}),1,createMissions(),1);
 const request=activities.players.p!.repairTour!.active!.id;
 const atKiosk=context({bodies:[{...body,x:20}],actorBodies:[{...actor,x:20}],rustByActor:{good:0}});
 for(let tick=2;tick<=60;tick++)activities=stepActivities(activities,atKiosk,tick,createMissions(),1);
 activities=stepActivities(activities,{...atKiosk,facts:restored("p",request)},61,createMissions(),1);
 let economy=createEconomy();economy.players.p={...createWallet(),reputation:45};
 economy=stepEconomy(economy,atKiosk,61,[],undefined,[],activities.events);expect(economy.players.p!.reputation).toBe(50);
 economy=stepEconomy(economy,atKiosk,62,[],undefined,[],activities.events);expect(economy.players.p!.reputation).toBe(50);
});
