import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAiService } from "./service.ts";

/** Mount before the relay's 404. Peer identity always comes from the socket, not forwarded headers. */
export function createAiHttpHandler(service: ReturnType<typeof createAiService>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path=request.url?.split("?")[0] ?? "";
    if(!path.startsWith("/api/ai/")) return false;
    const send=(status:number,body:unknown):void=>{response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});response.end(JSON.stringify(body));};
    if(request.method!=="POST"){send(405,{error:"method_not_allowed"});return true;}
    if(request.headers["content-type"]?.split(";")[0]?.trim()!=="application/json"){send(415,{error:"json_required"});return true;}
    const chunks:Buffer[]=[];let length=0;
    try {
      for await (const chunk of request) {
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);length+=bytes.length;
        if(length>8192){send(413,{error:"body_too_large"});request.resume();return true;}
        chunks.push(bytes);
      }
      let body:unknown;
      try {body=JSON.parse(Buffer.concat(chunks).toString("utf8"));} catch {send(400,{error:"invalid_json"});return true;}
      const result=await service.handle({method:request.method,path,body,ip:request.socket.remoteAddress??"",...(request.headers.authorization?{authorization:request.headers.authorization}:{})});
      send(result.status,result.body);return true;
    } catch {if(!response.headersSent)send(400,{error:"request_failed"});return true;}
  };
}
