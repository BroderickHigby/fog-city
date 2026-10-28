/** Diagnostic only: verbatim existing perf functions; sampler instrumentation is not budget acceptance. */
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {Session} from "node:inspector";
import {GCProfiler,getHeapStatistics} from "node:v8";
import {createGameSystems,createInitialState,step,hashState,type SimState} from "./snapshot/src/sim/index.ts";
import {buildWorldWithRoads,loadWorldFiles} from "./snapshot/tests/helpers.ts";
const WARM=900,BLOCKS=6,BLOCK_TICKS=50;
function calibrate(): number {
  let sum = 0;
  const ids: string[] = [];
  for (let i = 0; i < 400; i++) ids.push(`agent:${(i * 7919) % 1000}`);
  const map = new Map<string, { x: number; z: number; heading: number; speed: number; tag: string }>();
  for (let round = 0; round < 6; round++) {
    let list = ids.map((id, i) => ({ id, x: i * 1.5, z: i * 0.5, heading: i * 0.01, speed: 1, tag: "walker", a: 0, b: 1, c: 2, d: 3, e: 4, f: 5 }));
    for (let k = 0; k < 4; k++) list = list.map((o) => ({ ...o, x: o.x + Math.sqrt(o.z + k + 1), z: o.z * 0.999 }));
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const o of list) map.set(o.id, o);
    for (const id of sorted) sum += map.get(id)!.x;
    const set = new Set(sorted.map((id) => `${id}:${round}`));
    sum += set.size;
  }
  return sum;
}

function scenario(): { run: (ticks: number) => void; state: () => SimState } {
  const files = loadWorldFiles("sf");
  const world = buildWorldWithRoads(files.tiles, files.roads, files.boundary, files);
  const systems = createGameSystems({ wave: 3 });
  let s = createInitialState(world, 1, ["p1"], files.manifest.spawn);
  return {
    run(ticks) {
      for (let i = 0; i < ticks; i++) {
        const phase = Math.floor(s.tick / 240) % 4;
        s = step(world, s, { p1: { throttle: 0.45, steer: phase === 1 ? 0.25 : phase === 3 ? -0.25 : 0, brake: 0, actions: 0 } }, [], systems);
      }
    },
    state: () => s,
  };
}

function bytesAllocated(stats: ReturnType<GCProfiler["stop"]>, startUsed: number, endUsed: number): number {
  let total = 0;
  let from = startUsed;
  for (const gc of stats?.statistics ?? []) {
    total += Math.max(0, gc.beforeGC.heapStatistics.usedHeapSize - from);
    from = gc.afterGC.heapStatistics.usedHeapSize;
  }
  return total + Math.max(0, endUsed - from);
}

const OUT=process.env.FOG_PROFILE_OUT??join(import.meta.dirname,"result");mkdirSync(OUT,{recursive:true});
if(process.env.FOG_PERF_UPDATE)throw new Error("FOG_PERF_UPDATE must be absent; diagnostic never rewrites baseline");
if(getHeapStatistics().heap_size_limit>3_000_000_000)throw new Error("Run profiler with --max-old-space-size=2048");
const manifest=JSON.parse(readFileSync(join(import.meta.dirname,"snapshot-manifest.json"),"utf8"));
function fingerprint(){for(const [file,wanted]of Object.entries(manifest.files)){const actual=createHash("sha256").update(readFileSync(join(import.meta.dirname,"snapshot",file))).digest("hex");if(actual!==wanted)throw new Error(`Snapshot changed: ${file}`);}}
fingerprint();
const session=new Session();session.connect();
const post=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)));
const started=performance.now(),sim=scenario();sim.run(WARM);
let check=0;for(let i=0;i<3;i++)check+=calibrate();
const warmHash=hashState(sim.state()),simMs:number[]=[],calMs:number[]=[],blocks:unknown[]=[];let bytes=0;
await post("HeapProfiler.startSampling",{samplingInterval:65536,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
for(let b=0;b<BLOCKS;b++){
 let t0=performance.now();check+=calibrate();calMs.push(performance.now()-t0);
 const profiler=new GCProfiler(),used0=process.memoryUsage().heapUsed;profiler.start();t0=performance.now();sim.run(BLOCK_TICKS);simMs.push((performance.now()-t0)/BLOCK_TICKS);
 const stats=profiler.stop(),used1=process.memoryUsage().heapUsed,allocated=bytesAllocated(stats,used0,used1);bytes+=allocated;
 blocks.push({block:b,startTick:WARM+b*BLOCK_TICKS+1,endTick:sim.state().tick,allocatedBytes:allocated,simMsPerTick:simMs[b],calibrationMs:calMs[b],gcCount:stats?.statistics.length??0});
 if(performance.now()-started>85000)throw new Error("Diagnostic exceeded its bounded85s workload deadline");
}
const {profile}=await post("HeapProfiler.stopSampling");session.disconnect();
if(sim.state().tick!==1200||check<=0)throw new Error("Exact workload did not finish");
writeFileSync(join(OUT,"allocation.heapprofile"),JSON.stringify(profile));
const sites=new Map<string,any>();let sampledSimBytes=0,sampledCalibrationBytes=0;
function walk(node:any,category="other"):number {
 const frame=node.callFrame,url=frame.url??"",name=frame.functionName??"";
 if(url.endsWith("profile-allocation.ts")&&name==="run")category="sim";
 if(url.endsWith("profile-allocation.ts")&&name==="calibrate")category="calibration";
 const key=`${url}:${frame.lineNumber+1}:${frame.columnNumber+1}:${name}`,self=node.selfSize??0;
 let inclusive=self;for(const child of node.children??[])inclusive+=walk(child,category);
 if(category==="sim"){
  sampledSimBytes+=self;const row=sites.get(key)??{function:name||"(anonymous)",file:url.replace(new URL("./snapshot/",import.meta.url).href,""),line:frame.lineNumber+1,column:frame.columnNumber+1,selfBytes:0,inclusiveBytes:0};row.selfBytes+=self;row.inclusiveBytes+=inclusive;sites.set(key,row);
 }else if(category==="calibration")sampledCalibrationBytes+=self;
 return inclusive;
}
walk(profile.head);
const baseline=JSON.parse(readFileSync(join(import.meta.dirname,"snapshot/tests/sim/perf-budget.json"),"utf8"));
fingerprint();
const report={kind:"sampled allocation diagnosis; instrumentation is not budget/timing acceptance",node:process.version,requestedNodeOldSpaceMB:Number(process.env.FOG_PROFILE_NODE_HEAP_MB??1024),heapLimitBytes:getHeapStatistics().heap_size_limit,sourceManifestSha256:manifest.sourceManifestSha256,branch:manifest.branch,head:manifest.head,workload:{warmTicks:WARM,blocks:BLOCKS,blockTicks:BLOCK_TICKS,finalTick:sim.state().tick,calibrationWarmups:3,scenario:"verbatim existing perf-budget.test.ts functions",workloadFunctionsSha256:"0ef83a3fa1b6daa7992c2deb36a51fd70549e87aa3308d6a445dd69d798d0b7a"},sampling:{intervalBytes:65536,collectedMinor:true,collectedMajor:true,samples:profile.samples?.length??0,sampledSimBytes,sampledCalibrationBytes},budget:{baseline,ratioLimit:baseline.ratio*1.6,allocationLimitBytesPerTick:baseline.bytesPerTick*1.3,unchanged:true},instrumented:{allocatedBytesPerTick:bytes/300,ratio:Math.min(...simMs)/Math.min(...calMs),blocks,wallMs:performance.now()-started,warmHash,finalHash:hashState(sim.state()),rss:process.memoryUsage().rss},topSelf:[...sites.values()].sort((a,b)=>b.selfBytes-a.selfBytes).slice(0,40),topInclusive:[...sites.values()].sort((a,b)=>b.inclusiveBytes-a.inclusiveBytes).slice(0,25),population:{physicalAgents:sim.state().ext.agents?.list.length??0,runtimeActors:Object.keys(sim.state().ext.robots?.actors??{}).length},snapshotUnchanged:true};
writeFileSync(join(OUT,"report.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({source:report.sourceManifestSha256,finalTick:report.workload.finalTick,finalHash:report.instrumented.finalHash,sampledSimBytes,allocatedBytesPerTick:report.instrumented.allocatedBytesPerTick,budget:report.budget.allocationLimitBytesPerTick,topSelf:report.topSelf.slice(0,12)}));
