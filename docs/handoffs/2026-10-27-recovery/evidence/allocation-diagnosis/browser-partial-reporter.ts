import {appendFileSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
export default class PartialMemoryReporter {
 private pending="";
 private out=process.env.SOAK_OUT??new URL("./browser-result",import.meta.url).pathname;
 onStdOut(chunk:string|Buffer){this.pending+=String(chunk);let end:number;while((end=this.pending.indexOf("\n"))>=0){const line=this.pending.slice(0,end).replace(/\u001b\[[0-9;]*m/g,"");this.pending=this.pending.slice(end+1);try{const value=JSON.parse(line.slice(line.indexOf("{")));if(Number.isInteger(value.lap)&&typeof value.stop==="string"){mkdirSync(this.out,{recursive:true});appendFileSync(join(this.out,"partial-route-samples.jsonl"),JSON.stringify(value)+"\n");}}catch{/* Other stdout is not a route sample. */}}}
 onTestEnd(test:any,result:any){mkdirSync(this.out,{recursive:true});writeFileSync(join(this.out,"route-status.json"),JSON.stringify({title:test.title,status:result.status,duration:result.duration,errors:result.errors?.map((e:any)=>e.message)},null,2)+"\n");}
}
