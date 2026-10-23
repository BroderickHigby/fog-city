import type { MapEdge,MapNode,MapPoint } from "./types.ts";

function distance(a:MapPoint,b:MapPoint):number{return Math.hypot(a.x-b.x,a.z-b.z);}
export function nearestNode(nodes:readonly MapNode[],point:MapPoint):MapNode|undefined {
  let best:MapNode|undefined,bestDistance=Infinity;
  for(const node of nodes){const d=distance(node,point);if(Number.isFinite(d)&&(d<bestDistance||d===bestDistance&&node.id<(best?.id??""))){best=node;bestDistance=d;}}
  return best;
}

const graphs=new WeakMap<readonly MapEdge[],{nodes:readonly MapNode[];byId:Map<string,MapNode>;edges:Map<string,MapEdge[]>;paths:Map<string,readonly MapNode[]>}>();

/** Directed Dijkstra path. One-way edges are never silently reversed. */
export function route(nodes:readonly MapNode[],edges:readonly MapEdge[],from:MapPoint,to:MapPoint):readonly MapNode[] {
  const start=nearestNode(nodes,from),goal=nearestNode(nodes,to);if(!start||!goal)return [];
  let graph=graphs.get(edges);if(!graph||graph.nodes!==nodes){
    const outgoing=new Map<string,MapEdge[]>();for(const edge of edges){const list=outgoing.get(edge.from)??[];list.push(edge);outgoing.set(edge.from,list);}for(const list of outgoing.values())list.sort((a,b)=>a.to<b.to?-1:a.to>b.to?1:0);
    graph={nodes,byId:new Map(nodes.map(node=>[node.id,node])),edges:outgoing,paths:new Map()};graphs.set(edges,graph);
  }
  const key=`${start.id}\0${goal.id}`,cached=graph.paths.get(key);if(cached)return cached;
  const byId=graph.byId,costs=new Map<string,number>([[start.id,0]]),previous=new Map<string,string>(),visited=new Set<string>();
  type Item={id:string;cost:number};const heap:Item[]=[];
  const less=(a:Item,b:Item)=>a.cost<b.cost||a.cost===b.cost&&a.id<b.id;
  const push=(item:Item)=>{heap.push(item);let i=heap.length-1;while(i>0){const p=(i-1)>>1;if(!less(heap[i]!,heap[p]!))break;[heap[i],heap[p]]=[heap[p]!,heap[i]!];i=p;}};
  const pop=():Item=>{const item=heap[0]!,tail=heap.pop()!;if(heap.length){heap[0]=tail;let i=0;for(;;){const l=i*2+1,r=l+1;let best=i;if(l<heap.length&&less(heap[l]!,heap[best]!))best=l;if(r<heap.length&&less(heap[r]!,heap[best]!))best=r;if(best===i)break;[heap[i],heap[best]]=[heap[best]!,heap[i]!];i=best;}}return item;};
  push({id:start.id,cost:0});
  while(heap.length){
    const item=pop(),id=item.id;if(visited.has(id))continue;visited.add(id);if(id===goal.id)break;
    const origin=byId.get(id)!;
    for(const edge of graph.edges.get(id)??[]){
      const next=byId.get(edge.to);if(!next||visited.has(next.id))continue;
      const length=edge.length??distance(origin,next);if(!Number.isFinite(length)||length<0)continue;
      const candidate=costs.get(id)!+length;
      if(candidate<(costs.get(next.id)??Infinity)){costs.set(next.id,candidate);previous.set(next.id,id);push({id:next.id,cost:candidate});}
    }
  }
  if(!costs.has(goal.id))return [];
  const path=[goal];let id=goal.id;
  while(id!==start.id){const prev=previous.get(id);if(!prev)return [];path.push(byId.get(prev)!);id=prev;if(path.length>nodes.length)return [];}
  const result=path.reverse();if(graph.paths.size>=32)graph.paths.clear();graph.paths.set(key,result);return result;
}

export function mapCoordinates(point:MapPoint,center:MapPoint,heading:number,radius:number,size:number):MapPoint {
  const scale=size/(2*Math.max(1,radius)),dx=point.x-center.x,dz=point.z-center.z;
  return {x:size/2+(dx*Math.cos(heading)+dz*Math.sin(heading))*scale,z:size/2+(-dx*Math.sin(heading)+dz*Math.cos(heading))*scale};
}
