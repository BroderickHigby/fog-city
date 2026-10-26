import { afterEach, describe, expect, it, vi } from "vitest";
import { GameAudio } from "../../src/audio/mixer.ts";
import { RecordedDrivingAudio } from "../../src/audio/vehicle-recordings.ts";
import { DEFAULT_AUDIO_PREFS } from "../../src/audio/prefs.ts";
import { engineParams } from "../../src/audio/vehicle-sound.ts";
import type { CarState } from "../../src/sim/contract.ts";
const car={speed:10,grounded:true,lateral:0,grip:1} as CarState;
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture(){
 const parameter=()=>({value:0,setValueAtTime:vi.fn(),setTargetAtTime:vi.fn(),cancelScheduledValues:vi.fn()});
 const node=()=>({connect:vi.fn(),disconnect:vi.fn(),gain:parameter()});
 const raw={currentTime:0,state:"running",destination:node(),createGain:vi.fn(node),createOscillator:vi.fn(()=>{throw Error("Synthetic driving oscillator forbidden");}),resume:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
 const ctor=vi.fn(function(){return raw;});vi.stubGlobal("AudioContext",ctor);
 const doc=new EventTarget() as EventTarget&{visibilityState:string};doc.visibilityState="visible";vi.stubGlobal("document",doc);
 const load=vi.spyOn(RecordedDrivingAudio.prototype,"load").mockResolvedValue();
 return {raw,ctor,doc,load,audio:new GameAudio({...DEFAULT_AUDIO_PREFS})};
}
describe("recorded driving through GameAudio",()=>{
 it("constructs no context before gesture and never creates the old whine oscillator",()=>{
  const {audio,raw,ctor,load}=fixture();audio.setEngine(engineParams(car,car,1/60));expect(ctor).not.toHaveBeenCalled();audio.unlock();audio.setEngine(engineParams(car,car,1/60));expect(ctor).toHaveBeenCalledOnce();expect(load).toHaveBeenCalled();expect(audio.info().driving?.kind).toBe("recorded");expect(raw.createOscillator).not.toHaveBeenCalled();audio.dispose();
 });
 it("honors effect mute and visibility, removes listeners and cannot revive after disposal",()=>{
  const {audio,raw,ctor,doc}=fixture();audio.unlock();audio.setEngine(engineParams(car,car,1/60));audio.setPrefs({...DEFAULT_AUDIO_PREFS,effectsMuted:true});expect(audio.info().driving?.enabled).toBe(false);audio.setPrefs({...DEFAULT_AUDIO_PREFS});expect(audio.info().driving?.enabled).toBe(true);
  doc.visibilityState="hidden";doc.dispatchEvent(new Event("visibilitychange"));expect(audio.info().driving?.enabled).toBe(false);doc.visibilityState="visible";doc.dispatchEvent(new Event("visibilitychange"));expect(audio.info().driving?.enabled).toBe(true);
  audio.resetDriving();expect(audio.info().engine).toBe(false);audio.dispose();const n=raw.resume.mock.calls.length;doc.dispatchEvent(new Event("visibilitychange"));audio.unlock();expect(raw.resume.mock.calls).toHaveLength(n);expect(ctor).toHaveBeenCalledOnce();expect(raw.close).toHaveBeenCalledOnce();expect(audio.info().driving).toBeNull();
 });
});
