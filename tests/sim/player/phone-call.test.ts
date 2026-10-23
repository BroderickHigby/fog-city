import { expect,it } from "vitest";
import { MISSIONS } from "../../../src/content/catalog.ts";
import { createMissions,stepMissions } from "../../../src/sim/missions/system.ts";
import { createHeat } from "../../../src/sim/heat/system.ts";
import { createPlayer } from "../../../src/sim/player/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext } from "../../../src/sim/player/types.ts";

it("keeps an automatically started phone call pending until an actual acknowledgement",()=>{
 const spill=MISSIONS.find(m=>m.id==="spill")!;
 const context:GameplayContext={...DEFAULT_CATALOG,wave:2,bodies:[{id:"p",x:0,y:0,z:0,speed:0,mode:"foot"}],missions:[spill],actors:[],facts:[],observations:[],day:1,month:1,commands:[{kind:"mission-start",sequence:1,playerId:"p",targetId:"spill"}]};
 const ringing=stepMissions(createMissions(),context,1,createHeat(),createPlayer());
 expect(ringing.players.p!.status).toBe("active");expect(ringing.players.p!.stepId).toBe("posting");
 const waiting=stepMissions(ringing,{...context,commands:[]},2,createHeat(),createPlayer());expect(waiting.players.p!.stepId).toBe("posting");
 const answered=stepMissions(waiting,{...context,commands:[{kind:"mission-ack",sequence:2,playerId:"p"}]},3,createHeat(),createPlayer());expect(answered.players.p!.stepId).toBe("go");
});
