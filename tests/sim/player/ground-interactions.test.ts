import { expect,it } from "vitest";
import { createEconomy,stepEconomy } from "../../../src/sim/economy/system.ts";
import { createActivities,stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { canInteractAtSite } from "../../../src/sim/player/sites.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext } from "../../../src/sim/player/types.ts";

const context=(patch:Partial<GameplayContext>):GameplayContext=>({...DEFAULT_CATALOG,wave:4,day:0,month:1,bodies:[],actors:[],facts:[],commands:[],observations:[],missions:[],...patch});
it("buys at an authored map site at terrain height while enforcing distance and speed",()=>{
 const site=DEFAULT_CATALOG.sites.find(s=>s.kind==="vendor")!,body={id:"p",x:site.x,y:240,z:site.z,speed:0,mode:"foot" as const};
 const ctx=context({bodies:[body],commands:[{sequence:1,playerId:"p",kind:"buy",targetId:site.id,itemId:"tank-1"}]});
 expect(stepEconomy(createEconomy(),ctx,1).players.p!.ownedItemIds).toContain("tank-1");
 expect(canInteractAtSite({...body,x:site.x+site.radius+1},site)).toBe(false);
 expect(canInteractAtSite({...body,speed:3.01},site)).toBe(false);
});
it("completes a physical uphill route whose catalog markers do not encode elevation",()=>{
 const activity={id:"hill-route",kind:"timeTrial",wave:4,x:0,y:0,z:0,radius:4,rewardXp:100,checkpoints:[{id:"crest",x:20,y:0,z:0,radius:4}]};
 const first=stepActivities(createActivities(),context({activities:[activity],bodies:[{id:"p",x:0,y:200,z:0,speed:0,mode:"foot"}],commands:[{sequence:1,playerId:"p",kind:"activity-start",targetId:activity.id}]}),1,createMissions(),1);
 expect(first.players.p!.activeActivityId).toBe(activity.id);
 const climbed=stepActivities(first,context({activities:[activity],bodies:[{id:"p",x:20,y:215,z:0,speed:0,mode:"foot"}]}),61,createMissions(),1);
 expect(climbed.players.p!.completedIds).toContain(activity.id);
});
