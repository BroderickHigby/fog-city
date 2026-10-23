import { expect, it } from "vitest";
import { Room } from "../../server/net/room.ts";
import { Prediction } from "../../src/net/prediction.ts";
import { baseSimulation, type NetworkSimulation } from "../../src/net/simulation.ts";
import { buildWorld } from "../../src/sim/world.ts";
import { hashState } from "../../src/sim/serialize.ts";
import type { WorldBundle } from "../../server/net/world.ts";

it("runs the same gameplay driver and authenticated commands in relay and prediction",()=>{
  const world=buildWorld([]);
  const bundle:WorldBundle={name:"dev",world,spawn:{x:0,z:0,heading:0},fingerprint:"a".repeat(64)};
  const simulation:NetworkSimulation={...baseSimulation,step(world,state,inputs,events=[]){
    const next=baseSimulation.step(world,state,inputs,events);
    return {...next,ext:{...next.ext,score:{value:Number((state.ext.score as {value:number}|undefined)?.value??0)+1,commands:events.filter(e=>e.kind==="gameplay.command")}}};
  }};
  const client=new Prediction(world,()=>{throw new Error("unexpected divergence");},simulation);
  const room=new Room("ABCDEFGHJK",bundle,0,7,simulation);
  const id=room.join({close(){},send(message){if(message.type!=="error")client.receive(structuredClone(message));}},0);
  room.command(id,{sequence:0,kind:"mission-start",targetId:"hot-desk"});
  expect(()=>room.command(id,{sequence:0,kind:"mission-start",targetId:"hot-desk"})).toThrow(/sequence/);
  const first=room.tick(1);
  expect(first.events.find(e=>e.kind==="gameplay.command")?.playerId).toBe(id);
  for(let tick=2;tick<=120;tick++)room.tick(tick);
  expect(hashState(client.confirmed)).toBe(hashState(room.state));
  expect((room.state.ext.score as {value:number}).value).toBe(120);
});
