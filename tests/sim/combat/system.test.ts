import { describe, expect, it } from "vitest";
import { canonicalJson, hashState } from "../../../src/sim/serialize.ts";
import { createCombatState, movementLimit, stepCombat } from "../../../src/sim/combat/system.ts";
import type { CombatActor, CombatContext, CombatInputs, CombatPlayer } from "../../../src/sim/combat/types.ts";

function freeze<T>(value:T):T { if(value && typeof value==="object") {Object.freeze(value);for(const item of Object.values(value))freeze(item);}return value; }
const player:CombatPlayer={id:"p1",x:0,y:0,z:0,heading:0,speed:0,mount:"foot",tankTier:0,flowTier:0,scannerTier:1};
function robot(id="bot",z=-4):CombatActor {return {id,x:0,y:0,z,radius:0.45,height:1.8,heading:0,speed:0,kind:"robot",firmware:"bad",model:"footman"};}
function context(actors:CombatActor[]=[robot()]):CombatContext {return {players:[player],actors,refills:[],walls:[],conversionCap:10};}
function run(ctx:CombatContext,ticks:number,input:CombatInputs) {let state=createCombatState(123,ctx);for(let n=0;n<ticks;n++)state=stepCombat(freeze(state),ctx,input);return state;}

describe("integrated combat reducer",()=>{
  it("actual particles seize a bot, then produce a collapsed heap and puddle",()=>{
    const ctx=freeze(context());let state=createCombatState(1,ctx);let seized=0;let heaps=0;let seizedTick=0;
    for(let n=0;n<430;n++) {
      state=stepCombat(freeze(state),ctx,{p1:{fire:n<300,aimPitch:0}});
      for(const event of state.events) {if(event.kind==="robot.seized"){seized++;seizedTick=state.tick;}if(event.kind==="robot.heap")heaps++;}
    }
    expect(seized).toBe(1);expect(heaps).toBe(1);expect(seizedTick).toBeLessThan(270);
    expect(state.targets.bot).toMatchObject({phase:"heap",puddle:true});
    expect(state.targets.bot!.heightScale).toBeLessThanOrEqual(.4);
    // Unlimited water (2026-10-23): the melt took real shots and the tank is still full.
    expect(state.players.p1!.water).toBe(8);
  });

  it("never reaches a protected actor or the robot behind it across fifty scenes",()=>{
    for(let seed=0;seed<50;seed++) {
      const subject:CombatActor={...robot("protected",-2),kind:seed%2?"animal":"person",firmware:"none",child:seed%3===0,posture:seed%3===1?"seated":"lying",radius:.7};
      const ctx=context([subject,robot()]);const state=run(ctx,180,{p1:{fire:true,aimPitch:0}});
      expect(state.targets.protected!.wetUntil).toBe(0);expect(state.targets.bot!.rust).toBe(0);
      expect(state.events.filter(e=>e.kind==="person.wet"||e.kind==="economy.penalty")).toHaveLength(0);
    }
  });

  it("has identical replay hashes for actor and player insertion permutations",()=>{
    const p2={...player,id:"p2",x:10};const actors=[robot("b"),robot("a",-8)];
    const a={...context(actors),players:[player,p2]}, b={...context([...actors].reverse()),players:[p2,player]};
    const inputs={p2:{scan:true},p1:{fire:true,aimPitch:0}};
    expect(hashState(run(a,180,inputs))).toBe(hashState(run(b,180,inputs)));
  });

  it("never drains water, keeps the fire rate, bounds particles and stays finite under sustained firing",()=>{
    const ctx=context([]);let state=createCombatState(1,ctx),shots=0;
    for(let n=0;n<900;n++){state=stepCombat(state,ctx,{p1:{fire:true,aimPitch:0}});shots+=state.events.filter(e=>e.kind==="weapon.water").length;}
    expect(state.players.p1!.water).toBe(8);expect(shots).toBe(150);expect(state.projectiles.length).toBeLessThan(40);
    expect(()=>canonicalJson(state)).not.toThrow();
  });

  it("water interrupts a live forced update before conversion",()=>{
    const attacker=robot("attacker"), target={...robot("helper",-6),firmware:"good" as const};
    const ctx={...context([attacker,target]),attacks:[{id:"update",sequence:1,attackerId:"attacker",targetId:"helper",kind:"forced-update" as const}]};
    let state=createCombatState(7,ctx);let interrupted=false,converted=false;
    for(let n=0;n<400;n++){state=stepCombat(state,ctx,{p1:{fire:n<80,aimPitch:0}});interrupted ||=state.events.some(e=>e.kind==="update.interrupted");converted ||=state.events.some(e=>e.kind==="robot.converted");}
    expect(interrupted).toBe(true);expect(converted).toBe(false);
  });

  it("a real cone hit emits a three-second stop constraint and cannot be spammed",()=>{
    const taxi={...robot("taxi",-6),model:"robotaxi" as const,heading:Math.PI,speed:25,obeysTraffic:true};
    const ctx=context([taxi]);let state=createCombatState(1,ctx);let stopTick=0;
    for(let n=0;n<280;n++) {
      state=stepCombat(state,ctx,{p1:{cone:true,aimPitch:0}});
      if(state.events.some(e=>e.kind==="vehicle.pull-over"))stopTick=state.tick;
    }
    expect(state.players.p1!.cones).toBe(2);expect(stopTick).toBeGreaterThan(0);
    expect(movementLimit(state,taxi).maxSpeed).toBe(0);
    expect(state.targets.taxi!.pullOverTick-stopTick).toBe(180);
  });

  it("rejects duplicate IDs and nonfinite poses instead of poisoning replay state",()=>{
    expect(()=>createCombatState(1,context([robot(),robot()]))).toThrow(/unique/);
    expect(()=>createCombatState(1,context([{...robot(),x:NaN}]))).toThrow(/finite/);
    for(const id of ["__proto__","constructor","toString","prototype"]) expect(()=>createCombatState(1,context([robot(id)]))).toThrow(/unique/);
    expect(()=>createCombatState(1,{...context(),attacks:Array(4097).fill({})})).toThrow(/budget/);
  });

  it("leaves a stationary actor free to accelerate and keeps canonical player constraints",()=>{
    const actor={...robot("player:p1"),kind:"player" as const,playerId:"p1",firmware:"none" as const,robotBody:false};
    const ctx=context([actor]);let state=createCombatState(1,ctx);
    expect(movementLimit(state,actor)).toEqual({maxSpeed:null,scale:1,blind:false,canAttack:true});
    state.targets.p1!.stoppedUntil=20;
    state=stepCombat(freeze(state),ctx);
    expect(movementLimit(state,actor)).toMatchObject({maxSpeed:0,scale:0,canAttack:false});
  });

  it("a cone striking a taxi's rear blinds it but does not attach to the hood",()=>{
    const taxi={...robot("taxi",-6),model:"robotaxi" as const,heading:0,obeysTraffic:true};
    const state=run(context([taxi]),75,{p1:{cone:true}});
    expect(state.targets.taxi!.blindUntil).toBeGreaterThan(75);
    expect(state.targets.taxi!.pullOverTick).toBe(0);
  });

  it("a cleared heap cannot be rebuilt while its actor remains in context",()=>{
    const ctx=context([{...robot(),inFidelity:false}]);let state=createCombatState(1,ctx);
    Object.assign(state.targets.bot!,{phase:"heap",heightScale:.3,puddle:true});
    state=stepCombat(state,ctx);
    expect(state.events.filter(e=>e.kind==="robot.heap-cleared")).toHaveLength(1);
    state=stepCombat(freeze(state),ctx);
    expect(state.targets.bot).toMatchObject({phase:"cleared",heightScale:0,puddle:false,movementScale:0});
    expect(state.events.filter(e=>e.kind==="robot.heap-cleared")).toHaveLength(0);
  });
});
