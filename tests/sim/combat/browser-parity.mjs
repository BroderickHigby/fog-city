import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import * as combat from "../../../src/sim/combat/index.ts";
import * as serializer from "../../../src/sim/serialize.ts";
import { runCombatParity } from "./parity-scenario.ts";

// Standalone browser acceptance: no renderer or mutable game-debug state needed.
const repo=fileURLToPath(new URL("../../../",import.meta.url));
const output=join(repo,"test-results/combat-parity");
const port=Number(process.env.COMBAT_PARITY_PORT??4178);
const node=runCombatParity(combat,serializer);
const required=["weapon.water","scan.result","vehicle.pull-over","balloon.burst","pvp.flower-hit","refill.complete","robot.heap","agi.pause","tensor.loaded"];
for(const kind of required)assert(node.eventCounts[kind]>0,`Scenario must exercise ${kind}`);
assert.equal(node.eventCounts["streak.used"],6);
assert.deepEqual(node.shieldSnapshot,{protectedWetUntil:0,behindRust:0});
await mkdir(output,{recursive:true});
await writeFile(join(output,"node.json"),JSON.stringify(node,null,2));

let server;
let browser;
try {
  server=await createServer({configFile:false,root:repo,appType:"custom",logLevel:"error",
    optimizeDeps:{noDiscovery:true,include:[]},
    server:{host:"127.0.0.1",port,strictPort:true,fs:{allow:[repo]}},
  });
  server.middlewares.use((request,response,next)=>{
    if(request.url!=="/__combat_parity__")return next();
    response.setHeader("Content-Type","text/html; charset=utf-8");
    response.end("<!doctype html><title>Combat parity</title>");
  });
  await server.listen();
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),
    args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"],
  });
  const page=await browser.newPage();
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/__combat_parity__`);
  const result=await page.evaluate(async()=>{
    const runtime=await import("/src/sim/combat/index.ts");
    const serial=await import("/src/sim/serialize.ts");
    const fixture=await import("/tests/sim/combat/parity-scenario.ts");
    return fixture.runCombatParity(runtime,serial);
  });
  await writeFile(join(output,"chromium.json"),JSON.stringify(result,null,2));
  assert.deepEqual(errors,[]);
  assert.deepEqual(result.hashes,node.hashes,"Per-second replay hashes differ");
  assert.equal(result.finalJSON,node.finalJSON,"Final replay state differs");
  assert.deepEqual(result.eventCounts,node.eventCounts);
  const summary={result:"PASS",ticks:node.ticks,checkpoints:node.hashes.length,finalHash:node.finalHash,maxProjectiles:node.maxProjectiles};
  await writeFile(join(output,"summary.json"),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
} finally {
  if(browser)await browser.close();
  if(server)await server.close();
}
