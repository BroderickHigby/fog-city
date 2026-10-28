/** SIM24 physical combat and once-only authority regressions. */
import { describe,expect,it } from "vitest";
import { createCombatState,stepCombat } from "../../../src/sim/combat/system.ts";
import { launchBalloon,stepDevices } from "../../../src/sim/combat/devices.ts";
import { applyFlowerHit,launchFlowers } from "../../../src/sim/combat/flowers.ts";
import { holdCombatTimers } from "../../../src/sim/combat/pause.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import { canonicalJson } from "../../../src/sim/serialize.ts";
import type { CombatActor,CombatContext,CombatPlayer,CombatState,Projectile } from "../../../src/sim/combat/types.ts";
const player=(id="p",x=0):CombatPlayer=>({id,x,y:0,z:0,heading:0,speed:0,mount:"foot",tankTier:0,flowTier:0,scannerTier:1,gadget:"balloon",gadgetEnabled:true,gear:"none"});
const actor=(id:string,patch:Partial<CombatActor>={}):CombatActor=>({id,kind:"robot",firmware:"bad",model:"footman",x:2,y:0,z:0,heading:0,speed:0,radius:.35,height:1.8,...patch});
const body=(id:string,z=0):CombatActor=>actor(`player:${id}`,{kind:"player",firmware:"none",playerId:id,robotBody:false,x:0,z});
const context=(patch:Partial<CombatContext>={}):CombatContext=>({simVersion:24,wave:5,players:[player(),{...player("r"),z:-6}],actors:[body("p"),body("r",-6)],mode:"clean-streets",rivalPlayerIds:{p:["r"],r:["p"]},walls:[],refills:[],...patch});
const roundtrip=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
function hitProjectile(state:CombatState):Projectile {return {id:999,kind:"flower",ownerId:"p",x:0,y:1,z:-6,vx:0,vy:0,vz:-12,bornTick:state.tick,distance:6,range:20,volume:0,salt:false,vehicle:false,rustRate:0};}

describe("SIM24 selected combat recovery",()=>{
  it("launches a visible slow flower and scores only its later actual rival contact",()=>{
    const ctx=context();let state=createCombatState(7,ctx);
    state=stepCombat(state,ctx,{p:{altFire:true,aimPitch:.1}});
    expect(state.projectiles.some(value=>value.kind==="flower")).toBe(true);expect(state.events.some(value=>value.kind==="pvp.score")).toBe(false);
    let score=0,hits=0;
    for(let tick=0;tick<45;tick++){state=stepCombat(state,ctx,{p:{altFire:true,aimPitch:.1}});score+=state.events.filter(value=>value.kind==="pvp.score").reduce((sum,value)=>sum+value.amount,0);hits+=state.events.filter(value=>value.kind==="pvp.flower-hit").length;}
    expect(score).toBe(25);expect(hits).toBe(1);expect(state.targets.r!.flowersUntil).toBe(Number.MAX_SAFE_INTEGER);expect(state.players.p!.nextFlowerTick).toBe(91);
  });
  it.each(["npc","wall"] as const)("a physical %s intercepts a modern lob without scoring or affecting protected people",kind=>{
    const ctx=context(kind==="npc"?{actors:[body("p"),actor("civilian",{kind:"person",firmware:"none",protected:true,x:0,z:-3}),body("r",-6)]}:{walls:[{id:"wall",minX:-2,maxX:2,minY:0,maxY:5,minZ:-3.1,maxZ:-3}]});let state=createCombatState(7,ctx);let score=0;
    for(let tick=0;tick<60;tick++){state=stepCombat(state,ctx,{p:{altFire:true,aimPitch:.1}});score+=state.events.filter(value=>value.kind==="pvp.score").length;}
    expect(score).toBe(0);expect(state.targets.r!.flowersUntil).toBe(0);expect(state.targets.civilian?.flowersUntil??0).toBe(0);expect(state.targets.civilian?.rust??0).toBe(0);
  });
  it("rechecks team/owner authority at contact and rejects protected target metadata",()=>{
    const ctx=context();let state=createCombatState(7,ctx);state=stepCombat(state,ctx,{p:{altFire:true,aimPitch:.1}});
    const changed={...ctx,rivalPlayerIds:{p:[],r:[]}};
    for(let tick=0;tick<45;tick++){state=stepCombat(state,changed,{});expect(state.events.some(value=>value.kind==="pvp.score")).toBe(false);}
    for(const protectedField of [{protected:true},{child:true},{mobilityAid:true},{posture:"seated" as const}]){const own=createCombatState(7,ctx);applyFlowerHit(own,ctx,hitProjectile(own),{...body("r",-6),...protectedField});expect(own.events).toEqual([]);}
  });
  it("keeps a bounded durable contact receipt so direct duplicate/reloaded contacts cannot score twice",()=>{
    const ctx=context(),state=createCombatState(7,ctx),projectile=hitProjectile(state);
    applyFlowerHit(state,ctx,projectile,ctx.actors[1]!);expect(state.events.filter(value=>value.kind==="pvp.score")).toHaveLength(1);
    const restored=roundtrip(state),before=canonicalJson(restored);applyFlowerHit(restored,ctx,projectile,ctx.actors[1]!);expect(canonicalJson(restored)).toBe(before);expect(restored.flowerReceipts).toHaveLength(1);
  });
  it("accepts consecutive same-kind authorized grants despite held controls and acknowledges rejected replays once",()=>{
    const base=context({wave:4,players:[player()],actors:[actor("bad")]}),state=createCombatState(7,base);state.tick=1;
    for(const sequence of [1,2]){stepDevices(state,{...base,streaks:[{playerId:"p",kind:"confidence",sequence}]},{p:{streak:"confidence"}});state.players.p!.held=["streak"];state.tick++;}
    expect(state.events.filter(event=>event.kind==="streak.used")).toHaveLength(2);expect(state.players.p!.streakSequence.confidence).toBe(2);
    const blocked={...base,actors:[actor("person",{kind:"person",firmware:"none",x:0})],streaks:[{playerId:"p",kind:"parrots" as const,sequence:7}]};
    stepDevices(state,blocked,{p:{streak:"parrots"}});stepDevices(state,blocked,{p:{streak:"parrots"}});expect(state.events.filter(event=>event.kind==="streak.rejected"&&event.amount===7)).toHaveLength(1);
  });
  it("natural AGI deduplicates world sequence and overlapping players, and pause acknowledgment never retriggers it",()=>{
    const base=context({wave:4,players:[player(),player("q",1)],actors:[actor("bad"),actor("protected",{protected:true}),actor("good",{firmware:"good"}),actor("far",{x:600})],worldAgiSequence:1});let state=createCombatState(7,base);
    state=stepCombat(state,base,{});expect(state.targets.bad!.rust).toBeCloseTo(.6);expect(state.targets.protected!.rust).toBe(0);expect(state.targets.good!.rust).toBe(0);expect(state.targets.far!.rust).toBe(0);expect(state.pauseUntil).toBe(181);
    state=stepCombat(state,{...base,worldAgiSequence:2},{});expect(state.worldAgiSequence).toBe(2);expect(state.pauseUntil).toBe(181);expect(state.targets.bad!.rust).toBeCloseTo(.6);
    state={...state,tick:181};state=stepCombat(state,{...base,worldAgiSequence:2},{});expect(state.pauseUntil).toBe(181);expect(state.targets.bad!.rust).toBeCloseTo(.6);
  });
  it("only an accepted attack windup marks a fresh robot as having attacked",()=>{
    const bot=actor("bot",{x:1.2}),base=context({wave:4,players:[player()],actors:[bot]}),before=createCombatState(7,base);
    expect(before.targets.bot!.hasAttacked).toBe(false);
    const request={id:"bot:1",sequence:1,attackerId:"bot",targetId:"p",kind:"shove" as const};
    const denied=stepCombat(before,{...base,attacks:[request],walls:[{id:"wall",minX:.5,maxX:.7,minY:0,maxY:3,minZ:-1,maxZ:1}]},{});expect(denied.targets.bot!.hasAttacked).toBe(false);
    const accepted=stepCombat(denied,{...base,attacks:[{...request,id:"bot:2",sequence:2}]},{});expect(accepted.targets.bot!.hasAttacked).toBe(true);expect(accepted.attacks).toHaveLength(1);
    const unknown=createCombatState(7,{...base,simVersion:20});unknown.attackSequence.bot=3;const lifted=stepCombat(unknown,base,{});expect(lifted.targets.bot!.hasAttacked).toBe(true);
  });
  it("keeps SIM20 device/flower actions inert and the historical state shape free of new receipts",()=>{
    const ctx=context({simVersion:20}),before=createCombatState(7,ctx),after=stepCombat(before,ctx,{p:{altFire:true,gadget:"balloon",gear:true,streak:"agi"}});
    expect(after.projectiles).toEqual([]);expect(after.gadgets).toEqual([]);expect(after.pauseUntil).toBe(0);expect(after.events).toEqual([]);expect(Object.hasOwn(after,"flowerReceipts")).toBe(false);
    const standalone=createCombatState(7,ctx);launchFlowers(standalone,ctx,{p:{altFire:true}});stepDevices(standalone,ctx,{p:{streak:"agi"}});expect(standalone.events).toEqual([]);
  });
  it("requires equipped gadget ownership, fresh edge, cooldown and finite ballistics",()=>{
    const ctx=context({wave:4,players:[player()],actors:[]}),state=createCombatState(7,ctx);state.tick=1;
    const mismatched={...player(),gadget:"speaker" as const};expect(launchBalloon(state,mismatched,{gadget:"balloon"})).toBeNull();
    for(const gadgetEnabled of [undefined,false])expect(launchBalloon(state,{...player(),gadgetEnabled},{gadget:"balloon"})).toBeNull();expect(state.players.p!.balloons).toBe(2);
    const launched=launchBalloon(state,player(),{gadget:"balloon",aimYaw:NaN,aimPitch:Infinity})!;expect([launched.vx,launched.vy,launched.vz].every(Number.isFinite)).toBe(true);expect(state.players.p!.balloons).toBe(1);
    state.players.p!.held=["gadget"];state.tick+=200;expect(launchBalloon(state,player(),{gadget:"balloon"})).toBeNull();
  });
  it("does not consume a streak on wrong ownership, unsafe placement or a reused grant",()=>{
    const p=player(),ctx=context({wave:4,players:[p],actors:[actor("human",{kind:"person",firmware:"none",x:0})],streaks:[{playerId:"p",kind:"parrots",sequence:1}]}),state=createCombatState(7,ctx);state.tick=1;
    stepDevices(state,ctx,{p:{streak:"parrots",targetX:0,targetZ:0}});expect(state.players.p!.streakSequence.parrots).toBe(1);expect(state.events.filter(event=>event.kind==="streak.rejected")).toHaveLength(1);expect(state.gadgets).toEqual([]);
    const safe={...ctx,actors:[],devicePlacementAllowed:()=>true,streaks:[{playerId:"p",kind:"parrots" as const,sequence:2}]};stepDevices(state,safe,{p:{streak:"parrots",targetX:0,targetZ:0}});expect(state.gadgets).toHaveLength(1);expect(state.players.p!.streakSequence.parrots).toBe(2);
    state.tick++;stepDevices(state,safe,{p:{streak:"parrots",targetX:0,targetZ:0}});expect(state.gadgets).toHaveLength(1);
  });
  it("uses actual microclimate fog state and rusts only nearby bad robots",()=>{
    const p={...player(),gear:"microclimate" as const},ctx=context({wave:4,players:[p],actors:[actor("bad"),actor("good",{firmware:"good",z:2}),actor("person",{kind:"person",firmware:"none",x:20})]}),state=createCombatState(7,ctx);state.tick=1;
    stepDevices(state,ctx,{p:{gear:true}});expect(state.gadgets.find(value=>value.kind==="microclimate")?.radius).toBe(8);expect(state.players.p!.gearUntil).toBe(1201);expect(state.targets.bad!.rust).toBeGreaterThan(0);expect(state.targets.good?.rust??0).toBe(0);expect(state.targets.person?.rust??0).toBe(0);
  });
  it("requires a continuous stopped safe three-second Tensor load and consumes the crate once",()=>{
    const state=createCombatState(7,context({wave:4,players:[player()],actors:[]}));
    state.gadgets=[{id:90,kind:"tensor",ownerId:"p",x:0,y:0,z:0,untilTick:5000,targetId:"",radius:3,progress:0,boost:"salt"}];
    const load=(ctx=context({wave:4,players:[player()],actors:[]}))=>{state.tick++;stepDevices(state,ctx,{p:{boost:"pressure"}});};
    for(let tick=0;tick<100;tick++)load();expect(state.gadgets[0]!.progress).toBe(100);
    load(context({wave:4,players:[{...player(),y:4}],actors:[]}));expect(state.gadgets[0]!.progress).toBe(0);
    load(context({wave:4,players:[{...player(),speed:.3}],actors:[]}));expect(state.gadgets[0]!.progress).toBe(0);
    load(context({wave:4,players:[player()],actors:[actor("human",{kind:"person",firmware:"none",x:2})]}));expect(state.gadgets[0]!.progress).toBe(0);
    for(let tick=0;tick<179;tick++)load();expect(state.players.p!.boost).toBe("none");expect(state.gadgets).toHaveLength(1);
    load();expect(state.players.p!.boost).toBe("pressure");expect(state.gadgets).toHaveLength(0);expect(state.events.filter(event=>event.kind==="tensor.loaded")).toHaveLength(1);
    load();expect(state.events.filter(event=>event.kind==="tensor.loaded")).toHaveLength(1);
  });
  it("freezes combat motion, resources, progress and every newer timer across JSON restore",()=>{
    const ctx=context({wave:4,players:[player()],actors:[actor("bot")]}),before=createCombatState(7,ctx);before.tick=10;before.pauseUntil=191;before.targets.bot={...initialTarget(),lastWaterTick:0,lastDirectWaterTick:0,wetUntil:40};before.players.p!.gearUntil=30;before.players.p!.scanTicks=7;before.players.p!.refillTicks=9;before.maintenanceChannels={channel:{id:"channel",sequence:1,kind:"collect-heap",actorId:"bot",workerId:"worker",startedTick:0,lastTick:10}};before.flowerReceipts=[{projectileId:9,ownerId:"p",untilTick:100}];
    const snapshot=canonicalJson(before);let first=before,second=roundtrip(before);
    for(let index=0;index<180;index++){first=stepCombat(first,ctx,{p:{fire:true,gadget:"balloon",gear:true}});second=stepCombat(second,ctx,{p:{fire:true,gadget:"balloon",gear:true}});expect(second).toEqual(first);}
    expect(canonicalJson(before)).toBe(snapshot);expect(first.players.p!.gearUntil).toBe(210);expect(first.players.p!.scanTicks).toBe(7);expect(first.players.p!.refillTicks).toBe(9);expect(first.targets.bot!.lastDirectWaterTick).toBe(180);expect(first.maintenanceChannels!.channel!.startedTick).toBe(180);expect(first.flowerReceipts![0]!.untilTick).toBe(280);expect(first.pauseUntil).toBe(191);expect(first.events).toEqual([]);expect(first.rng).toEqual(before.rng);
  });
  it("preserves unlimited sentinel deadlines and prunes departed owners during a pause",()=>{
    const ctx=context(),state=createCombatState(7,ctx);state.tick=10;state.targets.r!.flowersUntil=Number.MAX_SAFE_INTEGER;state.players.p!.nextConeTick=0;state.gadgets=[{id:99,kind:"speaker",ownerId:"departed",x:0,y:0,z:0,untilTick:20,targetId:"",radius:10,progress:0,boost:"salt"}];holdCombatTimers(state);expect(state.targets.r!.flowersUntil).toBe(Number.MAX_SAFE_INTEGER);expect(state.players.p!.nextConeTick).toBe(0);expect(state.gadgets).toEqual([]);
  });
});
