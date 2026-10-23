import type { MapEdge,MapNode,MapPoint } from "./types.ts";

function distance(a:MapPoint,b:MapPoint):number{return Math.hypot(a.x-b.x,a.z-b.z);}
export function nearestNode(nodes:readonly MapNode[],point:MapPoint):MapNode|undefined {
  return [...nodes].filter(node=>Number.isFinite(node.x)&&Number.isFinite(node.z)).sort((a,b)=>distance(a,point)-distance(b,point)||a.id.localeCompare(b.id,"en"))[0];
}

/** Directed Dijkstra path. One-way edges are never silently reversed. */
export function route(nodes:readonly MapNode[],edges:readonly MapEdge[],from:MapPoint,to:MapPoint):readonly MapNode[] {
  const start=nearestNode(nodes,from),goal=nearestNode(nodes,to);if(!start||!goal)return [];
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const costs=new Map<string,number>([[start.id,0]]),previous=new Map<string,string>(),pending=new Set(nodes.map(node=>node.id));
  while(pending.size){
    const id=[...pending].sort((a,b)=>(costs.get(a)??Infinity)-(costs.get(b)??Infinity)||(a<b?-1:a>b?1:0))[0]!;
    pending.delete(id);if(!Number.isFinite(costs.get(id)))break;if(id===goal.id)break;
    const origin=byId.get(id)!;
    for(const edge of edges.filter(edge=>edge.from===id).sort((a,b)=>a.to<b.to?-1:a.to>b.to?1:0)){
      const next=byId.get(edge.to);if(!next||!pending.has(next.id))continue;
      const length=edge.length??distance(origin,next);if(!Number.isFinite(length)||length<0)continue;
      const candidate=costs.get(id)!+length;
      if(candidate<(costs.get(next.id)??Infinity)){costs.set(next.id,candidate);previous.set(next.id,id);}
    }
  }
  if(!costs.has(goal.id))return [];
  const path=[goal];let id=goal.id;
  while(id!==start.id){const prev=previous.get(id);if(!prev)return [];path.push(byId.get(prev)!);id=prev;if(path.length>nodes.length)return [];}
  return path.reverse();
}

export function mapCoordinates(point:MapPoint,center:MapPoint,heading:number,radius:number,size:number):MapPoint {
  const scale=size/(2*Math.max(1,radius)),dx=point.x-center.x,dz=point.z-center.z;
  return {x:size/2+(dx*Math.cos(heading)+dz*Math.sin(heading))*scale,z:size/2+(-dx*Math.sin(heading)+dz*Math.cos(heading))*scale};
}
