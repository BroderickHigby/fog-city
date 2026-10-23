import { expect,it } from "vitest";
import { createRelay } from "../../../server/net/server.ts";

it("mounts a bounded service before 404 and contains service errors",async()=>{
  const relay=createRelay({loadWorld:async()=>{throw new Error("unused");},automaticTicks:false,handleHttp:async(req,res)=>{
    if(req.url==="/api/ok"){res.writeHead(200);res.end("ok");return true;}
    if(req.url==="/api/fail")throw new Error("private detail");return false;
  }});
  try {
    const port=await relay.listen(0),base=`http://127.0.0.1:${port}`;
    expect(await(await fetch(`${base}/api/ok`)).text()).toBe("ok");
    const failure=await fetch(`${base}/api/fail`);expect(failure.status).toBe(500);expect(await failure.text()).not.toContain("private detail");
    expect((await fetch(`${base}/unhandled`)).status).toBe(404);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  } finally {await relay.close();}
});
