import { gameplayCommandFromEvent, type GameplayCommandEvent, type GameplayCommandPayload } from "../sim/gameplay-contract.ts";
import type { UiCallbacks } from "./types.ts";

/** Each click produces one ID-only event for recording and deterministic playback. */
export function createGameplayDispatcher(options:{playerId:string;tick:()=>number;emit:(event:GameplayCommandEvent)=>void;initialSequence?:number}):(payload:Omit<GameplayCommandPayload,"sequence">)=>void {
  let sequence=options.initialSequence??1;
  const send=(payload:Omit<GameplayCommandPayload,"sequence">):void=>{
    const event:GameplayCommandEvent={tick:options.tick(),kind:"gameplay.command",playerId:options.playerId,payload:{...payload,sequence}};
    if(!gameplayCommandFromEvent(event))throw new Error("Invalid UI gameplay command");
    options.emit(event);sequence++;
  };
  return send;
}

export function gameplayCallbacks(options:Parameters<typeof createGameplayDispatcher>[0]):UiCallbacks {
  const send=createGameplayDispatcher(options);
  return {purchase:(itemId,targetId)=>send({kind:"buy",itemId,...(targetId?{targetId}:{})}),startup:kitId=>send({kind:"startup-define",kitId}),closeAd:targetId=>send({kind:"close-ad",targetId})};
}
