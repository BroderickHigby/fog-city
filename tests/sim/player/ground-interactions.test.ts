import { expect,it } from "vitest";
import { createEconomy,stepEconomy } from "../../../src/sim/economy/system.ts";
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
