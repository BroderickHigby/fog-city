import { describe, expect, it } from "vitest";
import { Action, type SimState, type SimEvent, type SimInput } from "../../../src/sim/contract.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { createGameSystems } from "../../../src/sim/game-systems.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { makeCar } from "../../../src/sim/car.ts";
import { datan2 } from "../../../src/sim/dmath.ts";
import { MISSIONS } from "../../../src/content/catalog.ts";
import { missionPlace, createMissions, createMissionProgress, stepMissions } from "../../../src/sim/missions/system.ts";
import { createPlayer } from "../../../src/sim/player/system.ts";
import { createHeat } from "../../../src/sim/heat/system.ts";
import { createObservedGameplayProvider, createPlayerSystems } from "../../../src/sim/player/adapter.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { agentsCombatOptions } from "../../../src/sim/agents/systems.ts";
import { runtimeCombatActors } from "../../../src/sim/agents/runtime.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext, GameplayCommand } from "../../../src/sim/player/types.ts";
import type { MissionParkingWorld } from "../../../src/sim/missions/mechanics/runtime.ts";

const owned = new Set(["player", "heat", "missions", "activities", "economy", "progression"]);

/** Composed reducer fixture: route traversal is outside this test; world/combat outcomes are real. */
function runMission(id: "launch-day" | "demoed-correctly", mode: "normal" | "retry" | "early-melt" = "normal") {
  const mission = MISSIONS.find(value => value.id === id)!;
  const first = mission.steps[0]!;
  if (first.type !== "trigger") throw new Error("Missing entry");
  const at = missionPlace(first.event.place);
  const hydrant={id:"fixture-hydrant",kind:"hydrant" as const,x:at.x+30,y:0,z:at.z+30,radius:4,salt:false};
  const world=buildWorld([],null,null,{version:1,world:"fixture",sourceSnapshot:"fixture",refills:[hydrant],anchors:[],tiles:[],territories:[]});
  let state = createInitialState(world, 319, ["p"], { x: at.x + 30, z: at.z + 30, heading: 0 });
  const progress = createMissionProgress();
  progress.completedIds = id === "launch-day" ? ["hot-desk", "spill"] : ["hot-desk", "spill", "launch-day"];
  state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(at.x, 0, at.z, 0) } }, ext: { ...state.ext, missions: { ...createMissions(), players: { p: progress } } } };
  let parking: MissionParkingWorld | undefined;
  const observed = createObservedGameplayProvider({ wave: 3, actors: context => contextFromState(context.world, context.state, agentsCombatOptions(context.state)).actors, missionParking: () => parking, protectedArea: () => false });
  const systems = [...createGameSystems({ wave: 3, protectedArea: () => false }).filter(system => !owned.has(system.key)), ...createPlayerSystems(observed)];
  const commands: GameplayCommand[] = [];
  let missionCashAwards=0;
  function tick(actions = 0, command?: Omit<GameplayCommand, "playerId" | "sequence">) {
    const events: SimEvent[] = [];
    if (command) { const next = { ...command, playerId: "p", sequence: commands.length + 1 }; commands.push(next); events.push({ tick: state.tick + 1, kind: "gameplay.command", playerId: "p", payload: { ...command, sequence: next.sequence } }); }
    const input: SimInput = { throttle: 0, steer: 0, brake: 1, actions, ...((actions & Action.fire) ? { aimPitch: -.25 } : {}) };
    state = step(world, state, { p: input }, events, systems);
    missionCashAwards += state.ext.missions?.events.filter(event=>event.kind==="mission.cash").length??0;
  }
  function placeFoot(x: number, z: number, heading = 0) {
    state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(x, 0, z, heading) } } };
  }
  const actorId=(alias:string)=>state.ext.robots?.missionBindings[`p:${id}:${alias}`]??state.ext.robots?.missionBindings[`${id}:${alias}`]??`mission:${id}:${alias}`;
  function face(alias: string, distance = 5) {
    const actor = runtimeCombatActors(state).find(value => value.id === actorId(alias));
    if (!actor) throw new Error(`Missing physical ${alias} at ${state.ext.missions?.players.p?.stepId}`);
    // Keep the observed body inside the sight cone without asserting any mission outcome.
    const px = actor.x, pz = actor.z + distance;
    placeFoot(px, pz, datan2(actor.x - px, -(actor.z - pz)));
  }
  function until(predicate: () => boolean, limit: number, action: () => void) {
    for (let i = 0; i < limit && !predicate(); i++) action();
    expect(predicate(), `${id} stalled at ${state.ext.missions?.players.p?.stepId}: ${JSON.stringify({player:state.ext.combat?.players.p,targets:state.ext.combat?.targets})}`).toBe(true);
  }
  tick(0, { kind: "mission-start", targetId: id });
  if (id === "demoed-correctly") {
    const travel = mission.steps.find(value => value.type === "goto")!;
    if (travel.type !== "goto") throw new Error("Missing route");
    const destination = missionPlace(travel.target);
    placeFoot(destination.x, destination.z); tick();
    expect(state.ext.missions?.players.p?.stepId).toBe("park");
    const bay = { id: "fixture-bay", edge: "fixture-road", side: "R" as const, x: destination.x, y: 0, z: destination.z + 10, heading: 0, halfLength: 3.5, halfWidth: 1.3 };
    state = { ...state, players: { p: { ...state.players.p!, mode: "vehicle", foot: null, car: makeCar(bay.x, bay.z, 0) } } };
    parking = { bays: [bay], targets: [{ missionId: id, stepId: "park", bayIds: [bay.id] }], rules: [{ edge: bay.edge, side: bay.side, kind: "free", days: [], from: null, to: null, hourLimit: null, permitAreas: [] }], cleaning: [], clock: { isoWeekday: 2, minute: 600, weekOfMonth: 2, holiday: false }, vehicles: [] };
    for (let i = 0; i < 122; i++) { parking.vehicles = [{ playerId: "p", ...state.players.p!.car, halfLength: 2.2, halfWidth: .95 }]; tick(); }
    expect(state.ext.missions?.players.p?.stepId).toBe("park");
    parking.vehicles = [{ playerId: "p", ...state.players.p!.car, halfLength: 2.2, halfWidth: .95 }]; tick(Action.interact);
    expect(state.ext.missions?.players.p?.stepId).toBe("pitch-philosopher");
    for (let question = 0; question < 6; question++) {
      const current = mission.steps.find(value => value.id === state.ext.missions!.players.p!.stepId)!;
      if (current.type !== "dialogue") throw new Error("Missing dialogue");
      const q = current.questions[state.ext.missions!.players.p!.questionIndex]!, choice = [...q.answers].sort((a,b) => b.delta-a.delta)[0]!;
      tick(0, { kind: "mission-answer", questionId: q.id, choiceId: choice.id });
    }
    placeFoot(destination.x, destination.z);
    for (let i = 0; i < 3; i++) tick();
    expect(state.ext.missions?.players.p?.stepId).toBe("present");
    for (const alias of ["demoGoodA", "demoGoodB", "demoBad"]) for (let i = 0; i < 185; i++) { face(alias); tick(Action.watch); }
    until(() => state.ext.missions!.players.p!.status === "complete", 700, () => { face("demoBad", 3); tick(Action.fire); });
    expect(state.ext.missions?.players.p?.outcome).toBe("termSheet");
    expect(state.ext.combat?.targets[actorId("demoGoodA")]?.rust).toBe(0);
    expect(state.ext.combat?.targets[actorId("demoGoodB")]?.rust).toBe(0);
  } else {
    for (let i = 0; i < 3; i++) tick();
    for (let i = 0; i < 185; i++) { face("suspect"); tick(Action.watch); }
    expect(state.ext.missions?.players.p?.stepId).toBe("scan");
    until(() => state.ext.missions!.players.p!.stepId === "false-positive", 120, () => { face("suspect"); tick(Action.scan); });
    if(mode!=="normal"){
      const firstId=actorId("suspect"),firstNumeric=state.ext.robots!.actors[firstId]!.numericId;
      until(()=>state.ext.missions!.players.p!.observed!.melted.includes(firstId),700,()=>{face("suspect",3);tick(Action.fire);});
      if(mode==="retry"){
        until(()=>state.ext.missions!.players.p!.status==="retry",7300,()=>tick());
        until(()=>state.tick>=state.ext.missions!.players.p!.deadlineTick,700,()=>tick());
        tick(0,{kind:"mission-retry"});for(let i=0;i<4;i++)tick();
        const freshId=actorId("suspect");expect(freshId).not.toBe(firstId);
        expect(state.ext.robots!.actors[freshId]!.numericId).not.toBe(firstNumeric);
        expect(state.ext.combat!.targets[freshId]!.rust).toBe(0);
        expect(state.ext.agents!.list.some(body=>body.runtimeId===firstId)).toBe(false);
        expect(state.ext.missions!.players.p!.observed!.melted).toEqual([]);
        placeFoot(hydrant.x,hydrant.z);
        until(()=>state.ext.combat!.players.p!.water===8,240,()=>tick(Action.interact));
        for(let i=0;i<185;i++){face("suspect");tick(Action.watch);}
        until(()=>state.ext.missions!.players.p!.stepId==="false-positive",120,()=>{face("suspect");tick(Action.scan);});
      }
    }
    until(() => Boolean(state.ext.missions!.players.p!.observed?.falsePositives.length), 1800, () => { face("courier"); tick(Action.scan); });
    expect(state.ext.missions?.players.p?.stepId).toBe("false-positive");
    tick(0, { kind: "mission-ack" });
    for (let i = 0; i < 185; i++) { face("courier"); tick(Action.watch); }
    if(mode!=="early-melt"){expect(state.ext.missions?.players.p?.stepId).toBe("melt");
      until(() => state.ext.missions!.players.p!.stepId === "pivot", 700, () => { face("suspect", 3); tick(Action.fire); });}
    else expect(state.ext.missions!.players.p!.stepId).toBe("pivot");
    tick(0, { kind: "startup-define", kitId: DEFAULT_CATALOG.validKitIds[0]! });
    expect(state.ext.missions?.players.p?.status).toBe("complete");
    expect(state.ext.progression?.players.p?.scannerTier).toBe(2);
  }
  const cash = state.ext.economy!.players.p!.cashCents;
  tick(0, { kind: "mission-start", targetId: id });
  expect(state.ext.economy!.players.p!.cashCents).toBe(cash);
  expect(missionCashAwards).toBe(1);
  return state;
}

describe("wave-3 composed mission outcomes", () => {
  it("completes Launch Day using real watch, scan, false positive, water and recorded form commands", () => {
    expect(runMission("launch-day")).toEqual(runMission("launch-day"));
  }, 30_000);
  it("completes Demoed Correctly through physical parking, dialogue and observed safe presentation", () => {
    expect(runMission("demoed-correctly")).toEqual(runMission("demoed-correctly"));
  }, 30_000);
  it("retries after an early real melt with fresh actors and completes without duplicate mission rewards",()=>{
    expect(runMission("launch-day","retry")).toEqual(runMission("launch-day","retry"));
  },60_000);
  it("retains an early authoritative melt inside its current attempt",()=>{
    expect(runMission("launch-day","early-melt").ext.missions!.players.p!.status).toBe("complete");
  },30_000);
  it("rejects externally supplied story completion facts", () => {
    const mission = MISSIONS.find(value => value.id === "launch-day")!, progress = { ...createMissionProgress(), missionId: mission.id, status: "active" as const, stepId: "false-positive", startedTick: 1 };
    const state = { ...createMissions(), players: { p: progress } };
    const context: GameplayContext = { ...DEFAULT_CATALOG, wave: 3, bodies: [{ id:"p", x:0,y:0,z:0,speed:0,mode:"foot" }], actors:[], observations:[], commands:[], day:1,month:1, facts:[{id:"spoof:1",source:"world",sequence:1,tick:2,playerId:"p",kind:"botCheck.falsePositiveSeen"}] };
    expect(stepMissions(state, context, 2, createHeat(), createPlayer()).players.p!.stepId).toBe("false-positive");
  });
});
