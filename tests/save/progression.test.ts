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
    expect(doom).toEqual({months:30,resets:2,winters:3,stopped:true,factions:{p1:{pauser:2,accelerator:1}},lastDay:0,pausedUntil:0,winterUntilDay:-1,winterUntilTick:0,lastTick:1,streakCursor:0,factCursors:{}});
    expect(view.economy.players.p1).not.toHaveProperty("settledModeIds");
  });
  it("rejects unknown missions and unexpected wallet fields before applying",()=>{
    const saved=captureProgression(initial(),"p1");
    expect(()=>validateSavedProgression({...saved,missions:{completedIds:["missing-mission"],rewardedIds:[]}})).toThrow("Unknown progression identifier");
    expect(()=>validateSavedProgression({...saved,wallet:{...(saved.wallet as object),admin:true}})).toThrow("Unknown progression field");
  });
});

it("persists earned reward adoption while cancelling an unexecuted ordinary-save reservation without spending it",()=>{
 const state=initial();Object.assign(state.ext.progression!.players.p1!,{xp:1000,streakPoints:700,banked:{confidence:1},earnedStreaks:["confidence","parrots","tensor"],pendingStreak:{kind:"confidence",sequence:7},streakHeld:true});
 const saved=captureProgression(state,"p1"),durable=saved.progression as Record<string,unknown>;
 expect(durable.earnedStreaks).toEqual(["confidence","parrots","tensor"]);expect(durable).not.toHaveProperty("pendingStreak");expect(durable).not.toHaveProperty("streakHeld");
 const restored=restoreProgression(initial(3),JSON.parse(JSON.stringify(saved)),"p1");expect(restored.ext.progression!.players.p1!.banked.confidence).toBe(1);expect(restored.ext.progression!.players.p1!.earnedStreaks).toEqual(["confidence","parrots","tensor"]);expect(restored.ext.progression!.players.p1!.pendingStreak).toBeUndefined();
});
it("restores active winter for its remaining duration, without stale AGI pause or replay cursors",()=>{
 const state=initial();state.ext.progression!.doom={months:24,resets:1,winters:1,lastDay:0,lastTick:state.tick,pausedUntil:state.tick+180,winterUntilDay:1,winterUntilTick:state.tick+900,factions:{},factCursors:{"world:activities":99},streakCursor:50};
 const saved=captureProgression(state,"p1"),fresh=initial(5),restored=restoreProgression(fresh,saved,"p1"),doom=restored.ext.progression!.doom!;
 expect(doom.winterUntilTick).toBe(fresh.tick+900);expect(doom.pausedUntil).toBe(0);expect(doom.lastDay).toBe(0);expect(doom.factCursors).toEqual({});expect(doom.streakCursor).toBe(0);
});
it("retains a paid game-week subscription across ordinary reload without charging a fresh week twice",()=>{
 const state=initial();state.ext.progression!.players.p1!.gear="microclimate";Object.assign(state.ext.economy!.players.p1!,{microclimatePaidWeek:1,microclimateActive:true,cashCents:500});
 const saved=captureProgression(state,"p1");expect((saved.wallet as Record<string,unknown>).microclimatePaid).toBe(true);
 const restored=restoreProgression(initial(3),saved,"p1");expect(restored.ext.economy!.players.p1!.microclimatePaidWeek).toBe(1);expect(restored.ext.economy!.players.p1!.microclimateActive).toBe(true);expect(restored.ext.economy!.players.p1!.cashCents).toBe(500);
});
