import {describe,expect,it} from "vitest";
import {createCombatState,stepCombat} from "../../../src/sim/combat/system.ts";
import {createMatchState,stepMatch} from "../../../src/sim/modes/match.ts";
import type {CombatActor,CombatContext,CombatEvent,CombatPlayer} from "../../../src/sim/combat/types.ts";
const player=(id:string,z:number):CombatPlayer=>({id,x:0,y:0,z,heading:0,speed:0,mount:"foot",tankTier:0,flowTier:0,scannerTier:1});
const body=(id:string,z:number):CombatActor=>({id:`player:${id}`,playerId:id,kind:"player",firmware:"none",robotBody:false,x:0,y:0,z,heading:0,speed:0,radius:.35,height:1.8});
const context=(patch:Partial<CombatContext>={}):CombatContext=>({simVersion:24,wave:4,mode:"clean-streets",players:[player("a",0),player("b",-6)],actors:[body("a",0),body("b",-6)],rivalPlayerIds:{a:["b"],b:["a"]},walls:[],refills:[],...patch});
const match=()=>createMatchState({id:"physical-flower",mode:"cleanStreets",seed:7,players:["a","b"]});
const positions={a:{x:0,y:0,z:0},b:{x:0,y:0,z:-6}};
function run(ctx:CombatContext,aimYaw=0){let combat=createCombatState(7,ctx),state=match(),contacts:CombatEvent[]=[];
 for(let tick=1;tick<=60;tick++){
  combat=stepCombat(combat,ctx,tick===1?{a:{altFire:true,aimYaw,aimPitch:.1}}:{});
  state=stepMatch(state,{simVersion:24,tick,positions,combatEvents:combat.events});
  if(tick===1)expect(state.players.a!.score).toBe(0);
  if(combat.events.some(e=>e.kind==="pvp.flower-hit"))contacts=combat.events;
 }
 return {state,combat,contacts};
}
describe("SIM21 physical flower match authority",()=>{
 it("scores one later swept rival contact with lasting hair and a timed distraction",()=>{
  const result=run(context());expect(result.state.players.a!.score).toBe(25);expect(result.state.players.b!.flowers).toBe(1);expect(result.state.players.b!.distractedUntil).toBeGreaterThan(60);expect(result.contacts.some(e=>e.kind==="pvp.flower-hit")).toBe(true);
 });
 it.each(["miss","wall","person"] as const)("a physical %s never creates match score, hair or distraction",kind=>{
  const ctx=context(kind==="wall"?{walls:[{id:"wall",minX:-2,maxX:2,minY:0,maxY:4,minZ:-3.1,maxZ:-3}]}:kind==="person"?{actors:[body("a",0),{...body("civilian",-3),id:"person",playerId:undefined,kind:"person",protected:true},body("b",-6)]}:{});
  const result=run(ctx,kind==="miss"?3.141592653589793:0);expect(result.state.players.a!.score).toBe(0);expect(result.state.players.b!.flowers??0).toBe(0);expect(result.state.players.b!.distractedUntil??0).toBe(0);
 });
 it("cannot repeat actual contact rewards through duplicate events or a JSON-restored checkpoint",()=>{
  const result=run(context()),restored=JSON.parse(JSON.stringify(result.state));
  const after=stepMatch(restored,{simVersion:24,tick:61,positions,combatEvents:[...result.contacts,...result.contacts]});expect(after.players.a!.score).toBe(25);expect(after.players.b!.flowers).toBe(1);expect(after.events.some(e=>e.kind==="match.flower")).toBe(false);
 });
 it("rejects an in-flight teammate change and an unpaired score claim",()=>{
  let ctx=context(),combat=createCombatState(7,ctx),state=match();combat=stepCombat(combat,ctx,{a:{altFire:true,aimPitch:.1}});state=stepMatch(state,{simVersion:24,tick:1,positions,combatEvents:combat.events});
  ctx={...ctx,rivalPlayerIds:{a:[],b:[]}};state.players.b!.team=state.players.a!.team;
  for(let tick=2;tick<=60;tick++){combat=stepCombat(combat,ctx,{});state=stepMatch(state,{simVersion:24,tick,positions,combatEvents:combat.events});}
  expect(state.players.a!.score).toBe(0);state=stepMatch(state,{simVersion:24,tick:61,positions,combatEvents:[{id:999,tick:61,kind:"pvp.score",sourceId:"a",targetId:"a",amount:25,detail:"flower"}]});expect(state.players.a!.score).toBe(0);
 });
 it("keeps instant desired flowerTarget inert in21 and preserves the historical standalone shortcut",()=>{
  const desired={positions,inputs:{a:{flowerTarget:"b"}}};expect(stepMatch(match(),{...desired,simVersion:24}).players.a!.score).toBe(0);expect(stepMatch(match(),desired).players.a!.score).toBe(25);
 });
});
