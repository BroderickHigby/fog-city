import {expect,it} from "vitest";
import {createGameplayDispatcher} from "../../src/ui/commands.ts";
import {gameplayCommandFromEvent,type GameplayCommandEvent} from "../../src/sim/gameplay-contract.ts";
it("starts beyond the persisted zero cursor and shares one sequence across commands",()=>{
  const events:GameplayCommandEvent[]=[];
  const send=createGameplayDispatcher({playerId:"p1",tick:()=>12,emit:e=>events.push(e)});
  send({kind:"buy",itemId:"tank-1"});send({kind:"mission-ack"});
  expect(events.map(event=>gameplayCommandFromEvent(event)?.sequence)).toEqual([1,2]);
  expect(()=>send({kind:"startup-define",kitId:"raw text is forbidden"})).toThrow("Invalid UI gameplay command");
  expect(events).toHaveLength(2);
});
