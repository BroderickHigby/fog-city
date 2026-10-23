import { createHmac } from "node:crypto";
import { vibesAwardCandidates, type VibesState } from "../../src/sim/modes/vibes.ts";

/** Key stays on the server; a recorded result, not the key, enters simulation. */
export function chooseVibesAward(state:VibesState,key:Uint8Array):{id:string;matchId:string;requestId:string;winnerId:string;candidates:string[]} {
  if(state.phase!=="award"||key.byteLength<32)throw new Error("Vibes award requires a voting result and a server key");
  const candidates=vibesAwardCandidates(state);
  const rank=(id:string)=>createHmac("sha256",key).update(`vibes-award\0${state.id}\0${id}`).digest("hex");
  const winnerId=[...candidates].sort((a,b)=>{const x=rank(a),y=rank(b);return x<y?-1:x>y?1:a<b?-1:1;})[0]!;
  return {id:state.awardRequestId,matchId:state.id,requestId:state.awardRequestId,winnerId,candidates};
}

/** Roast selection is presentation-only and never consumes the match RNG. */
export function chooseRoastTemplate(roundId:string,playerId:string,count:number,key:Uint8Array):number {
  if(!Number.isSafeInteger(count)||count<1||key.byteLength<32)throw new Error("Invalid roast pool");
  return createHmac("sha256",key).update(`vibes-roast\0${roundId}\0${playerId}`).digest().readUInt32BE(0)%count;
}
