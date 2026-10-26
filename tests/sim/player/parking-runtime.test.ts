import { describe, expect, it } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import { createMissions, createMissionProgress } from "../../../src/sim/missions/system.ts";
import { prepareMissionParking, type MissionParkingWorld } from "../../../src/sim/missions/mechanics/runtime.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext } from "../../../src/sim/player/types.ts";

const parking: MissionParkingWorld = { bays:[{id:"bay",edge:"road",side:"R",x:0,y:0,z:0,heading:0,halfLength:3.5,halfWidth:1.3}],
  targets:[{missionId:"demoed-correctly",stepId:"park",bayIds:["bay"]}],
  vehicles:[{playerId:"p",x:0,y:0,z:0,heading:0,speed:0,lateral:0,halfLength:2.2,halfWidth:.95}],
  rules:[{edge:"road",side:"R",kind:"free",days:[],from:null,to:null,hourLimit:null,permitAreas:[]}],cleaning:[],
  clock:{isoWeekday:2,minute:600,weekOfMonth:2,holiday:false} };
const ctx: GameplayContext = {...DEFAULT_CATALOG,wave:3,bodies:[{id:"p",x:0,y:0,z:0,mode:"vehicle",speed:0}],commands:[],facts:[],actors:[],observations:[],day:1,month:1,missionParking:parking};
const missions = {...createMissions(),players:{p:{...createMissionProgress(),missionId:"demoed-correctly",stepId:"park",status:"active" as const,startedTick:1,visits:4}}};

describe("authoritative mission parking",()=>{
  it("requires two seconds of legal stopped full-hull parking and a new interact press; replay is idempotent",()=>{
    let own = prepareMissionParking(undefined,missions,ctx,1).state;
    for(let tick=2;tick<=120;tick++)own=prepareMissionParking(own,missions,{...ctx,actions:{p:Action.interact}},tick).state;
    expect(prepareMissionParking(own,missions,{...ctx,actions:{p:Action.interact}},121).facts).toEqual([]);
    own=prepareMissionParking(own,missions,ctx,121).state;
    const complete=prepareMissionParking(own,missions,{...ctx,actions:{p:Action.interact}},122);
    expect(complete.facts).toHaveLength(1);expect(complete.facts[0]).toMatchObject({kind:"demo.parkedLegally",playerId:"p",actorId:"bay"});
    expect(prepareMissionParking(complete.state,missions,{...ctx,actions:{p:Action.interact}},123).facts).toEqual([]);
    expect(prepareMissionParking(complete.state,missions,ctx,122).state).toBe(complete.state);
  });
  it("rejects unknown rules, sweeping, overlap beyond the bay and an elevated vehicle",()=>{
    const invalid=[{...parking,rules:[]},{...parking,cleaning:[{edge:"road",side:"R" as const,day:2,fromHour:9,toHour:12,weeks:[2],holidays:true}]},
      {...parking,vehicles:[{...parking.vehicles[0]!,x:1}]},{...parking,vehicles:[{...parking.vehicles[0]!,y:2}]}];
    for(const world of invalid){
      let own=prepareMissionParking(undefined,missions,{...ctx,missionParking:world},1).state;
      for(let tick=2;tick<=125;tick++){const next=prepareMissionParking(own,missions,{...ctx,missionParking:world,actions:{p:tick===125?Action.interact:0}},tick);expect(next.facts).toEqual([]);own=next.state;}
      expect(own.players.p!.completed).toBe(false);
    }
  });
});
