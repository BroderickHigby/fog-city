import {describe,expect,it} from "vitest";
import {navigationFromPipeline,type PipelineSidewalks} from "../../../src/sim/agents/pipeline-navigation.ts";
import {shortestSidewalkRoute} from "../../../src/sim/agents/navigation.ts";
const input:PipelineSidewalks={version:1,nodes:[{id:"a",x:0,y:2,z:0},{id:"b",x:20,y:3,z:0},{id:"c",x:20,y:3,z:8}],edges:[{id:"curve",a:"a",b:"b",kind:"sidewalk",points:[[3,1],[16,1]]},{id:"cross",a:"b",b:"c",kind:"crossing",signal:true,marked:true}]};
describe("pipeline sidewalk integration",()=>{
 it("retains source identities and joins trimmed curves to junction endpoints",()=>{const result=navigationFromPipeline(input);const route=shortestSidewalkRoute(result.graph,"a","c")!;expect(route.nodeIds).toEqual(["a","b","c"]);expect(route.lengthM).toBeGreaterThan(28);expect(result.nodeHeights.get("a")).toBe(2);expect(result.crossingSignals.get("cross")).toEqual({signal:true,marked:true});});
 it("restricts navigation to actually loaded tile nodes",()=>{const result=navigationFromPipeline(input,new Set(["a","b"]));expect(result.graph.edges.map(edge=>edge.id)).toEqual(["curve"]);expect(shortestSidewalkRoute(result.graph,"a","c")).toBeNull();});
 it("does not retain or mutate input arrays",()=>{const original=JSON.stringify(input),result=navigationFromPipeline(input);expect(JSON.stringify(input)).toBe(original);expect(result.graph.nodes[0]).not.toBe(input.nodes[0]);expect(()=>navigationFromPipeline({...input,version:99})).toThrow();});
});
