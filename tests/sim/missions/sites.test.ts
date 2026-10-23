import { expect,it } from 'vitest';
import { loadWorld } from '../../helpers.ts';
import { CAMPAIGN_MISSIONS } from '../../../src/content/catalog.ts';
import { createInitialState,step } from '../../../src/sim/index.ts';
import { groundWater,nearbyBuildings,pointInPolygon } from '../../../src/sim/world.ts';
import { campaignOf,placePosition } from '../../../src/sim/missions/runtime.ts';
it('stages every campaign actor on land outside real SF building footprints',()=>{
 const {world}=loadWorld('sf');let count=0;
 for(const mission of CAMPAIGN_MISSIONS)for(const stage of mission.steps){
  if(stage.type!=='stage')continue;
  const p=placePosition(stage.place);let state=createInitialState(world,17,['p1'],{...p,heading:0});
  state.ext.missions={players:{p1:{missionId:mission.id,stepId:stage.id,entered:0,question:0,watchTicks:0,cash:0,completed:[],unlocks:[],meters:{},sequence:1,status:'active',line:null,threat:0,unseenTicks:0,counted:[],reply:''}},actors:{}};
  state=step(world,state,{});
  for(const actor of Object.values(campaignOf(state)!.actors)){
   count++;expect(groundWater(world,actor.x,actor.z),actor.id).toBe(false);
   expect(nearbyBuildings(world,actor.x,actor.z,1).some(b=>b.topY>actor.y+.5&&pointInPolygon(actor.x,actor.z,b.footprint)),actor.id).toBe(false);
  }
 }
 expect(count).toBeGreaterThan(0);
},60000);
