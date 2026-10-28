/** Add observations around the original unmodified route/assertions; no renderer/state overrides. */
import {test,expect} from "@playwright/test";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
const out=process.env.SOAK_OUT??new URL("./browser-result",import.meta.url).pathname;
const report:Record<string,unknown>={kind:"original3lap memory soak under requested1024MiB old-space cap",requestedOldSpaceMiB:1024,sourceIdentity:process.env.FOG_MEMORY_SOURCE_ID??null,collectorSha256:createHash("sha256").update(readFileSync(new URL("../../../tests/render/memory-soak.spec.ts",import.meta.url))).digest("hex"),observations:[],errors:[]};
let capture:Promise<void>|undefined;
function save(){mkdirSync(out,{recursive:true});writeFileSync(join(out,"capacity-metadata.json"),JSON.stringify(report,null,2)+"\n");}
test.beforeEach(async({page,browser})=>{
 report.browserVersion=browser.version();report.target=process.env.FOG_MEMORY_TARGET_URL;save();
 page.on("crash",()=>{(report.errors as unknown[]).push("renderer crashed");save();});
 page.on("domcontentloaded",()=>{
  if(capture)return;
  capture=(async()=>{
   await page.waitForFunction(()=>Boolean((window as any).__fogcity?.ready),null,{timeout:240000});
   const observation=await page.evaluate(()=>{
    const win=window as any,h=win.__fogcity,view=win.__fogcityView,renderer=view?.renderer,device=renderer?.backend?.device;
    const info=h.renderInfo(),resources=h.renderStats?.(),memory=(performance as any).memory;
    let glInfo=null;
    if(info.backend!=="webgpu"&&typeof renderer?.getContext==="function"){
     const gl=renderer.getContext();if(typeof gl?.getParameter==="function"){const extension=gl.getExtension("WEBGL_debug_renderer_info");glInfo={vendor:String(gl.getParameter(extension?.UNMASKED_VENDOR_WEBGL??gl.VENDOR)),renderer:String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL??gl.RENDERER))};}
    }
    const adapter=device?.adapterInfo;
    return {phase:"ready",tick:h.state().tick,hash:h.hash(),sim:h.simInfo(),render:info,resources,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},gcAvailable:typeof win.gc==="function",rendererJsHeapSizeLimitBytes:memory?.jsHeapSizeLimit??null,usedJSHeapBytes:memory?.usedJSHeapSize??null,totalJSHeapBytes:memory?.totalJSHeapSize??null,gpuAdapter:adapter?{vendor:adapter.vendor,architecture:adapter.architecture,device:adapter.device,description:adapter.description}:null,gl:glInfo,userAgent:navigator.userAgent};
   });
   (report.observations as unknown[]).push(observation);save();
  })().catch(error=>{(report.errors as unknown[]).push(String(error));save();});
 });
});
test.afterEach(async({page},info)=>{
 if(capture)await capture;
 report.testStatus=info.status;
 const observation=(report.observations as any[])[0];
 try{const cdp=await page.context().newCDPSession(page);report.finalHeapCategories=await cdp.send("Runtime.getHeapUsage");report.browser=await cdp.send("Browser.getVersion");await cdp.detach();}catch(error){(report.errors as unknown[]).push(`final read: ${String(error)}`);}
 save();
 // Capacity settings must actually take effect; this adds checks without weakening original route growth checks.
 if(observation?.render?.backend==="webgpu")expect(observation.gpuAdapter,"Record actual WebGPU device adapter").not.toBeNull();
 else expect(observation?.gl?.renderer,"Record actual WebGL device/renderer").toBeTruthy();
 expect(observation?.gcAvailable,"Original collector's forcedGC must be available").toBe(true);
 expect(observation?.rendererJsHeapSizeLimitBytes,"Capture actual renderer isolate heap limit").toBeGreaterThan(0);
 expect(observation?.rendererJsHeapSizeLimitBytes,"Requested1024MiB old-space cap must not silently become default/multiGB").toBeLessThanOrEqual(1.2*1024**3);
});
await import("../../../tests/render/memory-soak.spec.ts");
