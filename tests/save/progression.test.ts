import {describe,it,expect} from "vitest";
import {buildWorld} from "../../src/sim/world.ts";
import {createInitialState,step} from "../../src/sim/step.ts";
import {createPlayerSystems,gameplaySnapshot} from "../../src/sim/player/adapter.ts";
import {captureProgression,restoreProgression,validateSavedProgression} from "../../src/save/progression.ts";

function initial(seed=1){const world=buildWorld([]);return step(world,createInitialState(world,seed,["p1"],{x:0,z:0,heading:0}),{},[],createPlayerSystems());}
describe("canonical progression saves",()=>{
  it("restores durable progression into a fresh world without copying runtime actors",()=>{
    const state=initial(),snapshot=gameplaySnapshot({state});
    snapshot.economy.players.p1!.cashCents=12345;
    Object.assign(snapshot.economy,{settledModeIds:["round-1"]});
    snapshot.missions.players.p1!.completedIds=["hot-desk"];
    snapshot.missions.players.p1!.rewardedIds=["hot-desk:moved-in"];
    snapshot.progression.players.p1!.xp=900;
    snapshot.progression.players.p1!.rank=1;
    const saved=captureProgression(state,"p1");
    expect(Object.keys(saved).sort()).toEqual(["activities","missions","player","progression","wallet"]);
    const fresh=initial(2),before=JSON.stringify(fresh),restored=restoreProgression(fresh,saved,"p1"),view=gameplaySnapshot({state:restored});
    expect(JSON.stringify(fresh)).toBe(before);expect(restored.seed).toBe(2);
    expect(view.economy.players.p1!.cashCents).toBe(12345);expect((view.economy as unknown as {settledModeIds:string[]}).settledModeIds).toEqual(["round-1"]);
    expect(view.missions.players.p1!.completedIds).toEqual(["hot-desk"]);expect(view.missions.players.p1!.status).toBe("idle");
    expect(view.progression.players.p1!.rank).toBe(4);expect(view.player.players.p1!.status).toBe("active");
  });
  it("preserves advanced equipment and durable world clock without expired tick deadlines",()=>{
    const state=initial(),snapshot=gameplaySnapshot({state});
    Object.assign(snapshot.progression.players.p1!,{nozzle:"wide",gear:"microclimate"});
    Object.assign(snapshot.progression,{doom:{months:30,resets:2,winters:3,stopped:true,factions:{p1:{pauser:2,accelerator:1}},lastDay:90,pausedUntil:900,winterUntilDay:91,factCursors:{combat:900}}});
    const saved=captureProgression(state,"p1"),restored=restoreProgression(initial(4),saved,"p1"),view=gameplaySnapshot({state:restored});
    expect(view.progression.players.p1).toMatchObject({nozzle:"wide",gear:"microclimate"});
    const doom=(view.progression as unknown as {doom:Record<string,unknown>}).doom;
    expect(doom).toEqual({months:30,resets:2,winters:3,stopped:true,factions:{p1:{pauser:2,accelerator:1}},lastDay:0,pausedUntil:0,winterUntilDay:-1,factCursors:{}});
    expect(view.economy.players.p1).not.toHaveProperty("settledModeIds");
  });
  it("rejects unknown missions and unexpected wallet fields before applying",()=>{
    const saved=captureProgression(initial(),"p1");
    expect(()=>validateSavedProgression({...saved,missions:{completedIds:["missing-mission"],rewardedIds:[]}})).toThrow("Unknown progression identifier");
    expect(()=>validateSavedProgression({...saved,wallet:{...(saved.wallet as object),admin:true}})).toThrow("Unknown progression field");
  });
});
