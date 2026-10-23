import {expect,it} from "vitest";
import {buildWorld} from "../../src/sim/world.ts";
import {createInitialState,step} from "../../src/sim/step.ts";
import {createPlayerSystems} from "../../src/sim/player/adapter.ts";
import {ProgressionSession} from "../../src/save/session.ts";
import {captureProgression} from "../../src/save/progression.ts";

it("keeps an imported profile through later manual and autosave captures",()=>{
  const world=buildWorld([]),fresh=()=>step(world,createInitialState(world,1,["p1"],{x:0,z:0,heading:0}),{},[],createPlayerSystems());
  const profile={version:2,nameParts:["founder","harbor"],look:{body:"default",hair:"short"},preferences:{masterVolume:.4,musicVolume:.2,effectsVolume:.8,reducedMotion:true,highContrast:false,textScale:1.1},lifetime:{missions:3},achievements:["sweep-complete"]};
  const document={...captureProgression(fresh(),"p1"),profile};
  const session=new ProgressionSession(),restored=session.restore(fresh(),document,"p1");
  expect(session.capture(restored,"p1").profile).toEqual(profile);
  expect(session.capture(restored,"p1").profile).not.toBe(profile);
});
