import {expect,it} from "vitest";
import {buildWorld} from "../../src/sim/world.ts";
import {createInitialState,step} from "../../src/sim/step.ts";
import {createPlayerSystems,gameplaySnapshot} from "../../src/sim/player/adapter.ts";
import {applyModeSettlements} from "../../src/sim/player/settlements.ts";
import {captureProgression,restoreProgression} from "../../src/save/progression.ts";

it("persists the payout ledger so returning again after reload cannot pay twice",()=>{
  const world=buildWorld([]),initialize=()=>step(world,createInitialState(world,1,["p1"],{x:0,z:0,heading:0}),{},[],createPlayerSystems());
  const payout={id:"local-1:p1",playerId:"p1",cashCents:10000,xp:200,achievements:["sweep-complete"],factionClockMoves:0 as const};
  const city=initialize(),before=JSON.stringify(city),paid=applyModeSettlements(city,[payout]);
  expect(JSON.stringify(city)).toBe(before);
  const loaded=restoreProgression(initialize(),captureProgression(paid,"p1"),"p1"),again=applyModeSettlements(loaded,[payout]);
  const first=gameplaySnapshot({state:paid}),second=gameplaySnapshot({state:again});
  expect(second.economy.players.p1!.cashCents).toBe(first.economy.players.p1!.cashCents);
  expect(second.progression.players.p1!.xp).toBe(first.progression.players.p1!.xp);
  expect(second.progression.players.p1!.achievements).toEqual(["sweep-complete"]);
  expect(second.economy.settledModeIds).toEqual([payout.id]);
});
