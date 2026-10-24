import { describe, expect, it } from "vitest";
import { createMatchState, MATCH_RULES, matchPayout, stepMatch } from "../../../src/sim/modes/match.ts";
import type { CombatEvent } from "../../../src/sim/combat-contract.ts";
import type { MatchState } from "../../../src/sim/modes/types.ts";

const sweep=()=>createMatchState({id:"round-1",mode:"botSweep",seed:14,players:["b","a"],badRobotIds:["bad"],relayId:"relay"});
const e=(id:number,kind:string,targetId:string,amount=0,tick=1,sourceId="a"):CombatEvent=>({id,tick,kind,targetId,amount,sourceId,detail:""});
const positions={a:{x:0,y:0,z:0},b:{x:1,y:0,z:0}};
function freeze<T>(value:T):T{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

describe("isolated match rules",()=>{
  it("requires every beta unit and the relay, including newly converted units",()=>{
    let state=stepMatch(sweep(),{positions,combatEvents:[e(1,"robot.converted","new"),e(2,"robot.heap","bad"),e(3,"robot.disabled","relay")]});
    expect(state.phase).toBe("active");expect(state.remainingBad).toEqual(["new"]);
    state=stepMatch(state,{positions,combatEvents:[e(4,"robot.heap","new",0,2)]});
    expect(state.result?.reason).toBe("sweep-complete");expect(state.result?.winners).toEqual(["a","b"]);
  });
  it("deduplicates replayed facts and remains pure with frozen state",()=>{
    const previous=freeze(sweep());
    const next=stepMatch(previous,{positions,combatEvents:[e(1,"update.interrupted","bad"),e(1,"update.interrupted","bad")]});
    expect(previous.players.a!.score).toBe(0);expect(next.players.a!.score).toBe(150);
    const replay=stepMatch(next,{positions,combatEvents:[e(1,"update.interrupted","bad")]});
    expect(replay.players.a!.score).toBe(150);
  });
  it("revives only after three continuous seconds by a nearby teammate",()=>{
    let s=stepMatch(sweep(),{positions,combatEvents:[e(1,"player.runway","b",-12)]});
    expect(s.players.b!.downUntil).toBe(1+MATCH_RULES.downTicks);
    for(let i=0;i<MATCH_RULES.reviveTicks-1;i++)s=stepMatch(s,{positions,inputs:{a:{reviveTarget:"b"}}});
    expect(s.players.b!.runway).toBe(0);
    s=stepMatch(s,{positions,inputs:{a:{reviveTarget:"b"}}});
    expect(s.players.b!.runway).toBe(6);expect(s.players.a!.score).toBe(100);expect(s.lives).toBe(5);
  });
  it("does not revive across floors and spends a shared life after fifteen seconds",()=>{
    let s=stepMatch(sweep(),{positions,combatEvents:[e(1,"player.runway","b",-12)]});
    for(let i=0;i<MATCH_RULES.respawnTicks;i++)s=stepMatch(s,{positions:{...positions,a:{x:0,y:20,z:0}},inputs:{a:{reviveTarget:"b"}}});
    expect(s.players.b!.runway).toBe(12);expect(s.lives).toBe(4);
    expect(s.events.some(e=>e.kind==="match.respawn-request")).toBe(true);
  });
  it("holds local deadlines across a skipped global AGI pause",()=>{
    let s=stepMatch(sweep(),{positions,combatEvents:[e(1,"player.runway","b",-12)]});
    s=stepMatch(s,{positions,tick:182});
    expect(s.elapsedTicks).toBe(2);expect(s.players.b!.respawnAt).toBe(1081);
    s=stepMatch(s,{positions,tick:183,paused:true});
    expect(s.elapsedTicks).toBe(2);expect(s.players.b!.respawnAt).toBe(1082);
  });
  it("times out exactly at twelve minutes and caps cash by elapsed play",()=>{
    const previous=sweep();previous.elapsedTicks=MATCH_RULES.botSweepTicks-1;
    const s=stepMatch(previous,{positions});expect(s.result?.reason).toBe("relay-update");
    s.players.a!.score=100_000;
    expect(matchPayout(s,"a").cashCents).toBe(90_000);
    expect(matchPayout(s,"missing").cashCents).toBe(0);
  });
  it("scores Clean Streets by team then interrupted updates, with wrong-target penalties",()=>{
    let s=createMatchState({id:"clean",mode:"cleanStreets",seed:3,players:["a","b","c","d"],badRobotIds:["bad"]});
    s.elapsedTicks=MATCH_RULES.cleanStreetsTicks-2;
    s=stepMatch(s,{positions,combatEvents:[e(1,"update.interrupted","bad"),e(2,"economy.penalty","person",20)]});
    expect(s.players.a!.score).toBe(-50);
    s.players.b!.score=-50;
    s=stepMatch(s,{positions});expect(s.result?.winners).toEqual(["a","c"]);
  });
  it("rejects unknown participants, unsafe IDs, repeated ticks and unfinished modes",()=>{
    expect(()=>createMatchState({id:"__proto__",mode:"botSweep",seed:1,players:["a"],relayId:"r"})).toThrow();
    expect(()=>createMatchState({id:"id",mode:"fogRoyale",seed:1,players:["a"]})).toThrow();
    const s:MatchState=sweep();expect(()=>stepMatch(s,{positions,tick:0})).toThrow();
    const next=stepMatch(s,{positions,combatEvents:[e(1,"agi.pause","",0,1,"stranger")]});
    expect(next.phase).toBe("active");
  });
});
