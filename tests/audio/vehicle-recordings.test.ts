import { describe, expect, it, vi } from "vitest";
import { RecordedDrivingAudio, drivingMix, MAX_DRIVING_SOURCES, type DrivingFrame, type DrivingManifest } from "../../src/audio/vehicle-recordings.ts";
const frame = (extra: Partial<DrivingFrame> = {}): DrivingFrame => ({ identity:"p:p", profile:"light-ice", speedMps:10, grounded:true, lateralMps:0, grip:1, dtS:1/60, ...extra });
const hash = "0".repeat(64);
const manifest = (): DrivingManifest => ({ schema:1,status:"ready",qualityApproved:true,recordings:(["idle","roll","road","brake","accel"] as const).map(id => ({id,licence:"CC0-1.0",author:"fixture",sourcePage:"https://example.invalid/fixture",maxDecodedSeconds:5,sources:[{url:`audio/vehicle/${id}.ogg`,sha256:hash,loopStartS:0,loopEndS:2}]})) });
function context() {
  const param = () => ({value:0,setTargetAtTime:vi.fn(),cancelScheduledValues:vi.fn()});
  const node = () => ({connect:vi.fn(),disconnect:vi.fn()});
  const sources: Array<ReturnType<typeof makeSource>> = [];
  function makeSource() { return {...node(),buffer:null,loop:false,loopStart:0,loopEnd:0,playbackRate:param(),onended:null as null | (()=>void),start:vi.fn(),stop:vi.fn()}; }
  const ctx = { currentTime:0,state:"running",createGain:()=>({...node(),gain:param()}),createBiquadFilter:()=>({...node(),type:"lowpass",frequency:param()}),
    createBufferSource:()=>{const source=makeSource();sources.push(source);return source;},
    decodeAudioData:vi.fn(async()=>({length:96000,numberOfChannels:1,duration:2,sampleRate:48000})) };
  return {ctx:ctx as unknown as AudioContext,raw:ctx,sources};
}
const fetcher = vi.fn(async()=>({ok:true,status:200,headers:{get:()=>null},arrayBuffer:async()=>new ArrayBuffer(4)})) as unknown as typeof fetch;
function create() { const c=context(); const audio=new RecordedDrivingAudio(c.ctx,{} as AudioNode,manifest(),{fetcher,digest:async()=>hash});return {...c,audio}; }

describe("recorded driving model",()=>{
  it("uses modest pitch limits, real layers and shared recording profiles",()=>{
    for(const speed of [-200,-10,0,10,200]) {const mix=drivingMix(frame({speedMps:speed}),null);expect(mix.rate).toBeGreaterThanOrEqual(.95);expect(mix.rate).toBeLessThanOrEqual(1.05);}
    expect(drivingMix(frame({speedMps:0}),null).road).toBe(0);
    expect(drivingMix(frame({grounded:false}),null).road).toBe(0);
    expect(drivingMix(frame({profile:"road-only"}),null)).toMatchObject({idle:0,roll:0,accelerate:false});
  });
  it("discards history on body changes, restore and long frames",()=>{
    const previous=frame({speedMps:0});
    expect(drivingMix(frame({speedMps:4}),previous).accelerate).toBe(true);
    expect(drivingMix(frame({speedMps:4,identity:"a:7"}),previous).accelerate).toBe(false);
    expect(drivingMix(frame({speedMps:4,dtS:5}),previous).accelerate).toBe(false);
    expect(drivingMix(frame({speedMps:4}),null).accelerate).toBe(false);
  });
  it("only brakes while grounded and moving, and softens cabin volume",()=>{
    expect(drivingMix(frame({lateralMps:5}),null).brake).toBeGreaterThan(0);
    expect(drivingMix(frame({grounded:false,lateralMps:5}),null).brake).toBe(0);
    expect(drivingMix(frame({speedMps:0,lateralMps:5}),null).brake).toBe(0);
    expect(drivingMix(frame({cabin:true}),null).road).toBeCloseTo(drivingMix(frame(),null).road*.6);
  });
});
describe("recorded driving lifetime",()=>{
  it("only starts after data is ready; pause release does not get postponed every frame",async()=>{
    const {audio,sources}=create();audio.set(frame());expect(sources).toHaveLength(0);await audio.load();expect(sources).toHaveLength(3);
    for(let i=0;i<100;i++)audio.set(null);
    for(const source of sources)expect(source.stop).toHaveBeenCalledTimes(1);
    audio.dispose();expect(audio.info().activeSources).toBe(0);
  });
  it("mute, visibility, restore and occupied-body changes stop old sources",async()=>{
    const {audio,sources}=create();await audio.load();audio.set(frame());audio.setEnabled(false);for(const source of sources)expect(source.stop).toHaveBeenCalled();
    for(const source of [...sources])source.onended?.();audio.setEnabled(true);expect(audio.info().activeSources).toBe(3);
    audio.setVisible(false);for(const source of [...sources])source.onended?.();audio.setVisible(true);
    audio.set(frame({identity:"a:7",profile:"road-only"}));expect(audio.info().activeSources).toBe(1);
    audio.reset();expect(audio.info().activeSources).toBe(0);audio.dispose();
  });
  it("does not replay transient acceleration from an async load or an unmute",async()=>{
    const {audio,sources}=create();audio.set(frame({speedMps:0}));audio.set(frame({speedMps:8}));await audio.load();expect(sources.every(s=>s.loop)).toBe(true);
    audio.setEnabled(false);for(const source of [...sources])source.onended?.();audio.setEnabled(true);expect(sources.every(s=>s.loop)).toBe(true);audio.dispose();
  });
  it("never creates oscillators and bounds sources under repeated slip/acceleration",async()=>{
    const {audio,raw}=create();await audio.load();
    for(let i=0;i<1000;i++){raw.currentTime=i/60;audio.set(frame({speedMps:i%2?20:5,lateralMps:5}));expect(audio.info().activeSources).toBeLessThanOrEqual(MAX_DRIVING_SOURCES);}
    audio.dispose();expect(audio.info().activeSources).toBe(0);
  });
  it("a late decoder completion after dispose never starts or retains a graph",async()=>{
    const {audio,raw,sources}=create();let finish:(value:unknown)=>void=()=>{};
    raw.decodeAudioData.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}) as never);
    audio.set(frame());const loading=audio.load();for(let i=0;i<8;i++)await Promise.resolve();audio.dispose();finish({length:96000,numberOfChannels:1,duration:2,sampleRate:48000});await loading;
    expect(sources).toHaveLength(0);expect(audio.info().ready).toBe(0);
  });
  it("unapproved inputs make no fetches and never fall back to synthetic tones",async()=>{
    const c=context(), fetch=vi.fn();const audio=new RecordedDrivingAudio(c.ctx,{} as AudioNode,{...manifest(),status:"draft",qualityApproved:false},{fetcher:fetch});audio.set(frame());await audio.load();expect(fetch).not.toHaveBeenCalled();expect(c.sources).toHaveLength(0);audio.dispose();
  });
  it("bad hashes fail silently without decoding; retries are explicit",async()=>{
    const c=context(),fetch=vi.fn(fetcher);const audio=new RecordedDrivingAudio(c.ctx,{} as AudioNode,manifest(),{fetcher:fetch,digest:async()=>"f".repeat(64)});await audio.load();expect(c.raw.decodeAudioData).not.toHaveBeenCalled();expect(Object.keys(audio.info().missing)).toHaveLength(5);const n=fetch.mock.calls.length;for(let i=0;i<30;i++)audio.set(frame());expect(fetch.mock.calls).toHaveLength(n);await audio.retry();expect(fetch.mock.calls.length).toBe(n*2);audio.dispose();
  });
});
