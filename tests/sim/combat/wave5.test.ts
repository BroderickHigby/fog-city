import { describe,expect,it } from "vitest";
import { createCombatState,stepCombat } from "../../../src/sim/combat/system.ts";
import type { CombatActor,CombatContext,CombatPlayer } from "../../../src/sim/combat/types.ts";

function player(id:string,z:number):CombatPlayer{return {id,x:0,y:0,z,heading:0,speed:0,mount:"foot",tankTier:0,flowTier:0,scannerTier:1};}
function body(p:CombatPlayer):CombatActor{return {...p,id:`body:${p.id}`,playerId:p.id,kind:"player",firmware:"none",radius:.35,height:1.8};}
const players=[player("p1",0),player("p2",-5),player("mate",-2)];
const robot:CombatActor={id:"bot",kind:"robot",firmware:"bad",x:0,y:0,z:-8,heading:0,speed:0,radius:.35,height:1.8};
const ctx:CombatContext={wave:5,mode:"clean-streets",players,actors:[...players.map(body),robot],walls:[],refills:[],rivalPlayerIds:{p1:["p2"],p2:["p1"]}};

describe("wave-five reducer integration",()=>{
  it("a real flower passes through a teammate, hits a rival, and suppresses spray and scans",()=>{
    let state=createCombatState(1,ctx),hit=false;
    for(let n=0;n<60;n++) {
      state=stepCombat(state,ctx,{p1:{altFire:n===0,aimPitch:0},p2:{fire:true,scan:true,aimPitch:0}});
      if(state.events.some(event=>event.kind==="pvp.flower-hit")){hit=true;break;}
    }
    expect(hit).toBe(true);expect(state.targets["body:mate"]!.flowersUntil).toBe(0);
    expect(state.targets.p2!.flowersUntil).toBe(Number.MAX_SAFE_INTEGER);
    expect(state.targets.p2!.rust).toBe(0);
    const water=state.players.p2!.water;
    for(let n=0;n<30;n++)state=stepCombat(state,ctx,{p2:{fire:true,scan:true}});
    expect(state.players.p2!.water).toBe(water);expect(state.players.p2!.scanTicks).toBe(0);
    expect(state.targets.p2!.movementScale).toBe(1);
  });

  it("keeps flower alt-fire inactive before wave five and outside PvP",()=>{
    for(const patch of [{wave:4 as const},{mode:"free-roam" as const},{rivalPlayerIds:{}}]) {
      const context={...ctx,...patch};let state=createCombatState(1,context);
      state=stepCombat(state,context,{p1:{altFire:true}});
      expect(state.projectiles).toHaveLength(0);expect(state.players.p1!.nextFlowerTick).toBe(0);
    }
  });
});
