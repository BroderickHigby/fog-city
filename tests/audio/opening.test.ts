import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OpeningNarration, type OpeningManifest } from "../../src/audio/opening.ts";
import { VoiceQueue, type VoicePlayer } from "../../src/audio/voice-queue.ts";
import manifest from "../../public/audio/opening/manifest.json" with { type: "json" };
import { ROOT } from "../helpers.ts";

const story: OpeningManifest = { version:1,title:"Fog City",disclosure:"Fictional machine-generated narration",lines:[
  {id:"opening.a",text:"A first segment.",file:"a.mp3",durationS:1},
  {id:"opening.b",text:"A second segment.",file:"b.mp3",durationS:1},
] };
function setup(audible=true) {
  const plays:{url:string;callbacks:Parameters<VoicePlayer["play"]>[1];stopped:boolean}[]=[];
  const queue=new VoiceQueue({canPlay:()=>audible,player:{play(url,callbacks){const play={url,callbacks,stopped:false};plays.push(play);return {stop(){play.stopped=true;}};}}});
  return {queue,plays,opening:new OpeningNarration(queue,story)};
}
describe("opening through the existing narration queue",()=>{
  it("feeds one segment at a time so a minute-long story cannot go stale in the short queue",()=>{
    const {queue,plays,opening}=setup();opening.start(0);
    expect(plays.map(p=>p.url)).toEqual(["a.mp3"]);expect(queue.snapshot().waiting).toEqual([]);
    plays[0]!.callbacks.onStart();plays[0]!.callbacks.onEnd();queue.update(1000);opening.update(1000);
    expect(plays.map(p=>p.url)).toEqual(["a.mp3","b.mp3"]);expect(opening.status().line).toBe(2);
    plays[1]!.callbacks.onStart();plays[1]!.callbacks.onEnd();queue.update(2000);opening.update(2000);
    expect(opening.status().active).toBe(false);expect(queue.snapshot().current).toBeNull();
  });
  it("skip stops the current sound and replay starts with a new queue identity",()=>{
    const {queue,plays,opening}=setup();opening.start(0);const first=queue.snapshot().current;
    opening.skip();expect(plays[0]!.stopped).toBe(true);expect(opening.status().active).toBe(false);
    opening.start(1000);expect(queue.snapshot().current).not.toBe(first);expect(plays[1]!.url).toBe("a.mp3");
    // Late callbacks from the stopped attempt cannot finish the replay.
    plays[0]!.callbacks.onEnd();opening.update(1001);expect(opening.status().line).toBe(1);
  });
  it("uses subtitles when voice is locked/muted without holding gameplay or losing story order",()=>{
    const {queue,plays,opening}=setup(false);opening.start(0);
    expect(plays).toEqual([]);expect(queue.subtitle()).toMatchObject({mode:"text",text:"A first segment."});
    queue.update(5000);opening.update(5000);expect(queue.subtitle()).toMatchObject({mode:"text",text:"A second segment."});
    queue.update(10000);opening.update(10000);expect(opening.status().active).toBe(false);
  });
  it("slow/missing audio falls back through the existing bounded retry policy",()=>{
    const {queue,opening}=setup();opening.start(0);queue.update(3000);queue.update(6000);
    expect(queue.subtitle()).toMatchObject({mode:"text",required:true,text:"A first segment."});
    opening.update(6000);expect(opening.status().line).toBe(1);
    queue.update(11000);opening.update(11000);expect(opening.status().line).toBe(2);
  });
  it("a paused queue neither advances the story nor starts overlapping audio",()=>{
    const {queue,plays,opening}=setup();queue.setPaused(true,0);opening.start(0);
    queue.update(50000);opening.update(50000);expect(plays).toEqual([]);expect(opening.status().line).toBe(1);
    queue.setPaused(false,50000);queue.update(50001);opening.update(50001);expect(plays).toHaveLength(1);
  });
});

describe("delivered original opening recordings",()=>{
  it("ships six short, checksummed real MP3s and a disclosed stock-voice source",()=>{
    expect(manifest.version).toBe(1);expect(manifest.lines).toHaveLength(6);expect(manifest.disclosure).toContain("Machine-generated");
    expect(manifest.source.voice).toBe("M1 stock preset");
    let bytes=0,duration=0;
    for(const line of manifest.lines){
      const path=`${ROOT}/public/${line.file}`,data=readFileSync(path);bytes+=data.length;duration+=line.durationS;
      expect(line.durationS).toBeGreaterThan(1);expect(line.durationS).toBeLessThan(15);
      expect(statSync(path).size).toBe(line.bytes);expect(createHash("sha256").update(data).digest("hex")).toBe(line.sha256);
      expect(line.file).toMatch(/^audio\/opening\/opening\.[a-z-]+\.mp3$/);
      expect(line.sourceWavSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(bytes).toBeLessThan(1_000_000);expect(duration).toBeGreaterThan(45);expect(duration).toBeLessThan(75);
  });
});
