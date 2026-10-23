import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createAiService } from "../../../server/ai/service.ts";
import { createAiHttpHandler } from "../../../server/ai/http.ts";

describe("AI HTTP adapter",()=>{
 it("mounts fixed routes with bounded JSON and ignores forwarded peer identities",async()=>{
  const service=createAiService(),handler=createAiHttpHandler(service);
  const server=createServer((req,res)=>{void handler(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}})});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
   const method=await fetch(origin+"/api/ai/session");expect(method.status).toBe(405);
   const badType=await fetch(origin+"/api/ai/signup",{method:"POST",body:"{}"});expect(badType.status).toBe(415);
   const badJson=await fetch(origin+"/api/ai/signup",{method:"POST",headers:{"content-type":"application/json"},body:"{"});expect(badJson.status).toBe(400);
   const oversized=await fetch(origin+"/api/ai/signup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({invite:"x".repeat(9000)})});expect(oversized.status).toBe(413);
   for(let n=0;n<2;n++){const r=await fetch(origin+"/api/ai/signup",{method:"POST",headers:{"content-type":"application/json","x-forwarded-for":`192.0.2.${n}`},body:JSON.stringify({invite:service.issueInvite(),adult:true,consent:true})});expect(r.status).toBe(201);expect(r.headers.get("cache-control")).toBe("no-store");}
   const limited=await fetch(origin+"/api/ai/signup",{method:"POST",headers:{"content-type":"application/json","x-forwarded-for":"198.51.100.8"},body:JSON.stringify({invite:service.issueInvite(),adult:true,consent:true})});expect(limited.status).toBe(429);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
 });
});
