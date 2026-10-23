import { expect,it } from "vitest";
import { Room } from "../../server/net/room.ts";
import { Prediction } from "../../src/net/prediction.ts";
import { worldLoader } from "../../server/net/world.ts";
import { ROOT } from "../helpers.ts";
import { hashState } from "../../src/sim/serialize.ts";
import type { ServerMessage } from "../../src/net/protocol.ts";

it("defaults server and prediction to the same actual gameplay composition",async()=>{
  const bundle=await worldLoader(`${ROOT}/public`)("dev"),world=bundle.world,messages:ServerMessage[]=[];
  const room=new Room("ABCDEFGHJK",bundle,0,7);
  const client=new Prediction(world,()=>{throw new Error("gameplay desync");});
  const id=room.join({close(){},send(message){messages.push(message);if(message.type!=="error")client.receive(structuredClone(message));}},0);
  for(let tick=0;tick<180;tick++)room.tick(tick*1000/60);
  expect(hashState(client.confirmed)).toBe(hashState(room.state));
  expect(room.state.ext.combat?.players[id]).toBeDefined();
  expect(room.state.ext.clock).toBeDefined();expect(room.state.ext.player?.players[id]).toBeDefined();
  expect(messages.filter(m=>m.type==="frame"&&m.hash)).toHaveLength(3);
});
