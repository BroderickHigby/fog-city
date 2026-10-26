// SF geography only. Immutable source vertices are shared with the city, indexed once; a
// neighborhood paint builds temporary vector paths, then the minimap caches the raster.
import type { Heightfield } from "../sim/world.ts";
import { route } from "./navigation.ts";
import type { MapEdge, MapGeography, MapNode, MapPoint, MapView } from "./types.ts";

type Point = readonly [number, number];
type Ring = readonly Point[];
export type MapBounds = readonly [number, number, number, number];
interface Base { readonly bounds:MapBounds }
export interface MapRoad extends Base { readonly kind:"road"; readonly points:Ring; readonly width:number; readonly name:string; readonly highway:boolean }
export interface MapPolygon extends Base { readonly kind:"building"|"park"; readonly rings:readonly Ring[]; readonly shade:number }
export interface MapGround extends Base { readonly kind:"ground"; readonly field:Readonly<Heightfield> }
export interface MapShore extends Base { readonly kind:"shore"; readonly points:Ring }
export type MapFeature=MapRoad|MapPolygon|MapGround|MapShore;
export const MAP_COLORS={land:"#151a20",water:"#0a1520",park:"#20372b",parkEdge:"#34513b",building:["#242c35","#2d3743","#35414f"],buildingEdge:"#151c24",street:"#495563",streetEdge:"#202833",highway:"#a5864b",shore:"#516575",route:"#ffc83d"} as const;
const CELL=256,MAX_CELLS=256;
const PARK_NAMES=new Set(["Golden Gate Park","Presidio","McLaren Park","Lincoln Park"]);
const overlap=(a:MapBounds,b:MapBounds):boolean=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
function bounds(points:readonly (readonly number[])[]):MapBounds|null {
  if(points.length<2)return null;let x0=Infinity,z0=Infinity,x1=-Infinity,z1=-Infinity;
  for(const p of points){const x=p[0],z=p[1];if(typeof x!=="number"||typeof z!=="number"||!Number.isFinite(x+z))return null;x0=Math.min(x0,x);z0=Math.min(z0,z);x1=Math.max(x1,x);z1=Math.max(z1,z);}
  return[x0,z0,x1,z1];
}
const indexes=new WeakMap<object,MapAtlas>();
const EMPTY_EDGES:readonly MapEdge[]=[];
/** The index owns bounds/reference lists, never a second copy of SF footprints or road vertices. */
export class MapAtlas {
  private readonly cells=new Map<string,MapFeature[]>();
  private readonly large:MapFeature[]=[];
  readonly hasGround:boolean;
  readonly features:number;
  constructor(geography:MapGeography|undefined,nodes:readonly MapNode[]=[],edges:readonly MapEdge[]=[]){
    let count=0,ground=false;
    const add=(feature:MapFeature):void=>{count++;const b=feature.bounds,x0=Math.floor(b[0]/CELL),z0=Math.floor(b[1]/CELL),x1=Math.floor(b[2]/CELL),z1=Math.floor(b[3]/CELL);if((x1-x0+1)*(z1-z0+1)>MAX_CELLS){this.large.push(feature);return;}for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){const key=`${x},${z}`,list=this.cells.get(key);if(list)list.push(feature);else this.cells.set(key,[feature]);}};
    const seen=new Set<string>();
    for(const tile of geography?.tiles??[]){
      const field=tile.ground;if(field&&field.nx>1&&field.nz>1){ground=true;add({kind:"ground",field,bounds:[field.x0,field.z0,field.x0+(field.nx-1)*field.cellSizeM,field.z0+(field.nz-1)*field.cellSizeM]});}
      for(const building of tile.buildings){if(seen.has(building.id))continue;seen.add(building.id);const b=bounds(building.footprint);if(!b||building.footprint.length<3)continue;add({kind:"building",rings:[building.footprint],bounds:b,shade:building.topY-building.baseY>45?2:building.topY-building.baseY>15?1:0});}
    }
    const sourceRoads=geography?.roads?.edges;
    if(sourceRoads)for(const road of sourceRoads){const b=bounds(road.points);if(b)add({kind:"road",points:road.points,bounds:b,width:Math.max(3,Math.min(40,road.widthM??road.lanes*3.25)),name:road.name??"",highway:road.kind==="freeway"||road.kind==="ramp"});}
    else{const byId=new Map(nodes.map(n=>[n.id,n]));for(const edge of edges){if(edge.reversed)continue;const from=byId.get(edge.from),to=byId.get(edge.to),points=edge.points??(from&&to?[[from.x,from.z],[to.x,to.z]] as Point[]:[]);const b=bounds(points);if(b)add({kind:"road",points,bounds:b,width:Math.max(3,Math.min(40,edge.widthM??7)),name:edge.name??"",highway:edge.kind==="freeway"||edge.kind==="ramp"});}}
    const districts=(geography?.districts as {districts?:Array<{name?:string;polygons?:readonly (readonly Ring[])[]}>}|null)?.districts;
    for(const district of Array.isArray(districts)?districts:[]){if(!PARK_NAMES.has(district.name??"")||!Array.isArray(district.polygons))continue;for(const rings of district.polygons){const b=rings[0]&&bounds(rings[0]);if(b&&rings[0]!.length>=3)add({kind:"park",rings,bounds:b,shade:0});}}
    for(const shore of geography?.boundary?.shore??[]){const b=bounds(shore.points);if(b)add({kind:"shore",points:shore.points as Ring,bounds:b});}
    this.hasGround=ground;this.features=count;
  }
  query(box:MapBounds):readonly MapFeature[]{
    const seen=new Set<MapFeature>(),out:MapFeature[]=[];
    const take=(f:MapFeature):void=>{if(!seen.has(f)&&overlap(f.bounds,box)){seen.add(f);out.push(f);}};
    const x0=Math.floor(box[0]/CELL),x1=Math.floor(box[2]/CELL),z0=Math.floor(box[1]/CELL),z1=Math.floor(box[3]/CELL);
    // Full phone zooms are bounded by the loaded index; malformed ranges never allocate cells.
    if((x1-x0+1)*(z1-z0+1)>4096){for(const list of this.cells.values())for(const f of list)take(f);}
    else for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++)for(const f of this.cells.get(`${x},${z}`)??[])take(f);
    for(const f of this.large)take(f);return out;
  }
}
export function atlasFor(map:MapView|undefined):MapAtlas {
  const key=map?.geography??map?.edges??EMPTY_EDGES;let atlas=indexes.get(key);
  if(!atlas){atlas=new MapAtlas(map?.geography,map?.nodes,map?.edges);indexes.set(key,atlas);}return atlas;
}
interface RouteSegment {readonly points:Ring;readonly reversed:boolean}
const routeLines=new WeakMap<readonly MapNode[],readonly RouteSegment[]>();
const edgeLookups=new WeakMap<readonly MapEdge[],{nodes:readonly MapNode[];edges:Map<string,MapEdge>}>();
/** Preserve the existing directed route solver while drawing each chosen SF edge's actual curve. */
export function routeSegments(map:MapView,from:MapPoint,to:MapPoint):readonly RouteSegment[]{
  const path=route(map.nodes,map.edges,from,to),cached=routeLines.get(path);if(cached)return cached;
  let lookup=edgeLookups.get(map.edges);if(!lookup||lookup.nodes!==map.nodes){
    const nodes=new Map(map.nodes.map(node=>[node.id,node])),edges=new Map<string,MapEdge>(),costs=new Map<string,number>();
    for(const edge of map.edges){const a=nodes.get(edge.from),b=nodes.get(edge.to);if(!a||!b)continue;const cost=edge.length??Math.hypot(b.x-a.x,b.z-a.z);if(!Number.isFinite(cost)||cost<0)continue;
      // SF has parallel ways between some junctions. Match Dijkstra's shortest edge, first on ties.
      const key=`${edge.from}\0${edge.to}`;if(cost<(costs.get(key)??Infinity)){edges.set(key,edge);costs.set(key,cost);}}
    lookup={nodes:map.nodes,edges};edgeLookups.set(map.edges,lookup);
  }
  const segments:RouteSegment[]=[];for(let i=1;i<path.length;i++){const a=path[i-1]!,b=path[i]!,edge=lookup.edges.get(`${a.id}\0${b.id}`);segments.push({points:edge?.points??[[a.x,a.z],[b.x,b.z]],reversed:edge?.reversed??false});}
  routeLines.set(path,segments);return segments;
}
function line(target:CanvasRenderingContext2D|Path2D,points:Ring,closed=false):void {
  if(!points.length)return;target.moveTo(points[0]![0],points[0]![1]);for(let i=1;i<points.length;i++)target.lineTo(points[i]![0],points[i]![1]);if(closed)target.closePath();
}
function polygon(target:CanvasRenderingContext2D|Path2D,points:Ring,hole:boolean):void {
  let area=0;for(let i=0;i<points.length;i++){const a=points[i]!,b=points[(i+1)%points.length]!;area+=a[0]*b[1]-b[0]*a[1];}
  const reverse=(area<0)!==hole;if(!points.length)return;
  const at=(i:number)=>points[reverse?points.length-1-i:i]!;
  target.moveTo(at(0)[0],at(0)[1]);for(let i=1;i<points.length;i++)target.lineTo(at(i)[0],at(i)[1]);target.closePath();
}
function label(road:MapRoad):{x:number;z:number;angle:number;length:number}|null {
  let total=0;for(let i=1;i<road.points.length;i++)total+=Math.hypot(road.points[i]![0]-road.points[i-1]![0],road.points[i]![1]-road.points[i-1]![1]);
  let left=total/2;for(let i=1;i<road.points.length;i++){const a=road.points[i-1]!,b=road.points[i]!,length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(left<=length&&length>0)return{x:a[0]+(b[0]-a[0])*left/length,z:a[1]+(b[1]-a[1])*left/length,angle:Math.atan2(b[1]-a[1],b[0]-a[0]),length:total};left-=length;}return null;
}
/** Bounded neighborhood paint; native Path2D is temporary and the caller retains only its raster. */
export function paintAtlas(c:CanvasRenderingContext2D,atlas:MapAtlas,center:MapPoint,radius:number,size:number,pixelRatio=1,heading=0):void {
  const scale=size/(2*radius),box:MapBounds=[center.x-radius*1.42,center.z-radius*1.42,center.x+radius*1.42,center.z+radius*1.42],features=atlas.query(box);
  c.fillStyle=atlas.hasGround?MAP_COLORS.water:MAP_COLORS.land;c.fillRect(0,0,size,size);
  c.save();c.translate(size/2,size/2);c.rotate(-heading);c.scale(scale,scale);c.translate(-center.x,-center.z);c.lineJoin="round";c.lineCap="round";
  c.fillStyle=MAP_COLORS.land;
  for(const feature of features)if(feature.kind==="ground"){
    const f=feature.field;if(!f.water){c.fillRect(f.x0,f.z0,(f.nx-1)*f.cellSizeM,(f.nz-1)*f.cellSizeM);continue;}
    for(let z=0;z<f.nz-1;z++){let run=-1;for(let x=0;x<f.nx;x++){const land=x<f.nx-1&&f.water[z*f.nx+x]!==1;if(land&&run<0)run=x;if(!land&&run>=0){c.fillRect(f.x0+run*f.cellSizeM,f.z0+z*f.cellSizeM,(x-run)*f.cellSizeM,f.cellSizeM);run=-1;}}}
  }
  for(const kind of ["park","building"] as const)for(let shade=0;shade<(kind==="park"?1:3);shade++){
    const rows=features.filter((f):f is MapPolygon=>f.kind===kind&&f.shade===shade&&(kind==="park"||(f.bounds[2]-f.bounds[0])*scale>=.8&&(f.bounds[3]-f.bounds[1])*scale>=.8));if(!rows.length)continue;
    const path=typeof Path2D!=="undefined"?new Path2D():null;if(!path)c.beginPath();for(const f of rows)f.rings.forEach((ring,index)=>polygon(path??c,ring,index>0));
    c.fillStyle=kind==="park"?MAP_COLORS.park:MAP_COLORS.building[shade]!;if(path)c.fill(path);else c.fill();
    c.strokeStyle=kind==="park"?MAP_COLORS.parkEdge:MAP_COLORS.buildingEdge;c.lineWidth=1/scale;if(path)c.stroke(path);else c.stroke();
  }
  const roads=features.filter((f):f is MapRoad=>f.kind==="road");
  const groups=new Map<string,MapRoad[]>();for(const road of roads){const key=`${road.width}:${road.highway}`;const rows=groups.get(key);if(rows)rows.push(road);else groups.set(key,[road]);}
  for(const rows of groups.values()){const path=typeof Path2D!=="undefined"?new Path2D():null;if(!path)c.beginPath();for(const road of rows)line(path??c,road.points);c.lineWidth=rows[0]!.width+2;c.strokeStyle=MAP_COLORS.streetEdge;if(path)c.stroke(path);else c.stroke();c.lineWidth=rows[0]!.width;c.strokeStyle=rows[0]!.highway?MAP_COLORS.highway:MAP_COLORS.street;if(path)c.stroke(path);else c.stroke();}
  c.strokeStyle=MAP_COLORS.shore;c.lineWidth=1.2/scale;c.beginPath();for(const f of features)if(f.kind==="shore")line(c,f.points);c.stroke();c.restore();
  if(typeof c.fillText!=="function")return;
  c.font=`600 ${10*pixelRatio}px system-ui`;c.textAlign="center";c.textBaseline="middle";c.lineWidth=3*pixelRatio;
  const used=new Set<string>(),placed:MapBounds[]=[];let count=0;
  for(const road of roads){if(!road.name||used.has(road.name)||road.highway)continue;const p=label(road);if(!p)continue;const width=c.measureText(road.name).width;if(p.length*scale<width+12*pixelRatio)continue;
    const dx=p.x-center.x,dz=p.z-center.z,x=size/2+(dx*Math.cos(heading)+dz*Math.sin(heading))*scale,y=size/2+(-dx*Math.sin(heading)+dz*Math.cos(heading))*scale;
    const b:MapBounds=[x-width/2-4,y-8*pixelRatio,x+width/2+4,y+8*pixelRatio];if(b[0]<8||b[2]>size-8||b[1]<8||b[3]>size-8||placed.some(other=>overlap(b,other)))continue;
    let angle=p.angle-heading;if(Math.cos(angle)<0)angle+=Math.PI;c.save();c.translate(x,y);c.rotate(angle);c.strokeStyle="#10161de8";c.fillStyle="#b6c3d0";c.strokeText?.(road.name,0,0);c.fillText(road.name,0,0);c.restore();placed.push(b);used.add(road.name);if(++count>=Math.min(32,Math.floor(size/(12*pixelRatio))))break;
  }
}
