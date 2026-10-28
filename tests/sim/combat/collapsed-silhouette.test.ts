import { describe, expect, it } from "vitest";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { advanceProjectile, PROJECTILE_GRAVITY } from "../../../src/sim/combat/physics.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { initialTarget } from "../../../src/sim/combat/shared.ts";
import type { CombatActor, Projectile, TargetCombat } from "../../../src/sim/combat-contract.ts";

const world=buildWorld([]);
const heap:CombatActor={id:"heap",kind:"robot",model:"footman",firmware:"bad",x:4,y:0,z:0,radius:.45,height:2,heading:0,speed:0};
const behind:CombatActor={...heap,id:"behind",x:7};
function context(phase:TargetCombat["phase"],heightScale:number,version=24,actor=heap){
 const state={...createInitialState(world,1,["p"],{x:0,z:10,heading:0}),version};
 const base=contextFromState(world,state,{extraActors:[actor,behind]});
 const combat=createCombatState(1,base);
 combat.targets.heap={...initialTarget(),rust:1,phase,heightScale};
 state.ext={...state.ext,combat};
 const before=JSON.stringify(state);
 const result=contextFromState(world,state,{extraActors:[actor,behind]});
 expect(JSON.stringify(state)).toBe(before);
 return result;
}
function shot(y:number):Projectile{return {id:1,kind:"water",ownerId:"owner",x:0,y,z:0,vx:600,vy:PROJECTILE_GRAVITY/120,vz:0,distance:0,range:30,bornTick:0,volume:.08,salt:false,vehicle:false,rustRate:1};}

describe("collapsed robot projectile silhouettes, SIM24",()=>{
 it("lets a stream above the visible heap reach the object behind it, while low water still hits the solid heap",()=>{
  const ctx=context("heap",.3);
  expect(advanceProjectile(shot(1),ctx).hit?.id).toBe("behind");
  expect(advanceProjectile(shot(.25),ctx).hit?.id).toBe("heap");
 });
 it("tracks partial collapse and keeps seized/disabled robots at standing height",()=>{
  expect(advanceProjectile(shot(1.5),context("slumping",.5)).hit?.id).toBe("behind");
  expect(advanceProjectile(shot(.75),context("slumping",.5)).hit?.id).toBe("heap");
  for(const phase of ["active","seized","disabled"] as const)expect(advanceProjectile(shot(1),context(phase,.3)).hit?.id).toBe("heap");
 });
 it("removes collected robot bodies but never shrinks protected interception geometry",()=>{
  expect(advanceProjectile(shot(.25),context("cleared",0)).hit?.id).toBe("behind");
  for(const actor of [{...heap,protected:true},{...heap,kind:"person" as const,child:true},{...heap,kind:"animal" as const}]){
   expect(advanceProjectile(shot(1),context("heap",.3,24,actor)).hit?.id).toBe("heap");
  }
 });
 it("preserves the standing cylinder for earlier recorded versions",()=>{
  expect(advanceProjectile(shot(1),context("heap",.3,20)).hit?.id).toBe("heap");
 });
});
