import type {SimState} from "../sim/contract.ts";
import type {JsonObject} from "../sim/extensions.ts";
import type {ProgressionDocument} from "./store.ts";
import {captureProgression,restoreProgression,validateSavedProgression} from "./progression.ts";

/** Profile data stays outside the transient simulation but survives every later capture. */
export class ProgressionSession {
  private profile:JsonObject|undefined;
  capture(state:SimState,playerId:string):ProgressionDocument{return captureProgression(state,playerId,this.profile);}
  restore(fresh:SimState,data:ProgressionDocument,playerId:string):SimState {
    const clean=validateSavedProgression(data),restored=restoreProgression(fresh,clean,playerId);
    this.profile=clean.profile===undefined?undefined:JSON.parse(JSON.stringify(clean.profile)) as JsonObject;
    return restored;
  }
}
