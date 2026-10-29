import {describe,it,expect} from "vitest";
import {buildWorld,createInitialState} from "../../src/sim/index.ts";
import {createProgression,createProgressionPlayer} from "../../src/sim/progression/system.ts";
import {createEconomy,createWallet} from "../../src/sim/economy/system.ts";
import {loadoutProjection} from "../../src/ui/loadout.ts";
import {uiText} from "../../src/content/ui.ts";
function fixture(xp=0,rank=1){const state=createInitialState(buildWorld([]),1,["p"],{x:0,z:0,heading:0});state.ext.progression={...createProgression(),players:{p:{...createProgressionPlayer(),xp,rank}}};state.ext.economy={...createEconomy(),players:{p:createWallet()}};return state;}
describe("playable loadout choices",()=>{
 it("explains actual rank, purchase, and slot gates instead of offering invalid commands",()=>{
  const state=fixture(),view=loadoutProjection(state,"p",4,uiText)!;
  expect(view.choices.find(row=>row.id==="water-balloon")).toMatchObject({enabled:false,reason:uiText("ui.loadout.rankRequired",{rank:5})});
  expect(view.choices.find(row=>row.id==="wide-nozzle")?.enabled).toBe(false);
  expect(view.choices.filter(row=>row.group==="perk").some(row=>row.reason===uiText("ui.loadout.slotsFull"))).toBe(true);
  expect(loadoutProjection(state,"p",3,uiText)).toBeUndefined();state.version=20;expect(loadoutProjection(state,"p",4,uiText)).toBeUndefined();
 });
 it("exposes owned nozzles and only banked equipped, unreserved calls",()=>{
  const state=fixture(50000,30),profile=state.ext.progression!.players.p!;
  state.ext.economy!.players.p!.ownedItemIds=["wide-nozzle"];profile.streaks=["confidence"];profile.banked={confidence:1};
  const view=loadoutProjection(state,"p",4,uiText)!;
  expect(view.choices.find(row=>row.id==="wide-nozzle")?.enabled).toBe(true);
  expect(view.choices.find(row=>row.id==="confidence-score")).toMatchObject({selected:true,banked:1,callable:true});
  profile.pendingStreak={kind:"confidence",sequence:1};expect(loadoutProjection(state,"p",4,uiText)!.choices.find(row=>row.id==="confidence-score")?.callable).toBe(false);
 });
});
