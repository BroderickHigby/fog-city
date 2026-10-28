/** Explicit SIM21 owner clocks; no generic field-name walk.
 * Core calls this BEFORE preparers/motion, on the membership-adjusted previous state.
 * Physical body objects, RNG and recorded event arrays are preserved by reference.
 */
import { ACTIVITY_DEFINITIONS } from "../content/gameplay.ts";
import { sortedIds, type SimState } from "./contract.ts";
import type { MissionProgress, PlayerActivities } from "./player/types.ts";
import type { RobotBrainState } from "./robots/brain.ts";
import type { AgentsRuntimeState, RuntimeActor } from "./agents/runtime.ts";
import type { BellDuelProgress } from "./missions/mechanics/bell-duel.ts";
import type { ParkingProgress } from "./missions/mechanics/parking.ts";
import type { ImpactsExt } from "./impacts.ts";
import type { RivalBotState } from "./bots/controller.ts";

export interface WorldPauseState {version:1;totalTicks:number}
export type PausedMissionProgress=MissionProgress&{pausedTicks?:number;stepPausedTicks?:number};
export type PausedActivity=PlayerActivities&{pausedTicks?:number;activityUntilTick?:number};
/** Pure periodic schedules (signals/population/fidelity), never recorded event timestamps. */
export function activeWorldTick(state:Readonly<SimState>):number {
  const pause=state.ext.pause as WorldPauseState|undefined;
  return state.version>=21&&pause?.version===1?state.tick-pause.totalTicks:state.tick;
}
/** Extend only live absolute deadlines. Equality is already expired; zero/MAX are sentinels. */
export function holdLiveDeadline(value:number,previousTick:number):number {
  return Number.isSafeInteger(value)&&value>0&&value>previousTick&&value<Number.MAX_SAFE_INTEGER?value+1:value;
}
const timestamp=(value:number):number=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER?value+1:value;
const count=(value:number|undefined):number=>Math.min(Number.MAX_SAFE_INTEGER,(value??0)+1);
function deadlines(values:Readonly<Record<string,number>>,tick:number):Record<string,number>{const next:Record<string,number>={};for(const id of sortedIds(values))next[id]=holdLiveDeadline(values[id]!,tick);return next;}
function parking(progress:ParkingProgress):ParkingProgress {return progress.completed?progress:{...progress,stoppedSince:timestamp(progress.stoppedSince)};}
function duel(progress:BellDuelProgress,tick:number):BellDuelProgress {
  if(progress.phase==="won"||progress.phase==="lost")return progress;
  return {...progress,cues:progress.cues.map(cue=>holdLiveDeadline(cue,tick)),responseTicks:progress.responseTicks.map((expected,index)=>{
    // Already played responses are history. Remaining responses move only while their acceptance
    // window is live (first-ring grace120, subsequent ring tolerance7), never after expiration.
    const grace=progress.ringIndex===0&&index===0?120:7;
    return index>=progress.ringIndex&&expected+grace>tick?timestamp(expected):expected;
  }),nextRoundTick:holdLiveDeadline(progress.nextRoundTick,tick)};
}
function brain(previous:RobotBrainState,tick:number):RobotBrainState {
  return {...previous,lastTick:tick+1,waryUntilTick:holdLiveDeadline(previous.waryUntilTick,tick),cooldownUntilTick:holdLiveDeadline(previous.cooldownUntilTick,tick),
    knowledge:previous.knowledge.map(known=>({...known,expiresTick:holdLiveDeadline(known.expiresTick,tick)})),
    // Start ticks can enter attack/channel identity tokens, so compensation is separate.
    closeWatches:previous.closeWatches.map(watch=>({...watch,pausedTicks:count((watch as typeof watch&{pausedTicks?:number}).pausedTicks)})),
    windup:previous.windup?{...previous.windup,pausedTicks:count((previous.windup as typeof previous.windup&{pausedTicks?:number}).pausedTicks)}:null,
    update:previous.update?{...previous.update,pausedTicks:count((previous.update as typeof previous.update&{pausedTicks?:number}).pausedTicks)}:null,
    ...(previous.fogChaseSinceTick!==null?{fogChasePausedTicks:count((previous as RobotBrainState&{fogChasePausedTicks?:number}).fogChasePausedTicks)}:{}),
    // pendingUpdates.completedTick and knowledge.observedTick remain actual recorded observations.
  };
}
function actor(previous:RuntimeActor,tick:number):RuntimeActor {
  return {...previous,brain:previous.brain?brain(previous.brain,tick):null,reaction:{...previous.reaction,untilTick:holdLiveDeadline(previous.reaction.untilTick,tick)},
    ...(previous.detour?{detour:{...previous.detour,until:holdLiveDeadline(previous.detour.until,tick)}}:{}),
    ...(previous.glanced!==undefined?{glanced:timestamp(previous.glanced)}:{}),
    ...(previous.stall?{stall:{...previous.stall,tick:timestamp(previous.stall.tick)}}:{}),
    // bornTick, attackSequence/actionToken and the actual accepted pose remain unchanged.
  };
}
function bots(previous:RivalBotState,tick:number):RivalBotState {
  const next:RivalBotState={...previous,tick:tick+1,bots:{}};
  for(const id of sortedIds(previous.bots)){const old=previous.bots[id]!;next.bots[id]={...old,recoverUntil:holdLiveDeadline(old.recoverUntil,tick),lastProgressTick:timestamp(old.lastProgressTick),knowledge:old.knowledge.map(known=>({...known,expiresTick:holdLiveDeadline(known.expiresTick,tick)}))};}
  return next;
}
/** No change at all to SIM20 or earlier. Tick advancement belongs to root core for that path. */
export function holdPausedWorldTimers(previous:Readonly<SimState>):SimState {
  if(previous.version<21)return previous as SimState;
  const at=previous.tick,tick=at+1,ext={...previous.ext},pause=previous.ext.pause as WorldPauseState|undefined;
  ext.pause={version:1,totalTicks:count(pause?.totalTicks)} satisfies WorldPauseState;
  // Car/foot/ride physics are unchanged; only a pending hail's expiry is a nonphysical timer.
  let players=previous.players;
  for(const id of sortedIds(players)){const own=players[id]!;if(own.hail){if(players===previous.players)players={...players};players[id]={...own,hail:{...own.hail,untilTick:holdLiveDeadline(own.hail.untilTick,at)}};}}
  if(ext.player){const state=ext.player;ext.player={...state,tick,players:{...state.players}};for(const id of sortedIds(state.players)){const own=state.players[id]!;ext.player.players[id]={...own,bridgeUntil:holdLiveDeadline(own.bridgeUntil,at),resumeTick:holdLiveDeadline(own.resumeTick,at)};}}
  if(ext.heat){const state=ext.heat;ext.heat={...state,tick,players:{...state.players}};for(const id of sortedIds(state.players)){const own=state.players[id]!;ext.heat.players[id]={...own,lastSeenTick:timestamp(own.lastSeenTick),lastAssociateSeenTick:timestamp(own.lastAssociateSeenTick),recentMelts:own.recentMelts.map(timestamp)};}}
  if(ext.missions){
    const state=ext.missions;ext.missions={...state,tick,players:{...state.players}};
    for(const id of sortedIds(state.players)){const own=state.players[id] as PausedMissionProgress;ext.missions.players[id]={...own,deadlineTick:holdLiveDeadline(own.deadlineTick,at),...(own.status==="active"?{pausedTicks:count(own.pausedTicks),...(!(own.deadlineTick>0&&own.deadlineTick<=at)?{stepPausedTicks:count(own.stepPausedTicks)}:{})}:{})};}
    if(state.parking){ext.missions.parking={...state.parking,tick,players:{...state.parking.players}};for(const id of sortedIds(state.parking.players))ext.missions.parking.players[id]=parking(state.parking.players[id]!);}
    if(state.bell){ext.missions.bell={...state.bell,tick,duels:{...state.bell.duels}};for(const id of sortedIds(state.bell.duels))ext.missions.bell.duels[id]=duel(state.bell.duels[id]!,at);}
  }
  if(ext.progression){const state=ext.progression;ext.progression={...state,tick,...(state.doom?{doom:{...state.doom,lastTick:tick,winterUntilTick:holdLiveDeadline(state.doom.winterUntilTick??0,at)}}:{})};}
  if(ext.activities){
    const state=ext.activities;ext.activities={...state,tick,players:{...state.players}};
    for(const id of sortedIds(state.players)){
      const own=state.players[id] as PausedActivity,authored=ACTIVITY_DEFINITIONS.find(def=>def.id===own.activeActivityId);
      const until=own.activityUntilTick??(authored?.timeLimitS!==undefined?own.activityStartedTick+Math.ceil(authored.timeLimitS*60)+(own.pausedTicks??0):0),live=!until||until>at;
      ext.activities.players[id]={...own,nextDirectorTick:holdLiveDeadline(own.nextDirectorTick,at),cardUntilTick:holdLiveDeadline(own.cardUntilTick,at),cardCooldowns:deadlines(own.cardCooldowns,at),...(own.cooldowns?{cooldowns:deadlines(own.cooldowns,at)}:{}),...(own.activeActivityId?{...(live?{pausedTicks:count(own.pausedTicks)}:{}),activityUntilTick:holdLiveDeadline(until,at)}:{}),
        ...(own.parking?{parking:{...own.parking,tick,progress:parking(own.parking.progress)}}:{}),
        ...(own.recon?.viewer?{recon:{...own.recon,viewer:{...own.recon.viewer,pausedTicks:count(own.recon.viewer.pausedTicks),untilTick:holdLiveDeadline(own.recon.viewer.untilTick,at),lastObservedTick:timestamp(own.recon.viewer.lastObservedTick),evidenceTick:timestamp(own.recon.viewer.evidenceTick),guide:own.recon.viewer.guide?{...own.recon.viewer.guide,flagUntilTick:holdLiveDeadline(own.recon.viewer.guide.flagUntilTick,at)}:null}}}:{}),
        ...(own.plainWords?{plainWords:{...own.plainWords,nextRebrandTick:holdLiveDeadline(own.plainWords.nextRebrandTick,at),boards:own.plainWords.boards.map(board=>({...board,sprayedUntil:holdLiveDeadline(board.sprayedUntil,at)}))}}:{})};
    }
  }
  if(ext.fog)ext.fog={...ext.fog,windows:ext.fog.windows.map(window=>({...window,untilTick:holdLiveDeadline(window.untilTick,at)}))};
  // ext.clock.elapsedTicks is retained, freezing calendar/weather/departures; a core-only
  // state without that extension gets its previous implicit clock made explicit once.
  if(!ext.clock)ext.clock={version:1,elapsedTicks:at};
  if(ext.robots){
    const state=ext.robots,next:AgentsRuntimeState={...state,tick,actors:{...state.actors}};for(const id of sortedIds(state.actors))next.actors[id]=actor(state.actors[id]!,at);
    if(state.missionStages){next.missionStages={...state.missionStages};for(const id of sortedIds(state.missionStages)){const stage=state.missionStages[id]!;next.missionStages[id]={...stage,nextTick:holdLiveDeadline(stage.nextTick,at)};}}
    if(state.services){next.services={...state.services,tick,vehicles:{...state.services.vehicles}};for(const id of sortedIds(state.services.vehicles)){const vehicle=state.services.vehicles[id]!;next.services.vehicles[id]={...vehicle,pausedTicks:count((vehicle as typeof vehicle&{pausedTicks?:number}).pausedTicks)};}}
    if(state.transit){next.transit={...state.transit,runs:{...state.transit.runs}};for(const id of sortedIds(state.transit.runs)){const run=state.transit.runs[id]!;next.transit.runs[id]={...run,dwellUntil:holdLiveDeadline(run.dwellUntil,at)};}}
    ext.robots=next;
  }
  const impacts=ext.impacts as ImpactsExt|undefined;
  if(impacts){const next:ImpactsExt={...impacts,cars:{...impacts.cars}};for(const id of sortedIds(impacts.cars)){const own=impacts.cars[id]!;next.cars[id]={...own,lastHitTick:timestamp(own.lastHitTick)};}if(impacts.props){next.props={...impacts.props};for(const id of sortedIds(impacts.props)){const prop=impacts.props[id]!;next.props[id]={...prop,pausedTicks:count((prop as typeof prop&{pausedTicks?:number}).pausedTicks)};}}ext.impacts=next;}
  // Match reducers already compensate skipped ticks; do not shift match tick/deadlines twice.
  const modes=ext.modes as unknown as {sweep?:{bots?:RivalBotState}}|undefined;
  if(modes?.sweep?.bots)ext.modes={...ext.modes,sweep:{...modes.sweep,bots:bots(modes.sweep.bots,at)}} as unknown as typeof ext.modes;
  // ext.combat handled by holdCombatTimers. Doom/combat pauseUntil remain outer-tick controls.
  // Recorded events, grant/fact cursors, pending request IDs, source timestamps and RNG are untouched.
  return {...previous,tick,players,ext};
}
