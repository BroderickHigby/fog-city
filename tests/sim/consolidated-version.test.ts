import { describe, expect, it } from "vitest";
import { SIM_VERSION, canonicalJson, createGameSystems, hashState, step, upgradeState, type InputFrame, type SimEvent, type SimState } from "../../src/sim/index.ts";
import saved from "../golden/legacy-saves/v20-pre-consolidated.json";
import { loadDevWorldWithRoads } from "./fixtures.ts";

describe("SIM20 saves and replay through consolidated activities",()=>{
 it("migrates the actual main save without replacing progress or optional extensions",()=>{
  expect(saved.sourceCommit).toBe("66b1e6f51fd1799612d6319980fca7f2241b17a9");
  expect(saved.state.version).toBe(20);
  const before=canonicalJson(saved.state),old=saved.state as unknown as SimState;
  expect(hashState(old)).toBe(saved.hash);
  const result=upgradeState(old);
  expect(SIM_VERSION).toBe(32);
  expect(result).toEqual({...old,version:SIM_VERSION});
  expect(result.ext).toBe(old.ext);expect(result.players).toBe(old.players);
  expect(canonicalJson(saved.state)).toBe(before);
 });
 it("retains the original main continuation without upgrading",()=>{
  const {world}=loadDevWorldWithRoads(),systems=createGameSystems({wave:3});
  let state=saved.state as unknown as SimState;
  const hashes:string[]=[];
  for(const [index,frame] of saved.frames.entries()){
   state=step(world,state,frame.inputs as InputFrame,frame.events as SimEvent[],systems);
   if(index%30===29)hashes.push(hashState(state));
  }
  expect(state.version).toBe(20);expect(hashes).toEqual(saved.originalHashesEvery30);
 });
 it("continues upgraded state identically across a mid-route JSON restore",()=>{
  const {world}=loadDevWorldWithRoads(),systems=createGameSystems({wave:3});
  const run=(restore:boolean)=>{
   let state=upgradeState(saved.state as unknown as SimState);
   for(const [index,frame] of saved.frames.entries()){
    state=step(world,state,frame.inputs as InputFrame,frame.events as SimEvent[],systems);
    if(restore&&index===79)state=JSON.parse(canonicalJson(state)) as SimState;
   }
   return state;
  };
  expect(hashState(run(true))).toBe(hashState(run(false)));
 });
});
