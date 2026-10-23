import { buildSidewalkGraph, type SidewalkGraph } from "./navigation.ts";

/** Existing pipeline sidewalk file; coordinates are already local metres. */
export interface PipelineSidewalks {
  version: number;
  nodes: readonly {id:string;x:number;y:number;z:number}[];
  edges: readonly {id:string;a:string;b:string;kind:"sidewalk"|"crossing";road?:string;points?:readonly (readonly [number,number])[];signal?:boolean;marked?:boolean}[];
}
export interface PipelineNavigation {
  graph: SidewalkGraph;
  nodeHeights: ReadonlyMap<string,number>;
  crossingSignals: ReadonlyMap<string,{signal:boolean;marked:boolean}>;
}

/** Connect authored junction endpoints around each interior curve; retain every source ID. */
export function navigationFromPipeline(data:PipelineSidewalks,loadedNodeIds?:ReadonlySet<string>):PipelineNavigation {
  if(data.version!==1||data.nodes.length>100000||data.edges.length>200000)throw new Error("Invalid pipeline sidewalk version or capacity");
  if(data.nodes.some(node=>!node.id||![node.x,node.y,node.z].every(Number.isFinite))||data.edges.some(edge=>edge.kind!=="sidewalk"&&edge.kind!=="crossing"))throw new Error("Invalid pipeline sidewalk record");
  const nodes=data.nodes.filter(node=>!loadedNodeIds||loadedNodeIds.has(node.id)).map(node=>({...node})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const lookup=new Map(nodes.map(node=>[node.id,node]));
  if(!loadedNodeIds&&data.edges.some(edge=>!lookup.has(edge.a)||!lookup.has(edge.b)))throw new Error("Missing pipeline sidewalk endpoint");
  const crossingSignals=new Map<string,{signal:boolean;marked:boolean}>();
  const edges=data.edges.filter(edge=>lookup.has(edge.a)&&lookup.has(edge.b)).map(edge=>{
    const a=lookup.get(edge.a)!,b=lookup.get(edge.b)!;
    const points:Array<readonly [number,number]>=[[a.x,a.z]];
    for(const point of edge.points??[]){
      if(point.length!==2||!Number.isFinite(point[0])||!Number.isFinite(point[1]))throw new Error("Invalid pipeline sidewalk curve");
      const previous=points[points.length-1]!;
      if(previous[0]!==point[0]||previous[1]!==point[1])points.push([point[0],point[1]]);
    }
    const previous=points[points.length-1]!;
    if(previous[0]!==b.x||previous[1]!==b.z)points.push([b.x,b.z]);
    if(edge.kind==="crossing")crossingSignals.set(edge.id,{signal:edge.signal??false,marked:edge.marked??false});
    return {id:edge.id,a:edge.a,b:edge.b,kind:edge.kind==="crossing"?"crosswalk" as const:"sidewalk" as const,points,roadId:edge.road};
  });
  return {graph:buildSidewalkGraph({nodes,edges}),nodeHeights:new Map(nodes.map(node=>[node.id,node.y])),crossingSignals};
}
