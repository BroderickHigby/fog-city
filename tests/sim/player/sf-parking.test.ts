import { expect, it } from "vitest";
import { sfWorld, CITY_MS } from "../world/load.ts";
import { readJson } from "../../helpers.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { createMissions, createMissionProgress } from "../../../src/sim/missions/system.ts";
import { buildMissionParkingWorld } from "../../../src/sim/missions/parking-world.ts";
import { checkParking } from "../../../src/sim/missions/mechanics/parking.ts";
import type { ParkingLayer, StreetCleaningLayer } from "../../../src/sim/parking-data.ts";

it("offers a legal full-hull bay for the real Pier 70 mission from committed road and cleaning rules",()=>{
  const world=sfWorld().world, parking=readJson<ParkingLayer>("public/tiles/sf/parking.json"), cleaning=readJson<StreetCleaningLayer>("public/tiles/sf/street-cleaning.json");
  const start=createInitialState(buildWorld([]),319,["p"],{x:0,z:0,heading:0});
  const state={...start,ext:{...start.ext,missions:{...createMissions(),players:{p:{...createMissionProgress(),missionId:"demoed-correctly",stepId:"park",status:"active" as const,startedTick:1,visits:4}}}}};
  const source=JSON.stringify({parking,cleaning});
  const context={world,state,previous:state,inputs:{},events:[]};
  const result=buildMissionParkingWorld(context,parking.rules,cleaning.rules);
  expect(result.bays.length).toBeGreaterThan(0);
  expect(result.bays.length).toBeLessThanOrEqual(64);
  const legal=result.bays.filter(bay=>checkParking({playerId:"p",...bay,speed:0,lateral:0,halfLength:2.2,halfWidth:.95,height:1.4},bay,{...result,requests:[]},state.tick,30).legal);
  expect(legal.length,`No legal signed parking at ${JSON.stringify(result.clock)}`).toBeGreaterThan(0);
  expect(result.targets[0]!.bayIds).toContain(legal[0]!.id);
  expect(buildMissionParkingWorld(context,parking.rules,cleaning.rules)).toEqual(result);
  expect(JSON.stringify({parking,cleaning})).toBe(source);
},CITY_MS);
