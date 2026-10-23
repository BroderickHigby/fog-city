import { describe,expect,it } from "vitest";
import { createVibesState,stepVibes,VIBES_RULES,vibesAwardCandidates,type VibesCast } from "../../../src/sim/modes/vibes.ts";
import { chooseVibesAward,chooseRoastTemplate } from "../../../server/net/vibes.ts";
const players=Array.from({length:8},(_,i)=>`p${i}`);
const cast:Record<string,VibesCast>=Object.fromEntries(players.map(id=>[id,{badId:`${id}-bad`,goodIds:[`${id}-good1`,`${id}-good2`],investorIds:[`${id}-investor`]}]));
describe("Vibes Night",()=>{
  it("finishes eight timed demos, counts votes separately and records keyed tie resolution",()=>{
    let s=createVibesState("round",players,cast);
    for(const id of players){
      s=stepVibes(s,{inputs:{[id]:{calledId:`${id}-bad`}},combatEvents:[{id:s.nextEventId,tick:s.tick+1,kind:"robot.heap",sourceId:id,targetId:`${id}-bad`,amount:1,detail:""}]});
      expect(s.demos[id]!.score).toBe(300);
      for(let tick=1;tick<VIBES_RULES.demoTicks;tick++)s=stepVibes(s,{});
    }
    expect(s.phase).toBe("voting");
    s=stepVibes(s,{inputs:{p0:{voteId:"p1"},p1:{voteId:"p0"},p2:{voteId:"p0"},p3:{voteId:"p1"}}});
    for(let tick=1;tick<VIBES_RULES.voteTicks;tick++)s=stepVibes(s,{});expect(vibesAwardCandidates(s)).toEqual(["p0","p1"]);
    const key=new Uint8Array(32).fill(7),award=chooseVibesAward(s,key);
    expect(chooseVibesAward(s,key)).toEqual(award);
    s=stepVibes(s,{award});expect(s.phase).toBe("finished");expect(["p0","p1"]).toContain(s.winnerId);
    for(const id of players)expect(s.demos[id]!.score).toBe(300);
  });
  it("rejects self votes, changes to a locked vote and stale or altered candidate facts",()=>{
    let s=createVibesState("round",players,cast);s.phase="voting";
    s=stepVibes(s,{inputs:{p0:{voteId:"p0"},p1:{voteId:"p2"}}});expect(s.votes.p0).toBeUndefined();
    s=stepVibes(s,{inputs:{p1:{voteId:"p3"}}});expect(s.votes.p1).toBe("p2");
    s.phase="award";s=stepVibes(s,{award:{id:"wrong",matchId:"round",requestId:"wrong",winnerId:"p3",candidates:["p3"]}});expect(s.phase).toBe("award");
  });
  it("scores only current-presenter incidents once and freezes on global pause",()=>{
    let s=createVibesState("round",players,cast);
    const wet={id:1,tick:1,kind:"person.wet",sourceId:"p0",targetId:"p0-investor",amount:1,detail:""};
    s=stepVibes(s,{combatEvents:[wet,wet]});expect(s.demos.p0!.score).toBe(-200);
    s=stepVibes(s,{paused:true,tick:182});expect(s.elapsedTicks).toBe(1);expect(s.presenterTicks).toBe(1);
    const before=s.demos.p0!.score;chooseRoastTemplate("round","p0",12,new Uint8Array(32));expect(s.demos.p0!.score).toBe(before);
  });
  it("rejects delayed pre-demo hits and cross-match award replays",()=>{
    let s=createVibesState("round",players,cast);s.presenterTicks=VIBES_RULES.demoTicks-1;s=stepVibes(s,{});
    s=stepVibes(s,{combatEvents:[{id:2,tick:1,kind:"robot.heap",sourceId:"p1",targetId:"p1-bad",amount:1,detail:""}]});
    expect(s.demos.p1!.score).toBe(0);
    s.phase="voting";s.voteTicks=VIBES_RULES.voteTicks-1;s=stepVibes(s,{});
    const award=chooseVibesAward(s,new Uint8Array(32));
    const other=createVibesState("other-round",players,cast);other.phase="award";other.awardRequestId=s.awardRequestId;
    expect(stepVibes(other,{award}).phase).toBe("award");
  });
  it("rejects shared actor IDs and player aliases in demo casts",()=>{
    expect(()=>createVibesState("round",players,{...cast,p1:{...cast.p1!,badId:"p0-bad"}})).toThrow();
    expect(()=>createVibesState("round",players,{...cast,p1:{...cast.p1!,badId:"p0"}})).toThrow();
  });
});
