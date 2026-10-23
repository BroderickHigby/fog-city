import { sortedIds } from "../contract.ts";
import type { CombatEvent } from "../combat-contract.ts";

export interface VibesCast {badId:string;goodIds:readonly [string,string];investorIds:readonly string[]}
export interface VibesDemo {playerId:string;score:number;calledId:string;melted:boolean;incidents:string[]}
export interface VibesEvent {id:number;tick:number;kind:string;playerId:string;targetId:string;amount:number}
export interface VibesState {
  version:1;id:string;tick:number;elapsedTicks:number;phase:"demo"|"voting"|"award"|"finished";
  presenterIndex:number;presenterTicks:number;voteTicks:number;order:string[];cast:Record<string,VibesCast>;
  demos:Record<string,VibesDemo>;votes:Record<string,string>;awardId:string;awardRequestId:string;presenterStartTick:number;winnerId:string;
  lastCombatTick:number;lastCombatId:number;nextEventId:number;events:VibesEvent[];
}
export interface VibesInput {calledId?:string;voteId?:string}
export interface VibesContext {
  tick?:number;paused?:boolean;inputs?:Readonly<Record<string,VibesInput>>;combatEvents?:readonly CombatEvent[];
  /** A server-produced result, recorded as an external fact. Never accept this from a client. */
  award?:{id:string;matchId:string;requestId:string;winnerId:string;candidates:readonly string[]};
}
export const VIBES_RULES={demoTicks:90*60,voteTicks:30*60,correctCall:100,correctMelt:200,wrongCall:-100,wrongRobot:-150,wetInvestor:-200} as const;
const validId=(id:string)=>/^[A-Za-z0-9:_-]{1,96}$/.test(id)&&!Object.hasOwn(Object.prototype,id)&&id!=="prototype";
function emit(s:VibesState,kind:string,playerId="",targetId="",amount=0):void{s.events.push({id:s.nextEventId++,tick:s.tick,kind,playerId,targetId,amount});}
export function createVibesState(id:string,players:readonly string[],cast:Readonly<Record<string,VibesCast>>):VibesState {
  const order=[...players].sort();
  if(!validId(id)||order.length<2||order.length>8||new Set(order).size!==order.length||order.some(id=>!validId(id)))throw new Error("Invalid Vibes room");
  const demos:Record<string,VibesDemo>={},actors:Record<string,VibesCast>={},used=new Set(order);
  for(const playerId of order){
    const spec=cast[playerId];if(!spec||spec.goodIds.length!==2||spec.investorIds.length>16)throw new Error("Vibes requires three demo robots");
    const ids=[spec.badId,...spec.goodIds,...spec.investorIds];if(ids.some(id=>!validId(id))||new Set(ids).size!==ids.length||ids.some(id=>used.has(id)))throw new Error("Invalid demo actors");
    for(const id of ids)used.add(id);
    actors[playerId]={badId:spec.badId,goodIds:[spec.goodIds[0],spec.goodIds[1]],investorIds:[...spec.investorIds]};
    demos[playerId]={playerId,score:0,calledId:"",melted:false,incidents:[]};
  }
  return {version:1,id,tick:0,elapsedTicks:0,phase:"demo",presenterIndex:0,presenterTicks:0,voteTicks:0,order,cast:actors,demos,votes:{},awardId:"",awardRequestId:"",presenterStartTick:1,winnerId:"",lastCombatTick:-1,lastCombatId:-1,nextEventId:1,events:[]};
}
function demo(s:VibesState,ctx:VibesContext):void {
  const id=s.order[s.presenterIndex]!,score=s.demos[id]!,cast=s.cast[id]!,input=ctx.inputs?.[id];
  if(input?.calledId&&!score.calledId&&[cast.badId,...cast.goodIds].includes(input.calledId)){
    score.calledId=input.calledId;const amount=input.calledId===cast.badId?VIBES_RULES.correctCall:VIBES_RULES.wrongCall;
    score.score+=amount;emit(s,"vibes.call",id,input.calledId,amount);
  }
  const facts=[...(ctx.combatEvents??[])].filter(e=>Number.isSafeInteger(e.id)&&e.id>0&&Number.isSafeInteger(e.tick)&&e.tick>=0&&(e.tick>s.lastCombatTick||e.tick===s.lastCombatTick&&e.id>s.lastCombatId)&&e.tick>=s.presenterStartTick&&e.tick<=s.tick).sort((a,b)=>a.tick-b.tick||a.id-b.id);
  const seen=new Set<string>();
  for(const e of facts){
    const key=`${e.tick}:${e.id}`;if(seen.has(key)||e.sourceId!==id)continue;seen.add(key);
    if(e.kind==="robot.heap"&&e.targetId===cast.badId&&!score.melted){score.melted=true;score.score+=VIBES_RULES.correctMelt;emit(s,"vibes.melt",id,e.targetId,VIBES_RULES.correctMelt);}
    const incident=e.kind==="person.wet"&&cast.investorIds.includes(e.targetId)?`investor:${e.targetId}`:
      e.kind==="economy.penalty"&&cast.goodIds.includes(e.targetId)?`robot:${e.targetId}`:"";
    if(incident&&!score.incidents.includes(incident)){score.incidents.push(incident);const amount=incident.startsWith("investor:")?VIBES_RULES.wetInvestor:VIBES_RULES.wrongRobot;score.score+=amount;emit(s,"vibes.incident",id,e.targetId,amount);}
  }
  if(facts.length){s.lastCombatTick=facts[facts.length-1]!.tick;s.lastCombatId=facts[facts.length-1]!.id;}
  if(++s.presenterTicks<VIBES_RULES.demoTicks)return;
  emit(s,"vibes.demo-complete",id,"",score.score);s.presenterTicks=0;s.presenterIndex++;
  if(s.presenterIndex>=s.order.length){s.phase="voting";emit(s,"vibes.voting-open");}
  else {s.presenterStartTick=s.tick+1;emit(s,"vibes.presenter",s.order[s.presenterIndex]!);}
}
export function vibesAwardCandidates(state:VibesState):string[] {
  const counts:Record<string,number>=Object.fromEntries(state.order.map(id=>[id,0]));
  for(const id of sortedIds(state.votes)){const target=state.votes[id]!;if(Object.hasOwn(counts,target))counts[target]!++;}
  const maximum=Math.max(...state.order.map(id=>counts[id]!));return state.order.filter(id=>counts[id]===maximum);
}
export function stepVibes(previous:VibesState,ctx:VibesContext):VibesState {
  const tick=ctx.tick??previous.tick+1;if(previous.version!==1||!Number.isSafeInteger(tick)||tick<=previous.tick)throw new Error("Invalid Vibes tick");
  const s:VibesState={...previous,tick,demos:Object.fromEntries(sortedIds(previous.demos).map(id=>[id,{...previous.demos[id]!,incidents:[...previous.demos[id]!.incidents]}])),votes:{...previous.votes},events:[]};
  if(s.phase==="finished"||ctx.paused)return s;s.elapsedTicks++;
  if(s.phase==="demo")demo(s,ctx);
  else if(s.phase==="voting"){
    for(const id of s.order){const target=ctx.inputs?.[id]?.voteId;if(target&&target!==id&&s.order.includes(target)&&!s.votes[id]){s.votes[id]=target;emit(s,"vibes.vote",id,target);}}
    if(++s.voteTicks>=VIBES_RULES.voteTicks){s.phase="award";s.awardRequestId=`award:${s.id}:${s.tick}`;emit(s,"vibes.award-request");}
  }
  if(s.phase==="award"&&ctx.award){
    const candidates=vibesAwardCandidates(s),award=ctx.award;
    if(validId(award.id)&&award.matchId===s.id&&award.requestId===s.awardRequestId&&award.id===s.awardRequestId&&candidates.includes(award.winnerId)&&award.candidates.length===candidates.length&&award.candidates.every((id,index)=>id===candidates[index])){
      s.phase="finished";s.awardId=award.id;s.winnerId=award.winnerId;emit(s,"vibes.award",award.winnerId);
    }
  }
  return s;
}
