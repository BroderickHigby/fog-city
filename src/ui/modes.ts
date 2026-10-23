import type { UiCopy } from "./types.ts";

/** Presentation data only. The host owns the separate simulation and payout application. */
export type LocalModeChoice="botSweep"|"cleanStreets";
export interface MatchUiView {
  readonly id:string;
  readonly mode:LocalModeChoice;
  readonly phase:"active"|"finished";
  readonly remainingTicks:number;
  readonly objectivesRemaining:number;
  readonly score:number;
  readonly runway:number;
  readonly lives:number;
  readonly won?:boolean;
  readonly cashCents?:number;
  readonly xp?:number;
}
export interface LocalModeOption {readonly id:LocalModeChoice;readonly available:boolean;readonly reason?:string}
export const LOCAL_MODES:readonly LocalModeOption[]=Object.freeze([{id:"botSweep",available:true},{id:"cleanStreets",available:true}]);

export function matchTime(ticks:number):string {
  const seconds=Math.max(0,Math.ceil(Number.isFinite(ticks)?ticks/60:0));
  return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`;
}
function element<K extends keyof HTMLElementTagNameMap>(doc:Document,tag:K,text?:string):HTMLElementTagNameMap[K]{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
export function localModeMenu(doc:Document,copy:UiCopy,options:readonly LocalModeOption[],start:(mode:LocalModeChoice)=>void):HTMLElement {
  const menu=element(doc,"div");menu.className="fc-local-modes";
  for(const option of options){const card=element(doc,"article");card.className="fc-card";const button=element(doc,"button",copy("ui.lobby.start"));button.type="button";button.disabled=!option.available;button.addEventListener("click",()=>start(option.id));card.append(element(doc,"h2",copy(`ui.mode.${option.id}`)),button);if(option.reason)card.append(element(doc,"p",option.reason));menu.append(card);}
  return menu;
}
export function matchResults(doc:Document,copy:UiCopy,view:MatchUiView,returnToCity:()=>void):HTMLElement {
  const result=element(doc,"div");result.className="fc-match-results";
  result.append(element(doc,"h2",copy(`ui.mode.${view.mode}`)));
  if(view.won!==undefined)result.append(element(doc,"p",copy(view.won?"ui.match.won":"ui.match.lost")));
  const stats=element(doc,"dl");
  for(const [label,value]of [[copy("ui.match.score"),view.score],[copy("ui.match.remaining"),view.objectivesRemaining],[copy("ui.hud.runway"),view.runway],[copy("ui.hud.cash"),view.cashCents===undefined?undefined:`$${(view.cashCents/100).toFixed(2)}`],[copy("ui.hud.xp"),view.xp]] as const){if(value===undefined)continue;stats.append(element(doc,"dt",label),element(doc,"dd",String(value)));}
  const back=element(doc,"button",copy("ui.match.return"));back.type="button";back.addEventListener("click",()=>{back.disabled=true;returnToCity();});result.append(stats,back);return result;
}

/** Expected launch failures use authored action text; internal errors are never exposed. */
export function modeFailureText(error:unknown,copy:UiCopy):string {
  return error instanceof Error&&"reason"in error&&error.reason==="refill"?copy("ui.mode.refillRequired"):copy("ui.common.error");
}
