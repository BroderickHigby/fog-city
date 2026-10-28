// Runway Run, as the UI sees it: a plain view of ext.runway for one player, the compact money
// format, and the target's bearing. Presentation only; the sim owns every number.
import type { SimState } from "../sim/contract.ts";
import { activeBody } from "../sim/step.ts";
import { RUNWAY_CLEAR_EVENT, RUNWAY_QUIT_EVENT, RUNWAY_START_EVENT, isDriving, runwayOf, stageFor } from "../sim/runway-run/index.ts";
import { RUNWAY_INVESTORS } from "../content/runwayInvestors.ts";
import type { RunwayView } from "./types.ts";

/** $640k, $1.2M, $2B: whole dollars in, short text out. */
export function formatRaised(dollars:number):string {
  const d=Number.isFinite(dollars)?Math.max(0,Math.round(dollars)):0;
  const trim=(n:number)=>n.toFixed(1).replace(/\.0$/,"");
  if(d>=1e9)return `$${trim(d/1e9)}B`;
  if(d>=1e6)return `$${trim(d/1e6)}M`;
  if(d>=1e3)return `$${Math.round(d/1e3)}k`;
  return `$${d}`;
}

/** m:ss for a runway in seconds. */
export function formatRunway(seconds:number):string {
  const s=Math.max(0,Math.ceil(Number.isFinite(seconds)?seconds:0));
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
}

export function runwayView(state:Readonly<SimState>,playerId:string):RunwayView {
  const player=state.players[playerId],run=runwayOf(state)?.runs[playerId];
  const driving=!!player&&isDriving(player);
  if(!run)return {phase:"idle",canStart:driving,runwayS:0,raised:0,hype:1,closed:0,best:0,stage:stageFor(0),carrying:false,notes:[]};
  const who=(i:number)=>RUNWAY_INVESTORS[i]??RUNWAY_INVESTORS[0]!;
  const notes=run.notes.map(n=>({id:n.id,kind:n.kind,name:who(n.investor).name,firm:who(n.investor).firm,amount:n.amount,seconds:n.seconds}));
  const base={phase:run.phase,canStart:driving&&run.phase==="over",runwayS:run.runwayTicks/60,raised:run.raised,hype:run.hype,closed:run.closed,best:run.best,stage:stageFor(run.raised),carrying:run.carrying,notes};
  if(run.phase!=="running"||!run.target||!player)return base;
  const body=activeBody(player),dx=run.target.x-body.x,dz=run.target.z-body.z;
  // Compass bearing to the target (+x east, -z north), then the turn from the car's heading.
  let turn=Math.atan2(dx,-dz)-body.heading;
  turn=Math.atan2(Math.sin(turn),Math.cos(turn));
  const investor=who(run.investor);
  return {...base,investor:{name:investor.name,firm:investor.firm},target:{x:run.target.x,z:run.target.z},targetM:Math.round(Math.sqrt(dx*dx+dz*dz)),targetTurn:turn};
}

/** The HUD arrow's CSS turn. Its glyph (➤) points right, and turn 0 means dead ahead, so it turns a quarter back. */
export function arrowTransform(turn:number):string {return `rotate(${turn-Math.PI/2}rad)`;}

// The one way into Runway Run. The game (main.ts) binds the function that queues a recorded sim
// event; the pause-panel button, the I key's Start button, the debug hook and any later entry (a
// phone tile) all call startRunwayRun(), so there is one path and one recorded event.
type RunwaySender=(kind:string)=>void;
let send:RunwaySender|undefined;
/** Bind the sender (main.ts). Returns an unbind for teardown. */
export function bindRunwaySender(next:RunwaySender):()=>void {send=next;return ()=>{if(send===next)send=undefined;};}
/** Start a run, or a fresh one after a finished run. The sim ignores it unless the player is at the wheel of a car. */
export function startRunwayRun():void {send?.(RUNWAY_START_EVENT);}
/** End the running run now; the results stay. */
export function quitRunwayRun():void {send?.(RUNWAY_QUIT_EVENT);}
/** Leave a finished run's results. */
export function clearRunwayRun():void {send?.(RUNWAY_CLEAR_EVENT);}
