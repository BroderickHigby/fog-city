/** Explicit stopped-world clock and historical identity regressions. */
import { expect,it } from "vitest";
import { buildWorld } from "../../src/sim/world.ts";
import { createInitialState } from "../../src/sim/step.ts";
import { createMissionProgress,createMissions } from "../../src/sim/missions/system.ts";
import { createActivities } from "../../src/sim/activities/system.ts";
import { createAgentsRuntime } from "../../src/sim/agents/runtime.ts";
import { holdPausedWorldTimers,activeWorldTick } from "../../src/sim/pause-timers.ts";
import { canonicalJson } from "../../src/sim/serialize.ts";
import type { SimState } from "../../src/sim/contract.ts";
const world=buildWorld([]);
function fixture():SimState {
  const state=createInitialState(world,7,["p1"],{x:0,z:0,heading:0});state.tick=100;state.ext.clock={version:1,elapsedTicks:500};
  state.ext.missions={...createMissions(100),players:{p1:{...createMissionProgress(),missionId:"timed",stepId:"wait",status:"active",startedTick:10,stepStartedTick:20,deadlineTick:200,actorAttempt:"attempt-10",visits:3}},events:[{id:1,tick:99,kind:"mission.stage",playerId:"p1",targetId:"timed",amount:0,detail:"attempt-10"}]};
  state.ext.activities={...createActivities(100),players:{p1:{nextDirectorTick:150,directorRng:[1,2,3,4],activeCardId:"card",cardUntilTick:160,cardCooldowns:{future:120,expired:90,unset:0,unlimited:Number.MAX_SAFE_INTEGER},activeActivityId:"plain-words",activityStartedTick:10,activityUntilTick:200,completedIds:[],commandSequence:3,cooldowns:{future:130,expired:90},plainWords:{boards:[{id:"board-1",word:1,wash:3,sprayedUntil:150,qualified:false}],rung:1,rebrands:0,washed:0,spinnerIds:["mission:plain-words:p1:a10:spinner-1"],rusted:[],nextRebrandTick:180}}}};
  state.ext.combat={version:1,tick:100,rng:[1,2,3,4],nextId:1,players:{},targets:{},projectiles:[],gadgets:[],attacks:[],attackSequence:{},events:[],pauseUntil:280};
  state.ext.doom={version:1,pausedUntil:250};return state;
}
it("freezes authored remaining duration while preserving mission/activity IDs, actual event history, bodies, RNG and outer pause controls",()=>{
  const before=fixture(),snapshot=canonicalJson(before),body=before.players.p1!.car,rng=before.rng,eventHistory=before.ext.missions!.events;let state=before;
  for(let index=0;index<180;index++)state=holdPausedWorldTimers(state);
  const mission=state.ext.missions!.players.p1!,activity=state.ext.activities!.players.p1!;
  expect(state.tick).toBe(280);expect(activeWorldTick(state)).toBe(100);expect(state.ext.clock).toEqual(before.ext.clock);
  expect(mission.startedTick).toBe(10);expect(mission.stepStartedTick).toBe(20);expect(mission.actorAttempt).toBe("attempt-10");expect(mission.deadlineTick-state.tick).toBe(100);expect(mission.stepPausedTicks).toBe(180);
  expect(activity.activityStartedTick).toBe(10);expect(state.tick-activity.activityStartedTick-(activity.pausedTicks??0)).toBe(90);expect(activity.activityUntilTick!-state.tick).toBe(100);expect(activity.plainWords!.spinnerIds).toEqual(before.ext.activities!.players.p1!.plainWords!.spinnerIds);
  expect(activity.plainWords!.boards[0]!.wash).toBe(3);expect(activity.plainWords!.boards[0]!.sprayedUntil).toBe(330);expect(activity.plainWords!.nextRebrandTick).toBe(360);
  expect(state.players.p1!.car).toBe(body);expect(state.rng).toBe(rng);expect(state.ext.missions!.events).toBe(eventHistory);expect(state.ext.combat!.pauseUntil).toBe(280);expect(state.ext.doom).toEqual(before.ext.doom);expect(canonicalJson(before)).toBe(snapshot);
});
it("never resurrects already expired or sentinel absolute timers",()=>{
  let state=fixture();state.ext.missions!.players.p1!.deadlineTick=90;state.ext.activities!.players.p1!.activityUntilTick=90;
  for(let index=0;index<180;index++)state=holdPausedWorldTimers(state);
  const mission=state.ext.missions!.players.p1!,activity=state.ext.activities!.players.p1!;
  expect(mission.deadlineTick).toBe(90);expect(mission.stepPausedTicks??0).toBe(0);expect(activity.activityUntilTick).toBe(90);expect(activity.pausedTicks??0).toBe(0);
  expect(activity.cardCooldowns).toEqual({future:300,expired:90,unset:0,unlimited:Number.MAX_SAFE_INTEGER});expect(activity.cooldowns!.expired).toBe(90);
});
it("preserves brain channel identity and completed-update history while freezing its live scheduler and TTL",()=>{
  const state=fixture(),runtime=createAgentsRuntime(state,{spawns:[{id:"robot",numericId:1,model:"footman",firmware:"bad",x:3,y:0,z:0,heading:0,radius:.4,height:1.8}]});
  const actor=runtime.actors.robot!,brain=actor.brain!;
  actor.brain={...brain,lastTick:100,windup:{target:{kind:"player",id:"p1"},attack:"shove",startedTick:80},update:null,knowledge:[{playerId:"p1",x:0,z:0,observedTick:50,expiresTick:650,channel:"sight"}],pendingUpdates:[{targetId:2,completedTick:90}]};actor.actionToken="80:shove:player:p1";state.ext.robots=runtime;
  const held=holdPausedWorldTimers(state),after=held.ext.robots!.actors.robot!;
  expect(after.actionToken).toBe(actor.actionToken);expect(after.brain!.windup!.startedTick).toBe(80);expect(after.brain!.windup!.pausedTicks).toBe(1);expect(after.brain!.lastTick).toBe(101);expect(after.brain!.knowledge[0]!.observedTick).toBe(50);expect(after.brain!.knowledge[0]!.expiresTick).toBe(651);expect(after.brain!.pendingUpdates).toEqual([{targetId:2,completedTick:90}]);expect(after.x).toBe(actor.x);expect(actor.brain!.windup!.pausedTicks).toBeUndefined();
});
it("keeps pre-SIM21 state byte-identical and a paused checkpoint roundtrip deterministic",()=>{
  const old={...fixture(),version:20};expect(holdPausedWorldTimers(old)).toBe(old);
  let one=fixture(),two=JSON.parse(JSON.stringify(one)) as SimState;
  for(let index=0;index<180;index++){one=holdPausedWorldTimers(one);two=holdPausedWorldTimers(two);}
  expect(canonicalJson(one)).toBe(canonicalJson(two));
});
it("holds paid Coit duration, evidence and correction windows without changing claim/session identities",()=>{
 const state=fixture(),activity=state.ext.activities!.players.p1!;
 activity.recon={found:[],scanning:"",scanTicks:0,viewer:{startedTick:10,untilTick:200,yaw:3,pitch:0,paidCents:25,commandSequence:7,closed:false,settled:false,observingId:"bot",observedTicks:50,lastObservedTick:100,observedBehavior:"hesitation",evidenceTick:90,taggedIds:[],flaggedIds:[],guide:{id:"coit-claim:10:landmark",landmarkId:"landmark",actualLabel:"Actual",claimedLabel:"Claim",startedTick:80,flagUntilTick:150,flagged:false,skipped:false},feedback:"",seed:1}};
 state.ext.progression={version:1,tick:100,nextId:1,players:{},grantCursors:{},events:[],doom:{months:24,lastDay:0,resets:1,winters:1,pausedUntil:200,winterUntilDay:1,winterUntilTick:1000,factions:{},factCursors:{}}};
 let held=state;for(let tick=0;tick<180;tick++)held=holdPausedWorldTimers(held);
 const viewer=held.ext.activities!.players.p1!.recon!.viewer!;
 expect(viewer.startedTick).toBe(10);expect(viewer.untilTick-held.tick).toBe(100);expect(viewer.pausedTicks).toBe(180);expect(viewer.guide!.id).toBe("coit-claim:10:landmark");expect(viewer.guide!.startedTick).toBe(80);expect(viewer.guide!.flagUntilTick-held.tick).toBe(50);expect(viewer.lastObservedTick).toBe(280);expect(viewer.observedTicks).toBe(50);expect(viewer.evidenceTick).toBe(270);expect(viewer.paidCents).toBe(25);
 expect(held.ext.progression!.doom!.winterUntilTick).toBe(1180);expect(held.ext.progression!.doom!.pausedUntil).toBe(200);expect(activity.recon.viewer!.startedTick).toBe(10);expect(activity.recon.viewer!.untilTick).toBe(200);
});
