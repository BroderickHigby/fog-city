/** Draft destination: src/modes/taxi-routes.ts. Catalog construction is entry-time work only. */
import { DISTRICTS, PROTECTED_AREAS, districtsAt, protectedAreaAt } from "../content/places.ts";
import { toLatLon, toLocal } from "../geo/project.ts";
import { CAR } from "../sim/car.ts";
import { circleHitsWall } from "../sim/boundary.ts";
import { datan2 } from "../sim/dmath.ts";
import { circleBlocked, groundHeight, groundWater, type World } from "../sim/world.ts";
import { dirIndex, endNode, lanePath, pathPoint, projectOnPath, startNode, type DirEdge, type RoadGraph } from "../sim/roads.ts";
import { serviceEntryClear } from "../sim/agents/service-runtime.ts";
import type { TaxiConfig, TaxiPoint, TaxiRoute, TaxiStop } from "../sim/modes/taxi.ts";

export interface TaxiCurb {
  id:string;district:string;districtName:string;label:string;
  stop:TaxiStop;heading:number;passenger:TaxiPoint;
  edge:number;edgeId:string;dir:1|-1;lane:number;at:number;
}
export interface TaxiRoadRoute {id:string;pickup:string;destination:string;links:DirEdge[];edgeIds:string[];distanceM:number}
export interface TaxiStreetCatalog {version:1;config:TaxiConfig;curbs:TaxiCurb[];roads:TaxiRoadRoute[]}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const distance=(a:{x:number;z:number},b:{x:number;z:number})=>Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.z-b.z)*(a.z-b.z));
/** Missing tiles never silently turn into a sea-level curb. */
function supported(world:World,x:number,z:number):boolean {
  return world.tiles.some(tile=>{const ground=tile.ground;return ground&&x>=ground.x0&&z>=ground.z0&&x<=ground.x0+(ground.nx-1)*ground.cellSizeM&&z<=ground.z0+(ground.nz-1)*ground.cellSizeM;});
}
function allowed(world:World,x:number,z:number,radius:number):boolean {
  const ll=toLatLon(x,z);
  return supported(world,x,z)&&!groundWater(world,x,z)&&!protectedAreaAt([ll.lat,ll.lon])&&!circleBlocked(world,x,z,radius)&&!circleHitsWall(world.walls,x,z,radius);
}
const excludedCache=new WeakMap<RoadGraph,ReadonlySet<number>>();
function pointSegmentSquared(px:number,pz:number,ax:number,az:number,bx:number,bz:number):number {const dx=bx-ax,dz=bz-az,d=dx*dx+dz*dz,t=d===0?0:Math.max(0,Math.min(1,((px-ax)*dx+(pz-az)*dz)/d));return (px-ax-t*dx)**2+(pz-az-t*dz)**2;}
function crosses(ax:number,az:number,bx:number,bz:number,cx:number,cz:number,dx:number,dz:number):boolean {const cross=(x:number,z:number,u:number,v:number)=>x*v-z*u,abx=bx-ax,abz=bz-az,cdx=dx-cx,cdz=dz-cz,den=cross(abx,abz,cdx,cdz);if(Math.abs(den)<1e-12)return false;const t=cross(cx-ax,cz-az,cdx,cdz)/den,u=cross(cx-ax,cz-az,abx,abz)/den;return t>=0&&t<=1&&u>=0&&u<=1;}
function polygonInside(x:number,z:number,ring:readonly {x:number;z:number}[]):boolean {let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i]!,b=ring[j]!;if((a.z>z)!==(b.z>z)&&x<(b.x-a.x)*(z-a.z)/(b.z-a.z)+a.x)inside=!inside;}return inside;}
/** No taxi road/body corridor intersects an excluded mode area or makes Chinatown a route. */
export function taxiExcludedRoadEdges(graph:RoadGraph):ReadonlySet<number> {
  const cached=excludedCache.get(graph);if(cached)return cached;
  const areas=PROTECTED_AREAS.filter(area=>area.excluded||area.id==="chinatown").map(area=>{const ring=area.polygon.map(([lat,lon])=>toLocal(lat,lon));return {ring,minX:Math.min(...ring.map(p=>p.x)),maxX:Math.max(...ring.map(p=>p.x)),minZ:Math.min(...ring.map(p=>p.z)),maxZ:Math.max(...ring.map(p=>p.z))};});
  const excluded=new Set<number>();
  for(const edge of graph.edges){
    const xs=edge.center.xs,zs=edge.center.zs,pad=edge.widthM/2+CAR.halfWidth+.75,pad2=pad*pad,minX=Math.min(...xs)-pad,maxX=Math.max(...xs)+pad,minZ=Math.min(...zs)-pad,maxZ=Math.max(...zs)+pad;
    for(const area of areas){
      if(maxX<area.minX||minX>area.maxX||maxZ<area.minZ||minZ>area.maxZ)continue;
      let touches=false;
      for(let i=0;i<xs.length&&!touches;i++){
        const x=xs[i]!,z=zs[i]!;if(polygonInside(x,z,area.ring)){touches=true;break;}
        if(i===0)continue;const ax=xs[i-1]!,az=zs[i-1]!;
        for(let j=0;j<area.ring.length;j++){
          const a=area.ring[j]!,b=area.ring[(j+1)%area.ring.length]!;
          if(crosses(ax,az,x,z,a.x,a.z,b.x,b.z)||Math.min(pointSegmentSquared(ax,az,a.x,a.z,b.x,b.z),pointSegmentSquared(x,z,a.x,a.z,b.x,b.z),pointSegmentSquared(a.x,a.z,ax,az,x,z),pointSegmentSquared(b.x,b.z,ax,az,x,z))<=pad2){touches=true;break;}
        }
      }
      if(touches){excluded.add(edge.index);break;}
    }
  }
  excludedCache.set(graph,excluded);return excluded;
}
function legal(graph:RoadGraph,link:DirEdge):boolean {
  const edge=graph.edges[link.edge];return !!edge&&edge.drivable&&!(link.dir===-1&&edge.oneway)&&edge.laneSafe[dirIndex(link.dir)].some(Boolean)&&!taxiExcludedRoadEdges(graph).has(link.edge);
}
/** Deterministic legal directed path, including the initial and final partial road segments. */
export function taxiRoadPath(graph:RoadGraph,from:TaxiCurb,to:TaxiCurb):TaxiRoadRoute|null {
  const first=graph.edges[from.edge],last=graph.edges[to.edge];if(!first||!last||first.id!==from.edgeId||last.id!==to.edgeId||!legal(graph,from)||!legal(graph,to))return null;
  if(from.edge===to.edge&&from.dir===to.dir&&to.at>from.at)return {id:`${from.id}-to-${to.id}`,pickup:from.id,destination:to.id,links:[{edge:from.edge,dir:from.dir}],edgeIds:[first.id],distanceM:to.at-from.at};
  const origin=endNode(first,from.dir),target=startNode(last,to.dir);
  const costs=graph.nodes.map(()=>Infinity),parents=graph.nodes.map(()=>-1),incoming:(DirEdge|null)[]=graph.nodes.map(()=>null);
  const heap:{node:number;cost:number}[]=[];
  const less=(a:{node:number;cost:number},b:{node:number;cost:number})=>a.cost<b.cost||a.cost===b.cost&&compare(graph.nodes[a.node]!.id,graph.nodes[b.node]!.id)<0;
  const push=(node:number,cost:number)=>{const value={node,cost};let at=heap.length;heap.push(value);while(at>0){const parent=(at-1)>>1;if(!less(value,heap[parent]!))break;heap[at]=heap[parent]!;at=parent;}heap[at]=value;};
  const pop=()=>{const first=heap[0]!,last=heap.pop()!;if(!heap.length)return first;let at=0;while(at*2+1<heap.length){let child=at*2+1;if(child+1<heap.length&&less(heap[child+1]!,heap[child]!))child++;if(!less(heap[child]!,last))break;heap[at]=heap[child]!;at=child;}heap[at]=last;return first;};
  costs[origin]=0;push(origin,0);
  while(heap.length){
    const current=pop(),at=current.node;if(current.cost!==costs[at])continue;if(at===target)break;
    const exits=[...graph.nodes[at]!.out].sort((a,b)=>compare(graph.edges[a.edge]!.id,graph.edges[b.edge]!.id)||a.dir-b.dir);
    for(const link of exits){if(!legal(graph,link))continue;const edge=graph.edges[link.edge]!,next=endNode(edge,link.dir),cost=costs[at]!+edge.center.len;if(cost>=costs[next]!)continue;costs[next]=cost;parents[next]=at;incoming[next]={...link};push(next,cost);}
  }
  if(!Number.isFinite(costs[target]))return null;
  const middle:DirEdge[]=[];
  for(let at=target;at!==origin;at=parents[at]!){const link=incoming[at];if(!link||parents[at]!<0)return null;middle.push(link);}
  middle.reverse();
  const remaining=lanePath(first,from.dir,from.lane).len-from.at;
  return {id:`${from.id}-to-${to.id}`,pickup:from.id,destination:to.id,links:[{edge:from.edge,dir:from.dir},...middle,{edge:to.edge,dir:to.dir}],edgeIds:[first.id,...middle.map(link=>graph.edges[link.edge]!.id),last.id],distanceM:remaining+costs[target]!+to.at};
}
function curbFor(world:World,districtId:string):TaxiCurb|null {
  const graph=world.roads!,district=DISTRICTS.find(value=>value.id===districtId);if(!district)return null;
  const hub=toLocal(district.hub.lat,district.hub.lon),candidates:{curb:TaxiCurb;score:number;key:string}[]=[];
  for(const edge of [...graph.edges].sort((a,b)=>compare(a.id,b.id))){
    if(!edge.drivable||!edge.walkable||edge.center.len<45)continue;
    for(const dir of [1,-1] as const){
      if(dir===-1&&edge.oneway)continue;const di=dirIndex(dir),lane=edge.laneCount[di]-1;
      if(lane<0||!edge.laneSafe[di][lane])continue;const path=lanePath(edge,dir,lane);if(path.len<30)continue;
      const nearest=projectOnPath(path,hub.x,hub.z).s;
      const samples=[Math.max(12,Math.min(path.len-12,nearest)),path.len*.3,path.len*.5,path.len*.7].sort((a,b)=>a-b);
      for(const at of samples){
        if(at<12||at>path.len-12)continue;const p=pathPoint(path,at),ll=toLatLon(p.x,p.z),heading=datan2(p.tx,-p.tz);
        if(distance(p,hub)>700||!districtsAt([ll.lat,ll.lon]).some(value=>value.id===districtId)||!allowed(world,p.x,p.z,.2)||!serviceEntryClear(world,{...p,heading},[],CAR.halfLength,CAR.halfWidth,1.8))continue;
        const y=groundHeight(world,p.x,p.z),corners=[[-1,-1],[-1,1],[1,-1],[1,1]] as const;
        if(corners.some(([f,r])=>{const x=p.x+p.tx*f*CAR.halfLength-p.tz*r*CAR.halfWidth,z=p.z+p.tz*f*CAR.halfLength+p.tx*r*CAR.halfWidth;return !allowed(world,x,z,.1)||Math.abs(groundHeight(world,x,z)-y)>.8;}))continue;
        for(const offset of [3.2,3.7,4.2,4.7]){
          const x=p.x-p.tz*offset,z=p.z+p.tx*offset;
          if(!allowed(world,x,z,.45)||Math.abs(groundHeight(world,x,z)-y)>.6)continue;
          const key=`${edge.id}:${dir}:${at}:${offset}`;
          candidates.push({score:distance(p,hub),key,curb:{id:districtId,district:district.id,districtName:district.name,label:`${district.hub.label} · ${edge.name||district.name} curb`,stop:{x:p.x,y,z:p.z,radiusM:3.8},heading,passenger:{x,y:groundHeight(world,x,z),z},edge:edge.index,edgeId:edge.id,dir,lane,at}});break;
        }
      }
    }
  }
  candidates.sort((a,b)=>a.score-b.score||compare(a.key,b.key));return candidates[0]?.curb??null;
}
/** Real named SF districts; unavailable/protected/unsupported districts are excluded, never invented. */
export function createSfTaxiCatalog(world:World,wave=3,title="Crazy Uber"):TaxiStreetCatalog {
  if(!world.roads)throw new Error("Taxi shifts require the city's legal road graph");
  const ids=["downtown","fidi","embarcadero","north-beach","fishermans-wharf","marina","soma","mission-bay","dogpatch","rincon-hill"];
  const available=ids.filter(id=>{const d=DISTRICTS.find(value=>value.id===id);return d&&d.wave<=wave;}).map(id=>curbFor(world,id)).filter((curb):curb is TaxiCurb=>curb!==null);
  const first=available[0];if(!first)throw new Error("This loaded city has no dry, supported taxi curb");
  const connected=available.filter(value=>value.id!==first.id&&distance(first.stop,value.stop)<=2800&&taxiRoadPath(world.roads!,first,value)&&taxiRoadPath(world.roads!,value,first)).sort((a,b)=>distance(first.stop,a.stop)-distance(first.stop,b.stop)||compare(a.id,b.id)).slice(0,5);
  if(!connected.length)throw new Error("This loaded city needs two connected SF taxi districts");
  const ordered=[first],remaining=[...connected];let current=first;
  while(remaining.length){remaining.sort((a,b)=>distance(current.stop,a.stop)-distance(current.stop,b.stop)||compare(a.id,b.id));current=remaining.shift()!;ordered.push(current);}
  const roads:TaxiRoadRoute[]=[],routes:TaxiRoute[]=[];
  // A real closed circuit: every destination is the next pickup, including wrap-around.
  for(let index=0;index<ordered.length;index++){
    const from=ordered[index]!,to=ordered[(index+1)%ordered.length]!,path=taxiRoadPath(world.roads!,from,to);
    if(!path||path.distanceM>19_000||distance(from.stop,to.stop)<50)throw new Error("Taxi district circuit lacks a legal directed road path");
    roads.push(path);const distanceM=Math.max(distance(from.stop,to.stop),path.distanceM);
    routes.push({id:path.id,pickupLabel:from.label,destinationLabel:to.label,pickupDistrict:from.districtName,destinationDistrict:to.districtName,pickup:from.stop,destination:to.stop,roadDistanceM:distanceM,timeLimitTicks:Math.min(10*60*60,Math.max(90*60,Math.ceil(distanceM/7+35)*60)),baseFareCents:Math.round(600+distanceM*.45),timeBonusCentsPerSecond:3,maxTimeBonusCents:600,xp:25});
  }
  const itinerary=routes.map(value=>value.id);
  routes.sort((a,b)=>compare(a.id,b.id));roads.sort((a,b)=>compare(a.id,b.id));
  return {version:1,curbs:available,roads,config:{version:1,id:"sf-road-taxi-v1",title,routes,shifts:[{id:"day",label:"Day shift",theme:"daylight",routeIds:[...itinerary]},{id:"night",label:"Night shift",theme:"night",routeIds:[...itinerary]},{id:"fog-rain",label:"Fog and rain",theme:"fog-rain",routeIds:[...itinerary]}]}};
}
/** Spawn on the pickup lane, ten metres behind the first curb, with its actual road heading. */
export function taxiStartSpawn(world:World,catalog:TaxiStreetCatalog,routeId:string):{x:number;z:number;heading:number} {
  const road=catalog.roads.find(value=>value.id===routeId),curb=road&&catalog.curbs.find(value=>value.id===road.pickup);if(!curb||!world.roads)throw new Error("Missing taxi start curb");
  const edge=world.roads.edges[curb.edge];if(!edge||edge.id!==curb.edgeId)throw new Error("Taxi roads changed");
  const p=pathPoint(lanePath(edge,curb.dir,curb.lane),Math.max(0,curb.at-10));return {x:p.x,z:p.z,heading:datan2(p.tx,-p.tz)};
}
/** Catalog's directed links are rechecked without running a search each simulation tick. */
export function taxiRouteStatus(world:World,catalog:TaxiStreetCatalog,routeId:string):"open"|"blocked"|"unknown" {
  const route=catalog.roads.find(value=>value.id===routeId);if(!route||!world.roads)return "unknown";
  const stops=[catalog.curbs.find(value=>value.id===route.pickup),catalog.curbs.find(value=>value.id===route.destination)];
  if(stops.some(stop=>!stop||world.roads!.edges[stop.edge]?.id!==stop.edgeId))return "unknown";
  if(route.links.length!==route.edgeIds.length||route.links.some((link,index)=>world.roads!.edges[link.edge]?.id!==route.edgeIds[index]))return "unknown";
  if(route.links.some(link=>!legal(world.roads!,link))||route.links.some((link,index)=>index>0&&endNode(world.roads!.edges[route.links[index-1]!.edge]!,route.links[index-1]!.dir)!==startNode(world.roads!.edges[link.edge]!,link.dir))||stops.some(stop=>!allowed(world,stop!.stop.x,stop!.stop.z,.2)))return "blocked";
  return "open";
}
