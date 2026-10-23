import { describe, expect, it } from "vitest";
import { CITY_LIFE } from "../../../src/content/cityLife.ts";
/** The director's idle window in ticks (content/city-life.json; 45–75 s before the owner asked for more action). */
const IDLE_TICKS=CITY_LIFE.director.idleWindowS.map(s=>s*60) as [number,number];
import { createHeat, createHeatStatus, stepHeat } from "../../../src/sim/heat/system.ts";
import { createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext } from "../../../src/sim/player/types.ts";

const context=(extra:Partial<GameplayContext>={}):GameplayContext=>({...DEFAULT_CATALOG,wave:3,bodies:[{id:"p",x:0,y:90,z:0,speed:0,mode:"vehicle"}],commands:[],facts:[],actors:[],observations:[],missions:[],day:1,month:1,...extra});
describe("wave-3 ambient and economy integration",()=>{
  it("lowers heat once per car-wash visit from recorded stopped-vehicle interaction",()=>{
    const ctx=context({sites:[{id:"wash",kind:"carWash",x:0,y:0,z:0,radius:5,wave:3}],commands:[{playerId:"p",sequence:1,kind:"activity-start",targetId:"wash"}]});
    const heat={...createHeat(),players:{p:{...createHeatStatus(0),threat:3}}};
    const washed=stepHeat(heat,ctx,1);expect(washed.players.p!.threat).toBe(2);
    const repeated=stepHeat(washed,{...ctx,commands:[{...ctx.commands[0]!,sequence:2}]},2);expect(repeated.players.p!.threat).toBe(2);
    const left=stepHeat(repeated,{...ctx,bodies:[{...ctx.bodies[0]!,x:20}],commands:[]},3);
    expect(stepHeat(left,{...ctx,commands:[{...ctx.commands[0]!,sequence:3}]},4).players.p!.threat).toBe(1);
    expect(stepHeat(heat,{...ctx,bodies:[{...ctx.bodies[0]!,speed:3}]},1).players.p!.threat).toBe(3);
  });
  it("settles mission VC attention on the next heat phase exactly once",()=>{
    const grant={id:1,tick:5,kind:"mission.vc",playerId:"p",targetId:"vcAttention",amount:1,detail:""};
    const awarded=stepHeat(createHeat(),context(),6,[],[grant]);expect(awarded.players.p!.vcQuarters).toBe(4);
    expect(stepHeat(awarded,context(),7,[],[grant]).players.p!.vcQuarters).toBe(4);
  });
  it("spreads first director arrivals through city-life idles and excludes protected places",()=>{
    const starts=new Set<number>();
    for(let seed=0;seed<30;seed++){
      const ctx=context({directorCards:[{id:"card",fromWave:3,radiusM:100,cooldownS:60,protectedAreas:false}],observations:[{playerId:"p",seenByBad:false,seenByAssociate:false,associateWithin200:false,protectedArea:true,fog:0}]});
      const initial=stepActivities(createActivities(),ctx,0,createMissions(),seed),due=initial.players.p!.nextDirectorTick;
      starts.add(due);expect(due).toBeGreaterThanOrEqual(IDLE_TICKS[0]);expect(due).toBeLessThanOrEqual(IDLE_TICKS[1]);
      expect(stepActivities(initial,ctx,due,createMissions(),seed).events).toEqual([]);
    }
    expect(starts.size).toBeGreaterThan(20);
  });
});
