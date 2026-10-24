import { clamp } from "../dmath.ts";
import { sortedIds } from "../contract.ts";
import type { MatchConfig,MatchContext,MatchEvent,MatchPayout,MatchPlayer,MatchState,ModeId } from "./types.ts";

export const MATCH_RULES={botSweepTicks:12*60*60,cleanStreetsTicks:8*60*60,flowerCooldownTicks:90,distractedTicks:90,flowerRange:20,flowerPoints:25,reviveTicks:3*60,reviveRange:2,downTicks:30*60,respawnTicks:15*60,lives:5,maxObjectives:256} as const;
const MODES:readonly ModeId[]=["botSweep","cleanStreets"];
const validId=(id:string)=>/^[A-Za-z0-9:_-]{1,96}$/.test(id) && !Object.hasOwn(Object.prototype,id) && id!=="prototype";
function event(s:MatchState,kind:string,playerId="",targetId="",amount=0,detail=""):MatchEvent {
  const e={id:s.nextEventId++,tick:s.tick,kind,playerId,targetId,amount,detail};s.events.push(e);return e;
}
function player(id:string,index:number,mode:ModeId,team?:number):MatchPlayer {
  return {id,team:mode==="cleanStreets"?team??index%2:0,runway:mode==="fogRoyale"?18:12,score:0,interruptedUpdates:0,downUntil:0,respawnAt:0,reviveTicks:0,reviverId:"",eliminated:false,bridgeUsed:false,duelUsed:false,fleeceUntil:0};
}

/** Each match owns its own state. No free-roam record is read or modified here. */
export function createMatchState(config:MatchConfig):MatchState {
  if(!validId(config.id) || !MODES.includes(config.mode) || !Number.isSafeInteger(config.seed))throw new Error("Invalid match configuration");
  const ids=[...config.players].sort();
  const max=config.mode==="botSweep"?4:config.mode==="fogRoyale"?24:8;
  if(ids.length<1 || ids.length>max || new Set(ids).size!==ids.length || ids.some(id=>!validId(id)))throw new Error("Invalid match participants");
  const bad=[...(config.badRobotIds??[])].sort();
  if(bad.length>MATCH_RULES.maxObjectives || bad.some(id=>!validId(id)) || new Set(bad).size!==bad.length)throw new Error("Invalid match objectives");
  if(config.mode==="botSweep" && (!config.relayId || !validId(config.relayId) || bad.includes(config.relayId)))throw new Error("Bot Sweep requires a separate relay objective");
  const tick=config.tick??0;if(!Number.isSafeInteger(tick)||tick<0)throw new Error("Invalid match tick");
  if(config.teams){
    const keys=Object.keys(config.teams).sort();
    if(keys.some(id=>!ids.includes(id))||ids.some(id=>config.teams![id]!==0&&config.teams![id]!==1))throw new Error("Invalid match teams");
  }
  const limit=config.mode==="botSweep"?MATCH_RULES.botSweepTicks:config.mode==="cleanStreets"?MATCH_RULES.cleanStreetsTicks:0;
  const duration=config.durationTicks??limit;
  if(!Number.isSafeInteger(duration)||duration<60||duration>limit)throw new Error("Invalid match duration");
  return {version:1,id:config.id,mode:config.mode,seed:config.seed,tick,elapsedTicks:0,
    durationTicks:duration,
    phase:"active",players:Object.fromEntries(ids.map((id,index)=>[id,player(id,index,config.mode,config.teams?.[id])])),remainingBad:bad,relayId:config.relayId??"",lives:MATCH_RULES.lives,nextEventId:1,lastCombatTick:-1,events:[],result:null};
}
function copy(previous:MatchState,tick:number):MatchState {
  return {...previous,tick,players:Object.fromEntries(sortedIds(previous.players).map(id=>[id,{...previous.players[id]!}])),remainingBad:[...previous.remainingBad],events:[],result:previous.result?{...previous.result,winners:[...previous.result.winners]}:null};
}
function finish(s:MatchState,winners:string[],reason:string):void {
  if(s.phase!=="active")return;s.phase="finished";s.result={winners:[...winners].sort(),reason,elapsedTicks:s.elapsedTicks};event(s,"match.finished","","",winners.length,reason);
}
function score(s:MatchState,id:string,points:number,reason:string):void {
  const p=s.players[id];if(!p)return;p.score+=points;event(s,"match.score",id,"",points,reason);
}
function down(s:MatchState,p:MatchPlayer):void {
  if(p.downUntil>s.tick || p.eliminated)return;
  if(s.mode==="botSweep") {p.downUntil=s.tick+MATCH_RULES.downTicks;p.respawnAt=s.tick+MATCH_RULES.respawnTicks;p.reviveTicks=0;p.reviverId="";event(s,"match.down",p.id,"",MATCH_RULES.downTicks);}
  else if(s.mode==="cleanStreets") {p.runway=12;event(s,"match.respawn-request",p.id,"",0,"team-spawn");}
}
function combat(s:MatchState,ctx:MatchContext):void {
  const events=[...(ctx.combatEvents??[])].filter(e=>e.tick>s.lastCombatTick && e.tick<=s.tick).sort((a,b)=>a.tick-b.tick||a.id-b.id);
  const seen=new Set<string>();
  for(const e of events) {
    const key=`${e.tick}:${e.id}`;if(seen.has(key))continue;seen.add(key);
    if(e.kind==="robot.converted" && validId(e.targetId) && !s.remainingBad.includes(e.targetId) && s.remainingBad.length<MATCH_RULES.maxObjectives)s.remainingBad.push(e.targetId);
    if(e.kind==="robot.heap" || e.kind==="robot.disabled") {
      const objective=s.remainingBad.includes(e.targetId) || e.targetId===s.relayId;
      if(!objective)continue;
      s.remainingBad=s.remainingBad.filter(id=>id!==e.targetId);if(e.targetId===s.relayId)s.relayId="";
      score(s,e.sourceId,ctx.armouredIds?.includes(e.targetId)?200:100,"melt");
      if(s.mode==="fogRoyale" && s.players[e.sourceId])s.players[e.sourceId]!.runway+=1;
    } else if(e.kind==="update.interrupted") {
      const p=s.players[e.sourceId];if(p){p.interruptedUpdates++;score(s,p.id,150,"update");}
    } else if(e.kind==="economy.penalty") {
      const p=s.players[e.sourceId];if(!p)continue;
      if(s.mode==="cleanStreets" || s.mode==="hideInTheCrowd")score(s,p.id,e.amount===20?-200:-150,"wrong-target");
      event(s,"match.streak-reset",p.id,"",0,"wrong-target");
    } else if(e.kind==="player.runway" && Number.isFinite(e.amount)) {
      const p=s.players[e.targetId];if(p && p.downUntil<=s.tick && !p.eliminated)p.runway=clamp(p.runway+e.amount,0,1000);
    } else if(e.kind==="pvp.score" && Number.isFinite(e.amount))score(s,e.targetId,e.amount,"flower");
    else if(e.kind==="agi.pause" && s.mode!=="fogRoyale" && s.players[e.sourceId])finish(s,sortedIds(s.players).filter(id=>s.players[id]!.team===s.players[e.sourceId]!.team),"agi");
  }
  s.remainingBad.sort();if(events.length)s.lastCombatTick=Math.max(...events.map(e=>e.tick));
}
/** Clean Streets flowers: +25 for the thrower, and the rival cannot spray or scan for 1.5 s. */
function flowers(s:MatchState,ctx:MatchContext):void {
  for(const id of sortedIds(s.players)){
    const thrower=s.players[id]!,targetId=ctx.inputs?.[id]?.flowerTarget,target=targetId?s.players[targetId]:undefined;
    if(!target||target.team===thrower.team||thrower.downUntil>s.tick||(thrower.flowerReadyAt??0)>s.tick)continue;
    thrower.flowerReadyAt=s.tick+MATCH_RULES.flowerCooldownTicks;
    target.distractedUntil=s.tick+MATCH_RULES.distractedTicks;target.flowers=(target.flowers??0)+1;
    score(s,id,MATCH_RULES.flowerPoints,"flower");event(s,"match.flower",id,target.id,1);
  }
}
function revives(s:MatchState,ctx:MatchContext):void {
  for(const id of sortedIds(s.players)) {
    const target=s.players[id]!;if(target.downUntil<=s.tick)continue;
    const candidates=sortedIds(s.players).filter(other=>{
      const helper=s.players[other]!,a=ctx.positions[id],b=ctx.positions[other];
      return other!==id && helper.team===target.team && helper.downUntil<=s.tick && !helper.eliminated && ctx.inputs?.[other]?.reviveTarget===id && a && b &&
        (a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y)+(a.z-b.z)*(a.z-b.z)<=MATCH_RULES.reviveRange*MATCH_RULES.reviveRange;
    });
    const helper=candidates[0]??"";
    if(helper && target.reviverId===helper)target.reviveTicks++;else {target.reviverId=helper;target.reviveTicks=helper?1:0;}
    if(target.reviveTicks>=MATCH_RULES.reviveTicks) {
      target.runway=6;target.downUntil=0;target.respawnAt=0;target.reviveTicks=0;target.reviverId="";score(s,helper,100,"revive");event(s,"match.revived",id,helper,6);continue;
    }
    if(s.tick>=target.respawnAt) {
      s.lives--;target.runway=12;target.downUntil=0;target.respawnAt=0;target.reviveTicks=0;target.reviverId="";event(s,"match.respawn-request",id,"",s.lives,"team-spawn");
      if(s.lives<=0)finish(s,[],"lives");
    }
  }
}
function winners(s:MatchState):string[] {
  const teams=new Map<number,{score:number;updates:number}>();
  for(const p of sortedIds(s.players).map(id=>s.players[id]!)){const team=teams.get(p.team)??{score:0,updates:0};team.score+=p.score;team.updates+=p.interruptedUpdates;teams.set(p.team,team);}
  const order=[...teams].sort((a,b)=>b[1].score-a[1].score||b[1].updates-a[1].updates||a[0]-b[0]);
  if(order.length>1 && order[0]![1].score===order[1]![1].score && order[0]![1].updates===order[1]![1].updates)return [];
  return sortedIds(s.players).filter(id=>s.players[id]!.team===order[0]?.[0]);
}
export function stepMatch(previous:MatchState,ctx:MatchContext):MatchState {
  if(previous.version!==1)throw new Error("Unsupported match state");
  const tick=ctx.tick??previous.tick+1;
  if(!Number.isSafeInteger(tick)||tick<=previous.tick)throw new Error("Invalid match tick");
  const s=copy(previous,tick);if(s.phase==="finished")return s;
  // A global pause can skip this hook entirely. Shift absolute deadlines by every
  // skipped tick, then advance the match by exactly one active update.
  const skipped=tick-previous.tick-1+(ctx.paused?1:0);
  if(skipped)for(const p of sortedIds(s.players).map(id=>s.players[id]!)){if(p.downUntil>0)p.downUntil+=skipped;if(p.respawnAt>0)p.respawnAt+=skipped;if(p.fleeceUntil>0)p.fleeceUntil+=skipped;}
  if(ctx.paused)return s;
  s.elapsedTicks++;
  if(ctx.endRequested){finish(s,[],"ended");return s;}
  combat(s,ctx);if(s.result!==null)return s;
  for(const p of sortedIds(s.players).map(id=>s.players[id]!))if(p.runway<=0)down(s,p);
  if(s.mode==="botSweep") {revives(s,ctx);if(s.phase==="active" && !s.remainingBad.length && !s.relayId)finish(s,sortedIds(s.players),"sweep-complete");else if(s.elapsedTicks>=s.durationTicks)finish(s,[],"relay-update");}
  if(s.mode==="cleanStreets"){flowers(s,ctx);if(s.elapsedTicks>=s.durationTicks)finish(s,winners(s),"time");}
  return s;
}
export function matchPayout(state:MatchState,playerId:string):MatchPayout {
  const player=state.players[playerId];if(!player || state.phase!=="finished")return {xp:0,cashCents:0,achievements:[],factionClockMoves:0};
  const won=state.result!.winners.includes(playerId),xp=Math.max(0,Math.floor(player.score/10))+(won?100:25);
  return {xp,cashCents:Math.min(Math.max(0,Math.floor(player.score*25)),Math.floor(state.elapsedTicks/3600*7500)),achievements:won?[`${state.mode}:win`]:[],factionClockMoves:won?1:0};
}
