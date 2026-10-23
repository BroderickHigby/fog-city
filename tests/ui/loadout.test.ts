import {expect,it} from "vitest";
import {loadoutForMatch} from "../../src/ui/loadout.ts";
import {buildWorld} from "../../src/sim/world.ts";
import {createLocalMatch} from "../../src/sim/modes/playable.ts";
import {modeSessionOf} from "../../src/sim/modes/session.ts";
import {copyMatchLoadouts} from "../../src/sim/modes/session.ts";
import {createProgressionPlayer} from "../../src/sim/progression/system.ts";

it("launches a high-rank profile with more than three unlocked rewards using bounded slots",()=>{
  const profile={...createProgressionPlayer(),rank:25,perks:["lean","marine-layer","do-not-disturb","stealth-mode"],streaks:["delivery","parasols","cloud-cover","update"]};
  const before=JSON.stringify(profile),loadout=loadoutForMatch(profile);
  expect(()=>copyMatchLoadouts(["p1"],{p1:loadout})).not.toThrow();
  expect(loadout.perks).toEqual(profile.perks.slice(0,3));expect(loadout.streaks).toEqual(profile.streaks.slice(0,3));
  for(const mode of ["botSweep","cleanStreets"] as const){const match=createLocalMatch(buildWorld([]),{id:"high-rank",mode,seed:1,playerId:"p1",spawn:{x:0,z:0,heading:0},loadouts:{p1:loadout}});expect(modeSessionOf(match)?.loadouts.p1?.streaks).toHaveLength(3);}
  expect(JSON.stringify(profile)).toBe(before);
});
