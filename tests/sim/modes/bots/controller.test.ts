import {describe,expect,it} from "vitest";
import {Action} from "../../../../src/sim/contract.ts";
import {buildWorld} from "../../../../src/sim/world.ts";
import {makeFoot} from "../../../../src/sim/foot.ts";
import {createInitialState,step} from "../../../../src/sim/step.ts";
import {contextFromState} from "../../../../src/sim/combat/adapter.ts";
import {createCombatState} from "../../../../src/sim/combat/system.ts";
import {createRivalBotState,planRivalBotInputs,type BotVisibleActor} from "../../../../src/sim/bots/controller.ts";
const world=buildWorld([]);
function initial(){const sim=createInitialState(world,4,["bot","other"],{x:0,z:0,heading:0});sim.players.bot!.mode="foot";sim.players.bot!.foot=makeFoot(0,0,0,0);sim.players.other!.car.x=100;sim.ext.combat=createCombatState(4,contextFromState(world,sim));return sim;}
function robot(extra:Partial<BotVisibleActor>={}):BotVisibleActor{return {id:"r",kind:"robot",x:0,y:0,z:-8,visible:true,operational:true,...extra};}
function perception(actors:BotVisibleActor[]){return [{playerId:"bot",actors,refills:[]}];}
function scan(sim:ReturnType<typeof initial>,bad:boolean){sim.ext.combat!.players.bot!.scan={targetId:"r",bad,confidence:1,tick:sim.tick};}
function freeze<T>(data:T):T{if(data&&typeof data==="object"){for(const value of Object.values(data))freeze(value);Object.freeze(data);}return data;}
describe("rival founder controller",()=>{
 it("lobs flowers at a visible rival founder instead of spraying water",()=>{
  const sim=initial(),plan=planRivalBotInputs(world,sim,createRivalBotState({bot:"hunter"}),perception([robot({id:"player:other",kind:"player",rival:true,z:-15})]));
  expect(plan.inputs.bot!.actions&Action.altFire).toBeTruthy();expect(plan.inputs.bot!.actions&Action.fire).toBe(0);
 });
 it("scans an unknown robot and fires only after this player's accepted bad scan",()=>{
  const sim=initial(),state=createRivalBotState({bot:"hunter"});const first=planRivalBotInputs(world,sim,state,perception([robot()]));
  expect(first.inputs.bot!.actions&Action.scan).toBeTruthy();expect(first.inputs.bot!.actions&Action.fire).toBe(0);
  sim.tick++;scan(sim,true);const next=planRivalBotInputs(world,sim,first.state,perception([robot()]));expect(next.inputs.bot!.actions&Action.fire).toBeTruthy();
 });
 it("ignores a teammate's scan and never shoots a confirmed good robot",()=>{
  const sim=initial();sim.ext.combat!.players.other!.scan={targetId:"r",bad:true,confidence:1,tick:0};
  const first=planRivalBotInputs(world,sim,createRivalBotState({bot:"hunter"}),perception([robot()]));expect(first.inputs.bot!.actions&Action.fire).toBe(0);
  sim.tick++;scan(sim,false);const next=planRivalBotInputs(world,sim,first.state,perception([robot()]));expect(next.inputs.bot!.actions&Action.fire).toBe(0);expect(next.state.bots.bot!.knowledge[0]!.status).toBe("good");
 });
 it("does not learn invisible or behind-the-player positions",()=>{
  const sim=initial(),plan=planRivalBotInputs(world,sim,createRivalBotState({bot:"hunter"}),perception([robot({id:"invisible",visible:false}),robot({id:"behind",z:8})]));expect(plan.state.bots.bot!.knowledge).toEqual([]);
 });
 it("retains a last seen position without following hidden position updates or firing blind",()=>{
  const sim=initial();scan(sim,true);const first=planRivalBotInputs(world,sim,createRivalBotState({bot:"hunter"}),perception([robot()]));
  sim.tick++;const second=planRivalBotInputs(world,sim,first.state,perception([robot({visible:false,x:500})]));expect(second.state.bots.bot!.knowledge[0]!.x).toBe(0);expect(second.inputs.bot!.actions&Action.fire).toBe(0);
  sim.tick=601;const expired=planRivalBotInputs(world,sim,second.state,perception([]));expect(expired.state.bots.bot!.knowledge).toEqual([]);
 });
 it("holds fire when a visible person or animal crosses the spray corridor",()=>{
  const sim=initial();scan(sim,true);for(const kind of ["person","animal"] as const){const result=planRivalBotInputs(world,sim,createRivalBotState({bot:"hunter"}),perception([robot(),robot({id:"protected",kind,z:-4})]));expect(result.inputs.bot!.actions&Action.fire).toBe(0);}
 });
 it("makes spotters watch and hiders pursue their objective without attacking",()=>{
  const sim=initial();scan(sim,true);const spotter=planRivalBotInputs(world,sim,createRivalBotState({bot:"spotter"}),perception([robot()]));expect(spotter.inputs.bot!.actions&Action.watch).toBeTruthy();expect(spotter.inputs.bot!.actions&Action.fire).toBe(0);
  const hider=planRivalBotInputs(world,sim,createRivalBotState({bot:"hider"}),[{...perception([robot()])[0]!,objective:{x:0,z:-40}}]);expect(hider.inputs.bot!.actions).toBe(0);expect(hider.inputs.bot!.throttle).toBeGreaterThan(0);
 });
 it("uses the ordinary interact action at a refill after observing low water",()=>{
  const sim=initial();sim.ext.combat!.players.bot!.water=0;const result=planRivalBotInputs(world,sim,createRivalBotState({bot:"hunter"}),[{playerId:"bot",actors:[robot()],refills:[{id:"hydrant",x:0,y:0,z:-1,radius:2}]}]);expect(result.inputs.bot!.actions).toBe(Action.interact);expect(result.inputs.bot!.throttle).toBe(0);
 });
 it("recovers after blocked travel and moves only when normal physics applies its input",()=>{
  let sim=initial(),state=createRivalBotState({bot:"hider"});const observations=[{playerId:"bot",actors:[],refills:[],objective:{x:0,z:-40}}];const before=JSON.stringify(sim);
  const plan=planRivalBotInputs(world,sim,state,observations);expect(JSON.stringify(sim)).toBe(before);sim=step(world,sim,plan.inputs,[]);expect(sim.players.bot!.foot!.z).toBeLessThan(0);
  state=plan.state;sim.players.bot!.foot=makeFoot(0,0,0,0);for(let tick=1;tick<=241;tick++){sim.tick=tick;state=planRivalBotInputs(world,sim,state,observations).state;}expect(state.bots.bot!.goal).toBe("recover");
 });
 it("is deterministic and leaves frozen state and observations untouched",()=>{
  const sim=freeze(initial()),state=freeze(createRivalBotState({bot:"hunter"})),observations=freeze(perception([robot()]));expect(planRivalBotInputs(world,sim,state,observations)).toEqual(planRivalBotInputs(world,sim,state,observations));expect(state.tick).toBe(-1);
 });
 it("rejects prototype identities and duplicate observations",()=>{
  expect(()=>createRivalBotState({constructor:"hunter" as const})).toThrow();expect(()=>planRivalBotInputs(world,initial(),createRivalBotState({bot:"hunter"}),[...perception([]),...perception([])])).toThrow("Duplicate");
 });
});
