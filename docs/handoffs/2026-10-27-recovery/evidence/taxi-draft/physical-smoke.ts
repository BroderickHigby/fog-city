// Serial heavy smoke. Run only after the parent grants the world/physics execution slot.
import { createHash } from "node:crypto";
import { readFileSync,writeFileSync,readdirSync } from "node:fs";
import { loadWorldFiles,buildWorldWithRoads } from "../../../tests/helpers.ts";
import { Wave3Driver } from "../../../tests/helpers/drivers/wave3-campaign.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { Action } from "../../../src/sim/contract.ts";
import type { SimInput } from "../../../src/sim/contract.ts";
import { createFollowerState,stepVehicleFollower } from "../../../src/sim/vehicles/follower.ts";
import { canonicalJson,hashState } from "../../../src/sim/serialize.ts";
import { createSfTaxiSession,createSfTaxiStepper,acceptedTaxiVehicle,acceptedTaxiPassenger,taxiSessionView,settleTaxiSession,encodeTaxiSession,decodeSfTaxiSession } from "../../../src/modes/taxi-session.ts";
import { agentsRuntimeOf } from "../../../src/sim/agents/runtime.ts";
import type { SfTaxiSession } from "../../../src/modes/taxi-session.ts";
import { gameplaySnapshot } from "../../../src/sim/player/adapter.ts";
import { createEconomy,createWallet } from "../../../src/sim/economy/system.ts";
import { createProgression,createProgressionPlayer } from "../../../src/sim/progression/system.ts";

const filesIn=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?filesIn(`${dir}/${entry.name}`):[`${dir}/${entry.name}`]);
const sources=[...filesIn("src/sim"),...filesIn("src/modes"),...filesIn("src/io"),...filesIn("src/content"),...filesIn("content"),...filesIn("public/tiles/sf").filter(path=>/\.json$|colliders.*\.bin$/.test(path)),"tests/helpers.ts","tests/helpers/drivers/wave3-campaign.ts","tests/e2e/gameplay-driver.ts","tests/e2e/campaign-driver.ts","test-results/consolidated/taxi-draft/physical-smoke.ts"].sort();
const sourceHash=()=>{const hash=createHash("sha256");for(const path of sources)hash.update(path).update("\0").update(readFileSync(path));return hash.digest("hex");};
const measuredSource=sourceHash(),files=loadWorldFiles("sf"),world=buildWorldWithRoads(files.tiles,files.roads,files.boundary,files);
const city=createInitialState(world,7,["p1"],files.manifest.spawn);city.ext.economy={...createEconomy(),players:{p1:createWallet()}};city.ext.progression={...createProgression(),players:{p1:createProgressionPlayer()}};
const campaignHash=hashState(city),cityCash=gameplaySnapshot({state:city}).economy.players.p1!.cashCents;
const tick=createSfTaxiStepper(world),events:unknown[]=[],trace:unknown[]=[],driverTrace:string[]=[];let sequence=0,maxMoveExcess=-1e9,minStopClearance=100000,minMovingClearance=100000,maxProtectedContacts=0;
const brake:SimInput={throttle:0,steer:0,brake:1,actions:0};
let session=createSfTaxiSession(world,city,{id:"taxi-physical-1",playerId:"p1",seed:1,shiftId:"night"},{wave:3});
function input(frame:SimInput,command?:"next"|"retry"|"cancel"|"exit"):void {
  const before=session.instance.players.p1!.car;
  session=tick(session,{p1:frame},command?[{sequence:++sequence,kind:command}]:[]);
  const after=session.instance.players.p1!.car,move=Math.hypot(after.x-before.x,after.z-before.z),allowed=Math.max(Math.hypot(before.speed,before.lateral),Math.hypot(after.speed,after.lateral))/60+.5;
  if(!command||command!=="retry")maxMoveExcess=Math.max(maxMoveExcess,move-allowed);
  const pose=acceptedTaxiVehicle(world,session.instance,"p1");
  if(pose)minMovingClearance=Math.min(minMovingClearance,pose.personClearanceM);maxProtectedContacts=Math.max(maxProtectedContacts,session.instance.ext.dodge?.contacts??0,session.instance.players.p1!.car.personBumps);
  if(session.taxi.trip.stopTicks>0&&pose)minStopClearance=Math.min(minStopClearance,pose.personClearanceM);
  for(const event of session.taxi.events)events.push({...event,pose});
  if(session.instance.tick%600===0)trace.push({tick:session.instance.tick,phase:session.taxi.phase,route:session.taxi.trip.routeId,remaining:session.taxi.trip.tripRemainingTicks,car:{x:after.x,y:after.y,z:after.z,speed:after.speed,grounded:after.grounded},reason:session.taxi.reason});
}
function driveAndInteract(wanted:"driving"|"fare-complete",limit=30_000):void {
  if(wanted==="fare-complete"){
    const driver=new Wave3Driver(world,session.instance,"p1",[],{budget:limit});
    driver.input=(frame:SimInput)=>{const before=session.instance;input(frame);driver.previousState=before;driver.state=session.instance;driver.frames.push({p1:frame});if(["timeout","finished","cancelled","exited"].includes(session.taxi.phase))throw new Error(`Taxi driving ended: ${session.taxi.phase} ${session.taxi.reason}; ${driver.trace.slice(-8).join("; ")}`);};
    const target=taxiSessionView(session).target!;
    const reached=driver.cruise(target,1.25,7,1500,limit);driverTrace.push(...driver.trace);
    if(!reached)throw new Error(`Physical driving stalled: ${driver.trace.slice(-12).join("; ")}`);
    for(let index=0;index<300&&session.taxi.phase!==wanted;index++)input({...brake,actions:session.taxi.trip.stopTicks>=taxiSessionView(session).stopRequiredTicks?Action.interact:0});
    if(session.taxi.phase===wanted)return;throw new Error(`Arrived but failed accepted ${wanted}: ${session.taxi.reason}`);
  }
  let follower=createFollowerState(session.instance.players.p1!.car);
  for(let index=0;index<limit;index++){
    if(session.taxi.phase===wanted)return;
    if(["timeout","finished","cancelled","exited"].includes(session.taxi.phase))throw new Error(`Taxi ended before ${wanted}: ${session.taxi.phase} ${session.taxi.reason}`);
    const view=taxiSessionView(session),car=session.instance.players.p1!.car,target=view.target;
    if(!target)throw new Error("Taxi has no physical target");
    const plan=stepVehicleFollower(world,car,follower,{kind:"pursue",target,stopDistance:1.25,maxSpeed:10});follower=plan.state;
    const ready=session.taxi.trip.stopTicks>=view.stopRequiredTicks;
    input({...plan.input,actions:ready?Action.interact:0});
  }
  throw new Error(`Physical driver did not reach ${wanted}`);
}
if(process.argv.includes("--diagnose")){
  const diagnostics:unknown[]=[{start:session.instance.players.p1!.car,route:taxiSessionView(session).route}];
  let follower=createFollowerState(session.instance.players.p1!.car);
  for(let index=0;index<300;index++){
    const target=taxiSessionView(session).target!,plan=stepVehicleFollower(world,session.instance.players.p1!.car,follower,{kind:"pursue",target,stopDistance:1.25,maxSpeed:10});follower=plan.state;input(plan.input);
    if([0,1,29,119,299].includes(index)){const actor=agentsRuntimeOf(session.instance)?.actors[session.taxi.trip.passengerId],body=(session.instance.ext.agents?.list??[]).find(value=>value.runtimeId===session.taxi.trip.passengerId);diagnostics.push({tick:session.instance.tick,reason:session.taxi.reason,car:session.instance.players.p1!.car,plan:{status:plan.status,input:plan.input,distance:plan.distanceToGoal},actor,body,accepted:acceptedTaxiPassenger(session.instance,session.taxi,session.config),sourceActors:Object.keys(agentsRuntimeOf(session.instance)?.actors??{}).filter(id=>id.startsWith("taxi-"))});}
  }
  writeFileSync("test-results/consolidated/taxi-draft/diagnostic.json",JSON.stringify(diagnostics,null,2)+"\n");process.stdout.write("diagnostic ready\n");process.exit(0);
}
let failure="";
try{
  driveAndInteract("driving",5400);driveAndInteract("fare-complete",30_000);
  const earned=session.taxi.totalCashCents;if(earned<=0)throw new Error("No earned fare");
  const saved=encodeTaxiSession(session),resumed=decodeSfTaxiSession(saved,world);if(!resumed||canonicalJson(resumed)!==canonicalJson(session))throw new Error("Checkpoint roundtrip changed the session");
  session=resumed;input(brake,"next");input(brake,"cancel");const priorFareIds=[...session.taxi.paidFareIds],priorAttempt=session.taxi.attempt;input(brake,"retry");
  if(session.taxi.attempt!==priorAttempt+1||session.taxi.totalCashCents!==earned||canonicalJson(session.taxi.paidFareIds)!==canonicalJson(priorFareIds))throw new Error("Retry lost earned fares or failed to create a unique attempt");
  input(brake,"exit");const done=settleTaxiSession(session),restored=done.restored!;
  if(gameplaySnapshot({state:restored}).economy.players.p1!.cashCents!==cityCash+earned)throw new Error("Aggregate city fare settlement mismatch");
  if(settleTaxiSession(done)!==done)throw new Error("Repeated settlement changed the completed session");
  if(canonicalJson({...restored,ext:{...restored.ext,economy:city.ext.economy,progression:city.ext.progression}})!==canonicalJson(city))throw new Error("Taxi altered unrelated campaign fields");
  if(hashState(city)!==campaignHash)throw new Error("Taxi mutated original campaign");
  session=createSfTaxiSession(world,restored,{id:"taxi-physical-2",playerId:"p1",seed:1,shiftId:"night"},{wave:3});sequence=0;
  for(let index=0;index<5500&&session.taxi.phase==="pickup";index++)input(brake);
  if(session.taxi.phase!=="timeout"||session.taxi.reason!=="pickup-timeout")throw new Error(`Expected physical pickup timeout, got ${session.taxi.phase}/${session.taxi.reason}`);
  const timedOutTrip=session.taxi.trip.id;input(brake,"retry");if(session.taxi.phase!=="pickup"||session.taxi.trip.id===timedOutTrip)throw new Error("Timeout Retry did not create a new pickup");
  driveAndInteract("driving",5400);
  if(maxMoveExcess>0||minStopClearance<.75||maxProtectedContacts>0)throw new Error("Physical movement/stop clearance bound failed");
}catch(error){failure=error instanceof Error?error.stack??error.message:String(error);}
const report={sourceFiles:sources,sourceHash:measuredSource,sourceUnchanged:sourceHash()===measuredSource,success:!failure,failure,campaignHash,phase:session.taxi.phase,attempt:session.taxi.attempt,route:session.taxi.trip.routeId,config:session.config,curbs:session.catalog.curbs,roads:session.catalog.roads,maxMoveExcess,minStopClearance,minMovingClearance,maxProtectedContacts,driverTrace,personBumps:session.instance.players.p1!.car.personBumps,dodgeContacts:session.instance.ext.dodge?.contacts??0,events,trace};
writeFileSync("test-results/consolidated/taxi-draft/physical-smoke.json",JSON.stringify(report,null,2)+"\n");
process.stdout.write(JSON.stringify({success:report.success,failure,phase:report.phase,events:events.length,maxMoveExcess,minStopClearance,sourceUnchanged:report.sourceUnchanged})+"\n");
if(failure||!report.sourceUnchanged)process.exitCode=1;
