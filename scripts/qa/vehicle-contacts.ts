// Prepare a separate packed SF candidate, then serve that directory.
// node --max-old-space-size=2048 scripts/qa/vehicle-contacts.ts --artifact /absolute/build \
//   --url http://127.0.0.1:4371/ --out /absolute/evidence
// One native-Metal browser/page. No teleport, state replacement, fake draw, or production URL.
import { chromium, type Browser, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { DebugHandle } from "../../src/debug.ts";
import type { SceneRenderer } from "../../src/render/scene.ts";
import type { InputFrame, SimInput, SimState } from "../../src/sim/contract.ts";
import type { ImpactsExt } from "../../src/sim/impacts.ts";
import type { AgentState } from "../../src/sim/agents.ts";
import { buildRoadGraph, makePath, pathPoint, projectOnPath, type RoadsFile } from "../../src/sim/roads.ts";
import { followerRoute } from "../../src/sim/vehicles/follower.ts";
import type { World } from "../../src/sim/world.ts";

const {values} = parseArgs({options:{artifact:{type:"string"},url:{type:"string"},out:{type:"string"},world:{type:"string",default:"sf"},"expect-sha":{type:"string",default:"32d9189a84580daacdf676f44250189f248695ea"},help:{type:"boolean"}}});
if(values.help) {
  console.log("node --max-old-space-size=2048 scripts/qa/vehicle-contacts.ts --artifact /absolute/packed-build --url http://127.0.0.1:4371/ --out /absolute/evidence [--world sf] [--expect-sha SHA]\nRequires a frozen SIM18 packed candidate, its own server, and the sole QA browser slot. Defaults to SF and source32d9189a; only the QA harness may be dirty. Never starts a server or changes preview5173.");
  process.exit(0);
}
function assert(value:unknown,message:string):asserts value { if(!value)throw new Error(message); }
assert(values.artifact&&values.url&&values.out,"--artifact, --url and --out are required; see --help");
assert(getHeapStatistics().heap_size_limit<=3_000_000_000,"Run Node with --max-old-space-size=2048");
const artifact=resolve(values.artifact),out=resolve(values.out),base=new URL(values.url),world=values.world,root=fileURLToPath(new URL("../../",import.meta.url));
assert(/^[a-z0-9-]+$/.test(world),"Invalid world name");
assert(["127.0.0.1","localhost","[::1]"].includes(base.hostname),"QA must target a local candidate server");
assert(base.port!=="5173","Preserve the user's stable preview on port5173; serve the candidate separately");
const url=new URL(base);
for(const [key,value] of Object.entries({world,renderer:"webgl",gfx:"low",quality:"0",shadows:"0",pr:"0.75",radius:"200",debug:"1",capture:"1",cam:"chase",tod:"golden"}))url.searchParams.set(key,value);
const sha=(data:string|Uint8Array)=>createHash("sha256").update(data).digest("hex");
const git=(...args:string[])=>execFileSync("git",args,{cwd:root,encoding:"utf8"}).trim();
const source=()=>({revision:git("rev-parse","HEAD"),status:git("status","--porcelain"),vehicleSourceSHA256:sha(["src/render/actors.ts","src/sim/contract.ts","src/sim/impacts.ts","src/sim/agents.ts","src/sim/step.ts","src/sim/vehicle-contacts.ts"].map(file=>file+"\0"+readFileSync(join(root,file),"utf8")).join("\0"))});
assert(git("rev-parse","HEAD").startsWith(values["expect-sha"]),"Source head differs from --expect-sha");
assert(!git("diff","--name-only","HEAD","--","src","content","public","schemas"),"Game source/data changed after the frozen candidate head");
const html=readFileSync(join(artifact,"index.html"),"utf8");
const scripts=[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(match=>match[1]!);
assert(scripts.length>0,"Candidate index has no built JavaScript");
const index=JSON.parse(readFileSync(join(artifact,"assets.index.json"),"utf8")) as {worlds?:string[]};
assert(index.worlds?.includes(world),`Candidate must be packed with --worlds ${world}`);
const candidate=await Promise.all(["index.html","assets.index.json",`tiles/${world}/manifest.json`,`tiles/${world}/roads.json`,...scripts].map(async file=>{
  const local=readFileSync(resolve(artifact,file.replace(/^\.\//,""))),served=await fetch(new URL(file,base),{signal:AbortSignal.timeout(20_000)});
  assert(served.ok,`Candidate HTTP ${served.status}: ${file}`);
  const remote=new Uint8Array(await served.arrayBuffer());
  assert(sha(local)===sha(remote),`Served ${file} differs from the supplied packed candidate`);
  return {file,bytes:local.length,sha256:sha(local)};
}));
// Routing only: a bounded neighbourhood of the candidate's real streets, without loading
// another collision/terrain world. This planner emits controls; the browser remains authoritative.
const manifest=JSON.parse(readFileSync(join(artifact,`tiles/${world}/manifest.json`),"utf8")) as {spawn:{x:number;z:number}};
const roadsFile=JSON.parse(readFileSync(join(artifact,`tiles/${world}/roads.json`),"utf8")) as RoadsFile;
const localEdges=roadsFile.edges.filter(edge=>edge.points.some(point=>Math.hypot(point[0]!-manifest.spawn.x,point[1]!-manifest.spawn.z)<1000));
const localNodes=new Set(localEdges.flatMap(edge=>[edge.a,edge.b]));
const routingWorld={roads:buildRoadGraph({...roadsFile,edges:localEdges,nodes:roadsFile.nodes.filter(node=>localNodes.has(node.id))})} as World;
mkdirSync(out,{recursive:true});
const report={startedAt:new Date().toISOString(),url:url.href,artifact,candidate,sourceStart:source(),sourceEnd:null as ReturnType<typeof source>|null,
  scope:`Native Metal packed-candidate vehicle mechanics; ${world} seed1; ordinary recorded controls with real-road routing and bounded retargeting; actual rendered vertex hulls. Screenshots require visual inspection. No FPS acceptance.`,
  viewport:{width:640,height:400},browserHeapMB:1024,deadlineMinutes:6,stateReplacementCalls:0,teleports:0,spawnOverrides:0,
  errors:[] as string[],warnings:[] as string[],frames:[] as unknown[],replayContactFrames:[] as unknown[],shots:[] as string[],checks:[] as string[],initial:null as unknown,gpu:null as unknown,replay:null as unknown,
  collision:null as {targetId:number;hitTick:number;aftermathFrames:number;aftermathTargetIds:number[]}|null,passed:false,failure:null as string|null};
const flush=()=>writeFileSync(join(out,"proof.json"),JSON.stringify(report,null,2)+"\n");
let browser:Browser|undefined,page:Page|undefined;
let rejectFatal!:(reason:Error)=>void;
const fatal=new Promise<never>((_,reject)=>{rejectFatal=reject;});void fatal.catch(()=>{});
const checked=<T>(promise:Promise<T>)=>Promise.race([promise,fatal]);
const fail=(message:string)=>{if(report.errors.length<25)report.errors.push(message);rejectFatal(new Error(message));};
const deadline=setTimeout(()=>fail("Vehicle QA exceeded its six-minute bound"),6*60_000);
type QAWindow=Window&{__fogcity:DebugHandle;__fogcityView:SceneRenderer};
type DrawnPart={part:{mesh:import("three").InstancedMesh};pivot:import("three").Vector3;channel:{type:string}};
type ObservedAgentLayer={kinds:Map<string,{source:string;near:DrawnPart[]}>;civilianNear:{mesh:import("three").InstancedMesh}|null;lastCurr?:SimState;pairs:Array<[unknown,AgentState]>;poses:Array<{x:number;y:number;z:number}>;tiers:Uint8Array;frameNo:number;hiddenAgent:number|null};
async function renderFrames(n=2):Promise<void> {
  await checked(page!.evaluate(n=>new Promise<void>((done,reject)=>{
    const timer=setTimeout(()=>reject(new Error("No normal rendered frame within30s")),30_000);
    const frame=()=>{if(--n<=0){clearTimeout(timer);done();}else requestAnimationFrame(frame);};requestAnimationFrame(frame);
  }),n));
}
async function boot():Promise<void> {
  await checked(page!.goto(url.href,{waitUntil:"domcontentloaded",timeout:30_000}));
  await checked(page!.waitForFunction(()=>(window as unknown as QAWindow).__fogcity?.ready,null,{timeout:60_000}));
  await checked(page!.evaluate(()=>(window as unknown as QAWindow).__fogcity.pause()));
  await renderFrames();
  await checked(page!.waitForFunction(()=>{
    const h=(window as unknown as QAWindow).__fogcity,r=h.renderInfo();
    return r.playerCarsFromFile===1&&r.agentModels.includes("robotaxi")&&r.drawCalls>0;
  },null,{timeout:30_000}));
  const initial=await checked(page!.evaluate(()=>{
    const w=window as unknown as QAWindow,h=w.__fogcity,before=h.hash(),s=h.state(),r=h.renderInfo();
    const gl=w.__fogcityView.renderer.getContext() as WebGL2RenderingContext,e=gl.getExtension("WEBGL_debug_renderer_info");
    const result={tick:s.tick,seed:s.seed,version:s.version,hash:before,sim:h.simInfo(),render:r,gpu:{renderer:String(gl.getParameter(e?.UNMASKED_RENDERER_WEBGL??gl.RENDERER)),error:gl.getError()}};
    if(h.hash()!==before)throw new Error("Read-only boot inspection mutated simulation");return result;
  }));
  assert(initial.tick===0&&initial.seed===1&&initial.version===18,"Expected fresh paused seed1/SIM18 candidate");
  assert(initial.sim.assets==="packed"&&initial.render.backend==="webgl-node","Expected packed candidate on actual node-WebGL backend");
  assert(/Apple|Metal/i.test(initial.gpu.renderer)&&!/SwiftShader|Software|llvmpipe/i.test(initial.gpu.renderer),"Actual renderer is not native Apple/Metal");
  assert(initial.gpu.error===0&&!initial.render.graphicsError,"GPU reported an error at boot");
  report.initial??=initial;report.gpu=initial.gpu;flush();
}

/** A camera still easing after an eight-tick input batch may legitimately leave a taxi in mid LOD. */
async function warmTarget(targetId:number):Promise<void> {
  await renderFrames(2);
  try {
    await checked(page!.waitForFunction(targetId=>{
      const w=window as unknown as QAWindow,h=w.__fogcity,layer=w.__fogcityView.agents as unknown as ObservedAgentLayer;
      const index=layer.pairs.findIndex(pair=>pair[1].id===targetId),view=layer.kinds.get("robotaxi");
      const target=index<0?null:layer.pairs[index]![1],civilian=target?.kind==="robotaxi"&&target.runtimeId===undefined&&target.vehicle===undefined&&target.id%8===7;
      const drawn=civilian?layer.civilianNear?.mesh.visible&&layer.civilianNear.mesh.count>0
        :view?.source==="file"&&view.near.some(p=>p.channel.type==="none"&&p.part.mesh.visible&&p.part.mesh.count>0);
      return layer.lastCurr?.tick===h.state().tick&&index>=0&&layer.tiers[index]===3&&drawn;
    },targetId,{timeout:15_000,polling:"raf"}));
  }catch(error){
    const diagnostic=await page!.evaluate(targetId=>{
      const w=window as unknown as QAWindow,h=w.__fogcity,v=w.__fogcityView,s=h.state(),layer=v.agents as unknown as ObservedAgentLayer;
      const index=layer.pairs.findIndex(pair=>pair[1].id===targetId),view=layer.kinds.get("robotaxi");
      return {targetId,target:s.ext.agents!.list.find(a=>a.id===targetId),tick:s.tick,renderedTick:layer.lastCurr?.tick,tier:index<0?null:layer.tiers[index],camera:v.camera.position.toArray(),render:h.renderInfo(),modelSource:view?.source,civilianNear:layer.civilianNear?{name:layer.civilianNear.mesh.name,count:layer.civilianNear.mesh.count,visible:layer.civilianNear.mesh.visible}:null,parts:view?.near.map(p=>({name:p.part.mesh.name,count:p.part.mesh.count,visible:p.part.mesh.visible,pivot:p.pivot.toArray(),channel:p.channel.type}))};
    },targetId);
    report.frames.push({warmTargetFailure:diagnostic});flush();throw new Error(`Selected taxi did not become an actual near GLB draw after bounded normal frames: ${JSON.stringify(diagnostic)}`,{cause:error});
  }
}

/** Inspect the real draw's vertices; derive constructors from scene values, no extra Three instance. */
async function drawnHull(targetId:number):Promise<{tick:number;hash:string;player:{local:{min:number[];max:number[]};hull:number[][];scale:number[]};taxiHull:number[][];identity:{targetId:number};render:unknown}> {
  return checked(page!.evaluate(targetId=>{
    const w=window as unknown as QAWindow,h=w.__fogcity,v=w.__fogcityView,before=h.hash(),s=h.state();
    const car=v.actors.group.children.find(child=>!!child.getObjectByName("civilian_car"));
    if(!car)throw new Error("Actual personal civilian GLB instance is absent");
    car.updateWorldMatrix(true,true);
    const point=car.position.clone(),instance=car.matrix.clone(),inverse=car.matrix.clone().makeRotationFromQuaternion(car.quaternion).setPosition(car.position).invert();
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],player:number[][]=[],taxi:number[][]=[];
    car.traverse(node=>{
      const mesh=node as import("three").Mesh;if(!mesh.isMesh)return;
      for(let i=0;i<mesh.geometry.getAttribute("position").count;i++){
        mesh.getVertexPosition(i,point).applyMatrix4(mesh.matrixWorld);player.push([point.x,point.z]);point.applyMatrix4(inverse);
        for(let k=0;k<3;k++){min[k]=Math.min(min[k]!,point.getComponent(k));max[k]=Math.max(max[k]!,point.getComponent(k));}
      }
    });
    const target=s.ext.agents!.list.find(a=>a.id===targetId);if(!target)throw new Error("Selected actual taxi vanished");
    const layer=v.agents as unknown as ObservedAgentLayer,view=layer.kinds.get("robotaxi");
    const isCivilian=(a:AgentState)=>a.kind==="robotaxi"&&a.runtimeId===undefined&&a.vehicle===undefined&&a.id%8===7;
    const civilian=isCivilian(target),parts:DrawnPart[]=civilian&&layer.civilianNear
      ?[{part:layer.civilianNear,pivot:car.position.clone().set(0,0,0),channel:{type:"shader-wheel"}}]:view?.near??[];
    const body=civilian?layer.civilianNear?.mesh:parts.find(p=>p.channel.type==="none"&&p.pivot.lengthSq()===0)?.part.mesh;
    const modelSource=civilian&&layer.civilianNear?"file:civilian-car":view?.source;
    if((civilian?!layer.civilianNear:view?.source!=="file")||!body?.visible||body.count===0)throw new Error("Target vehicle is not drawn by its live model's near GLB roster");
    // Both draw rosters append in pair order, but civilians use their own merged PartMesh.
    // Identity must follow that exact roster; the taxi roster cannot identify a civilian.
    const ordered=layer.pairs.flatMap((pair,i)=>{
      const b=pair[1];
      return layer.tiers[i]===3&&b.kind==="robotaxi"&&isCivilian(b)===civilian&&b.id!==layer.hiddenAgent?[{id:b.id,pose:layer.poses[i]}]:[];
    });
    const index=ordered.findIndex(entry=>entry.id===targetId);
    const origins=Array.from({length:body.count},(_,i)=>{body.getMatrixAt(i,instance);point.setFromMatrixPosition(instance);return {index:i,id:ordered[i]?.id,origin:point.toArray(),pose:ordered[i]?.pose};});
    const origin=origins[index]?.origin,distance=origin?Math.hypot(origin[0]!-target.x,origin[2]!-target.z):Infinity;
    if(index<0||body.count!==ordered.length||distance>1)throw new Error("Cannot identify target GLB draw slot: "+JSON.stringify({targetId,target,index,distance,bodyCount:body.count,orderedCount:ordered.length,origins,parts:parts.map(p=>({name:p.part.mesh.name,count:p.part.mesh.count,visible:p.part.mesh.visible,pivot:p.pivot.toArray()}))}));
    for(const part of parts){
      const mesh=part.part.mesh;
      if(!mesh.visible||mesh.count<=index)continue;
      mesh.updateWorldMatrix(true,false);mesh.getMatrixAt(index,instance);const position=mesh.geometry.getAttribute("position");
      const wheel=mesh.geometry.getAttribute("fcWheel"),motion=mesh.geometry.getAttribute("fcCarMotion");
      if(civilian&&(!wheel||!motion))throw new Error("Actual civilian draw is missing its wheel shader attributes");
      const spin=civilian?motion!.getX(index):0,steer=civilian?motion!.getY(index):0;
      for(let i=0;i<position.count;i++){
        point.fromBufferAttribute(position,i);
        if(civilian&&wheel!.getW(i)>.5){
          const px=wheel!.getX(i),py=wheel!.getY(i),pz=wheel!.getZ(i);
          point.x-=px;point.y-=py;point.z-=pz;
          // createGpuPackedMaterial's node setup deforms the actual merged GLB vertices
          // before framework instancing, on both WebGPU and the verified node-WebGL backend.
          const y=point.y*Math.cos(spin)+point.z*Math.sin(spin);
          point.z=point.z*Math.cos(spin)-point.y*Math.sin(spin);point.y=y;
          if(wheel!.getW(i)>1.5){const x=point.x*Math.cos(steer)+point.z*Math.sin(steer);point.z=point.z*Math.cos(steer)-point.x*Math.sin(steer);point.x=x;}
          point.x+=px;point.y+=py;point.z+=pz;
        }
        point.applyMatrix4(instance).applyMatrix4(mesh.matrixWorld);taxi.push([point.x,point.z]);
      }
    }
    // The monotone hull removes internal geometry before the independent SAT test in Node.
    const hull=(points:number[][])=>{
      const sorted=points.sort((a,b)=>a[0]!-b[0]!||a[1]!-b[1]!).filter((p,i,a)=>!i||p[0]!==a[i-1]![0]||p[1]!==a[i-1]![1]);
      const cross=(a:number[],b:number[],c:number[])=>(b[0]!-a[0]!)*(c[1]!-a[1]!)-(b[1]!-a[1]!)*(c[0]!-a[0]!);
      const half=(points:number[][])=>{const result:number[][]=[];for(const p of points){while(result.length>1&&cross(result.at(-2)!,result.at(-1)!,p)<=0)result.pop();result.push(p);}return result;};
      const lower=half(sorted),upper=half([...sorted].reverse());return [...lower.slice(0,-1),...upper.slice(0,-1)];
    };
    const pairIndex=layer.pairs.findIndex(pair=>pair[1].id===targetId);
    const result={tick:s.tick,hash:before,player:{local:{min,max},hull:hull(player),scale:car.scale.toArray()},taxiHull:hull(taxi),identity:{targetId,index,distance,modelSource,civilian,shaderDeformation:civilian?"node-fcWheel-fcCarMotion-before-instance":"part-instance-matrices",tier:layer.tiers[pairIndex],renderedTick:layer.lastCurr?.tick,frameNo:layer.frameNo,camera:v.camera.position.toArray(),parts:parts.map(p=>({name:p.part.mesh.name,count:p.part.mesh.count,visible:p.part.mesh.visible}))},render:h.renderInfo()};
    if(h.hash()!==before)throw new Error("Draw-geometry inspection mutated simulation");return result;
  },targetId));
}
function penetration(a:number[][],b:number[][]):number {
  assert(a.length>=3&&b.length>=3,"Missing actual vertex hull");let depth=Infinity;
  for(const polygon of [a,b])for(let i=0;i<polygon.length;i++){
    const p=polygon[i]!,q=polygon[(i+1)%polygon.length]!,dx=q[0]!-p[0]!,dz=q[1]!-p[1]!,length=Math.hypot(dx,dz);
    if(length<1e-9)continue;const axis=[-dz/length,dx/length];
    const project=(points:number[][])=>points.map(p=>p[0]!*axis[0]!+p[1]!*axis[1]!);
    const ap=project(a),bp=project(b),overlap=Math.min(Math.max(...ap),Math.max(...bp))-Math.max(Math.min(...ap),Math.min(...bp));
    if(overlap<=0)return 0;depth=Math.min(depth,overlap);
  }return depth;
}

try {
  browser=await checked(chromium.launch({headless:true,timeout:25_000,args:["--use-gl=angle","--use-angle=metal","--js-flags=--max-old-space-size=1024","--disable-background-timer-throttling","--disable-renderer-backgrounding"]}));
  page=await checked(browser.newPage({viewport:report.viewport,deviceScaleFactor:1}));page.setDefaultTimeout(25_000);
  page.on("pageerror",error=>fail(error.message));page.on("crash",()=>fail("Browser renderer crashed"));
  page.on("console",message=>{if(message.type()==="error")fail(message.text());else if(message.type()==="warning"&&report.warnings.length<20)report.warnings.push(message.text());});
  page.on("response",response=>{if(response.status()>=400)fail(`HTTP ${response.status()}: ${response.url()}`);});
  await boot();report.checks.push("Served bundle/index match the supplied packed candidate; actual Apple/Metal node-WebGL; SIM18/seed1");
  const inputs:InputFrame[]=[],trace:unknown[]=[],aftermathTargetIds:number[]=[];
  let target=-1,hitTick=-1,collisionTarget=-1,stuckSince=-1,reverseUntil=-1,afterFrames=0,lastProgressTick=0,bestDistance=Infinity;
  const avoid:number[]=[];
  let route:{target:number;x:number;z:number;points:[number,number][]}|null=null;
  const driveStarted=Date.now();
  while(inputs.length<9000&&Date.now()-driveStarted<150_000){
    const sample=await checked(page.evaluate(({target,hitTick,stuckSince,reverseUntil,avoid})=>{
      const h=(window as unknown as QAWindow).__fogcity,s=h.state(),car=s.players.p1!.car;
      const vehicles=s.ext.agents!.list.filter(a=>a.kind==="robotaxi");
      const taxis=vehicles.filter(a=>a.runtimeId===undefined&&!(a.vehicle===undefined&&a.id%8===7)&&!avoid.includes(a.id));
      // Pursuit may prefer a taxi; once any genuine road vehicle is hit, follow exactly that
      // body's aftermath. Reapplying the pursuit roster would silently replace civilian7.
      const taxi=hitTick>=0?vehicles.find(a=>a.id===target)
        :taxis.find(a=>a.id===target)??taxis.sort((a,b)=>Math.hypot(a.x-car.x,a.z-car.z)-Math.hypot(b.x-car.x,b.z-car.z))[0];
      if(!taxi)throw new Error(hitTick>=0?"The actual collided vehicle vanished during its aftermath":"No eligible ordinary ambient taxi in the selected world");
      let error=Math.atan2(taxi.x-car.x,-(taxi.z-car.z))-car.heading;while(error>Math.PI)error-=2*Math.PI;while(error< -Math.PI)error+=2*Math.PI;
      if(Math.abs(car.speed)>.5)stuckSince=-1;else if(stuckSince<0)stuckSince=s.tick;else if(s.tick-stuckSince>90){reverseUntil=s.tick+90;stuckSince=-1;}
      const distance=Math.hypot(taxi.x-car.x,taxi.z-car.z),desired=Math.abs(error)>.5?4:Math.min(14,Math.max(8,distance*.6));
      const reverse=s.tick<reverseUntil,input:SimInput={throttle:reverse?-1:car.speed>desired+.5?0:1,steer:Math.abs(error)<.06?0:Math.sign(error)*(reverse?-1:1),brake:!reverse&&car.speed>desired+.5?1:0,actions:0};
      const hit=(s.ext.impacts as ImpactsExt|undefined)?.events.find(e=>(e.kind==="car-taxi"||e.kind==="taxi-car")&&[e.a,e.b].includes("p:p1"));
      return {tick:s.tick,target:taxi.id,car,taxi,distance,input,hit,stuckSince,reverseUntil};
    },{target,hitTick,stuckSince,reverseUntil,avoid}));
    if(target!==sample.target){lastProgressTick=sample.tick;bestDistance=Infinity;route=null;}
    target=sample.target;stuckSince=sample.stuckSince;reverseUntil=sample.reverseUntil;
    if(sample.hit&&hitTick<0){hitTick=sample.hit.tick;target=Number((sample.hit.a.startsWith("a:")?sample.hit.a:sample.hit.b).slice(2));collisionTarget=target;}
    if(hitTick>=0)assert(target===collisionTarget,"Aftermath target changed away from the actual collided vehicle");
    if(sample.distance<bestDistance-2){bestDistance=sample.distance;lastProgressTick=sample.tick;}
    if(hitTick<0&&sample.tick-lastProgressTick>360){avoid.push(target);if(avoid.length>3)avoid.shift();target=-1;route=null;bestDistance=Infinity;lastProgressTick=sample.tick;continue;}
    let driving=sample.input;
    if(hitTick<0&&sample.distance>=13){
      if(!route||route.target!==target||Math.hypot(sample.taxi.x-route.x,sample.taxi.z-route.z)>12){
        route={target,x:sample.taxi.x,z:sample.taxi.z,points:followerRoute(routingWorld,sample.car,sample.taxi)};
      }
      if(route.points.length>1){
        const path=makePath(route.points.map(point=>point[0]),route.points.map(point=>point[1]));
        const projection=projectOnPath(path,sample.car.x,sample.car.z),goal=pathPoint(path,projection.s+4+Math.abs(sample.car.speed)*.5);
        let error=Math.atan2(goal.x-sample.car.x,-(goal.z-sample.car.z))-sample.car.heading;while(error>Math.PI)error-=2*Math.PI;while(error< -Math.PI)error+=2*Math.PI;
        const reverse=sample.tick<reverseUntil,desired=Math.min(15,15/(1+Math.abs(error)*1.4));
        driving={throttle:reverse?-0.7:sample.car.speed<desired?1:0,steer:Math.max(-1,Math.min(1,error*1.8))*(reverse?-1:1),brake:!reverse&&sample.car.speed>desired+.5?1:0,actions:0};
      }else {avoid.push(target);if(avoid.length>3)avoid.shift();target=-1;continue;}
    }
    const near=sample.distance<13||hitTick>=0,count=near?1:8,input=hitTick<0?driving:{throttle:0,steer:0,brake:1,actions:0};
    const frames=Array.from({length:count},()=>({p1:input}));inputs.push(...frames);
    await checked(page.evaluate(frames=>(window as unknown as QAWindow).__fogcity.stepFrames(frames),frames));await renderFrames(1);
    if(near){
      await warmTarget(target);
      const hull=await drawnHull(target),overlap=penetration(hull.player.hull,hull.taxiHull);
      assert(hull.player.local.min[0]!>=-.950001&&hull.player.local.max[0]!<=.950001&&hull.player.local.min[2]!>=-2.200001&&hull.player.local.max[2]!<=2.200001,"Actual personal car exceeds its physical footprint");
      assert(overlap<=.03,`Actual drawn vehicle hulls overlap ${overlap.toFixed(4)}m at tick${hull.tick}`);
      trace.push({...sample,input,drawnTick:hull.tick,renderedPenetrationM:overlap});
      report.frames.push({tick:hull.tick,hash:hull.hash,target,player:hull.player,taxiHull:hull.taxiHull,identity:hull.identity,renderedPenetrationM:overlap,hit:sample.hit??null});
      if(report.shots.length===0){await checked(page.screenshot({path:join(out,"approach.png"),timeout:20_000}));report.shots.push("approach.png");}
      if(hitTick>=0){
        aftermathTargetIds.push(hull.identity.targetId);afterFrames++;
        report.collision={targetId:collisionTarget,hitTick,aftermathFrames:afterFrames,aftermathTargetIds:[...aftermathTargetIds]};
        if([1,2,4,8,16,32,48].includes(afterFrames)){const file=`contact-${String(afterFrames).padStart(2,"0")}.png`;await checked(page.screenshot({path:join(out,file),timeout:20_000}));report.shots.push(file);}
        if(afterFrames>=48)break;
      }
    }
    if(inputs.length%120<8)flush();
  }
  assert(hitTick>=0&&afterFrames>=48,"Ordinary recorded driving did not produce and follow a car/taxi collision inside the bound");
  assert(aftermathTargetIds.length===48&&aftermathTargetIds.every(id=>id===collisionTarget),"All48 aftermath frames must identify the same actual collided vehicle draw");
  const final=await checked(page.evaluate(()=>({hash:(window as unknown as QAWindow).__fogcity.hash(),tick:(window as unknown as QAWindow).__fogcity.state().tick})));
  writeFileSync(join(out,"controls.json"),JSON.stringify({world,seed:1,version:18,initial:report.initial,frames:inputs,trace,expectedFinalHash:final.hash})+"\n");
  report.checks.push(`Actual personal GLB fits CAR; no drawn hull penetration over3cm across ${report.frames.length} contact-approach/aftermath frames; hit tick${hitTick}, all48 aftermath draws identify collided vehicle${collisionTarget}`);flush();
  // Same browser/page, same untouched packed build: replay only those recorded ordinary inputs.
  // The original drive batches distant input eight ticks at a time. Measure its collision
  // window one tick at a time on replay so an impact inside such a batch cannot go unseen.
  await boot();
  const replayWindowStart=Math.max(1,hitTick-5),replayTicks:number[]=[],replayTargetIds:number[]=[];
  let replayMaxPenetrationM=0,exactHitShot:string|null=null;
  for(let i=0;i<inputs.length;i++){
    await checked(page.evaluate(frame=>(window as unknown as QAWindow).__fogcity.stepFrames([frame]),inputs[i]!));
    const tick=i+1;
    if(tick<replayWindowStart){if(tick%64===0)await renderFrames(1);continue;}
    await renderFrames(1);await warmTarget(collisionTarget);
    const drawn=await drawnHull(collisionTarget),overlap=penetration(drawn.player.hull,drawn.taxiHull);
    assert(drawn.tick===tick,"Replay draw does not represent the expected single input tick");
    assert(drawn.identity.targetId===collisionTarget,"Replay collision draw changed away from the actual collided vehicle");
    assert(drawn.player.local.min[0]!>=-.950001&&drawn.player.local.max[0]!<=.950001&&drawn.player.local.min[2]!>=-2.200001&&drawn.player.local.max[2]!<=2.200001,"Actual replay personal car exceeds its physical footprint");
    assert(overlap<=.03,`Actual replay vehicle hulls overlap ${overlap.toFixed(4)}m at collision-window tick${drawn.tick}`);
    replayTicks.push(drawn.tick);replayTargetIds.push(drawn.identity.targetId);replayMaxPenetrationM=Math.max(replayMaxPenetrationM,overlap);
    report.replayContactFrames.push({tick:drawn.tick,hash:drawn.hash,target:collisionTarget,player:drawn.player,taxiHull:drawn.taxiHull,identity:drawn.identity,renderedPenetrationM:overlap});
    if(tick===hitTick){exactHitShot=`exact-hit-${hitTick}.png`;await checked(page.screenshot({path:join(out,exactHitShot),timeout:20_000}));report.shots.push(exactHitShot);}
    if(tick%16===0)flush();
  }
  const replayHash=await checked(page.evaluate(()=>(window as unknown as QAWindow).__fogcity.hash()));
  assert(replayHash===final.hash,"Fresh-page replay of the recorded controls diverged");
  assert(replayTicks.length===final.tick-replayWindowStart+1&&replayTicks.every((tick,i)=>tick===replayWindowStart+i),"Replay must inspect every collision-window tick through the final recorded frame");
  assert(replayTargetIds.every(id=>id===collisionTarget)&&exactHitShot!==null,"Replay must retain the collided vehicle identity and capture the exact impact tick");
  report.replay={frames:inputs.length,hash:replayHash,hitTick,collisionTarget,collisionWindow:{startTick:replayWindowStart,endTick:final.tick,frames:replayTicks.length,targetIds:replayTargetIds,maxRenderedPenetrationM:replayMaxPenetrationM,exactHitShot}};
  report.checks.push(`Fresh-page ordinary-input replay reproduced the exact final simulation hash; actual collided draw${collisionTarget} stays within3cm at every tick${replayWindowStart}..${final.tick}, with exact impact tick${hitTick} captured`);
  report.sourceEnd=source();assert(report.sourceEnd.vehicleSourceSHA256===report.sourceStart.vehicleSourceSHA256,"Vehicle source changed during QA");
  report.passed=report.errors.length===0;
}catch(error){report.failure=String(error instanceof Error?error.stack:error);process.exitCode=1;}
finally {
  clearTimeout(deadline);await browser?.close().catch(()=>{});flush();
  writeFileSync(join(out,"index.html"),`<!doctype html><meta charset="utf-8"><title>Fog City vehicle contacts</title><style>body{font:15px system-ui;margin:24px;background:#182026;color:#eee}main{display:flex;flex-wrap:wrap;gap:12px}img{width:480px;max-width:100%}a{color:#aee}pre{white-space:pre-wrap}</style><h1>Vehicle contacts — ${report.passed?"passed":"failed"}</h1><p>${report.scope}</p><p><a href="proof.json">Proof</a> · <a href="controls.json">Recorded inputs</a></p><main>${report.shots.map(file=>`<a href="${file}"><img src="${file}" alt="${file}"></a>`).join("")}</main><pre>${report.failure??report.checks.join("\n")}</pre>`);
  console.log(JSON.stringify({passed:report.passed,out,failure:report.failure,shots:report.shots,frames:report.frames.length}));
}
