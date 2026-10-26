// Offline inventory clearance against the road widths and junction patches we draw.
// A compact segment grid keeps each tree query local rather than scanning the whole city.
import type * as THREE from "three";
import { roadHalfWidth, sidewalkWidth, nodeDegrees, polylineLength } from "../../src/render/roads.ts";
import type { GroundFn, RoadGraph } from "../../src/render/types.ts";
import type { TreeProfile } from "./tree-profile.ts";
import { GROUND_CELL_M } from "./terrain.ts";

export const TREE_ROAD_CLEAR_HEIGHT = 4.5;
export const TREE_ROAD_MARGIN = .35;
const CELL = 64;
const key = (x:number,z:number):string => `${x},${z}`;
interface Segment { ax:number;az:number;bx:number;bz:number;half:number;ay:number;by:number }
interface Patch { ring:readonly number[] }

export class TreeClearance {
  private readonly segments:Segment[]=[];
  private readonly patches:Patch[]=[];
  private readonly cells=new Map<string,number[]>();
  private readonly seen=new Set<number>();
  private readonly ground:GroundFn;

  constructor(roads:RoadGraph|null|undefined,ground:GroundFn) {
    this.ground=ground;
    const nodes=new Map(roads?.nodes.map(n=>[n.id,n])??[]);
    const degrees = roads ? nodeDegrees(roads) : new Map<string, number>();
    for(const edge of roads?.edges??[]) {
      if((edge as typeof edge&{pedestrian?:boolean}).pedestrian)continue;
      const half=roadHalfWidth(edge);if(!Number.isFinite(half)||half<=0)continue;
      const aY=nodes.get(edge.a)?.y,bY=nodes.get(edge.b)?.y;
      const first=edge.points[0],last=edge.points.at(-1);if(!first||!last)continue;
      const elevated=Number.isFinite(aY)&&Number.isFinite(bY)&&(aY!-ground(first[0],first[1])>2||bY!-ground(last[0],last[1])>2);
      const total=polylineLength(edge.points);if(!Number.isFinite(total)||total<.5)continue;
      const points=edge.points.map(p=>[...p] as [number,number]);
      const extend=(atStart:boolean):number=>{
        if((degrees.get(atStart?edge.a:edge.b)??1)<2)return 0;
        const p=atStart?points[0]!:points.at(-1)!,q=atStart?points[1]!:points.at(-2)!;
        const length=Math.hypot(p[0]-q[0],p[1]-q[1]);if(length<1e-6)return 0;
        const amount=Math.min(half+sidewalkWidth(edge),total*.4);
        const tip:[number,number]=[p[0]+(p[0]-q[0])*amount/length,p[1]+(p[1]-q[1])*amount/length];
        if(atStart)points.unshift(tip);else points.push(tip);return amount;
      };
      const extA=extend(true);extend(false);
      let travelled=-extA;
      for(let i=1;i<points.length;i++) {
        const a=points[i-1]!,b=points[i]!,length=Math.hypot(b[0]-a[0],b[1]-a[1]);
        if(!Number.isFinite(length)||length<1e-6)continue;
        const y=(distance:number):number=>elevated?aY!+(bY!-aY!)*Math.max(0,Math.min(1,distance/total)):Number.NaN;
        const id=this.segments.length;
        this.segments.push({ax:a[0],az:a[1],bx:b[0],bz:b[1],half,ay:y(travelled),by:y(travelled+length)});
        this.index(id,Math.min(a[0],b[0])-half,Math.min(a[1],b[1])-half,Math.max(a[0],b[0])+half,Math.max(a[1],b[1])+half);
        travelled+=length;
      }
    }
  }

  addJunction(ring:readonly number[],x:number,z:number):void {
    if(ring.length<6||ring.length%2||!ring.every(Number.isFinite)||!Number.isFinite(x)||!Number.isFinite(z))return;
    let x0=Infinity,z0=Infinity,x1=-Infinity,z1=-Infinity;
    for(let i=0;i<ring.length;i+=2){x0=Math.min(x0,ring[i]!);x1=Math.max(x1,ring[i]!);z0=Math.min(z0,ring[i+1]!);z1=Math.max(z1,ring[i+1]!);}
    this.patches.push({ring});
    this.index(-this.patches.length,x0,z0,x1,z1);
  }

  private index(id:number,x0:number,z0:number,x1:number,z1:number):void {
    for(let x=Math.floor(x0/CELL);x<=Math.floor(x1/CELL);x++)for(let z=Math.floor(z0/CELL);z<=Math.floor(z1/CELL);z++){
      const k=key(x,z),list=this.cells.get(k);if(list)list.push(id);else this.cells.set(k,[id]);
    }
  }

  /** Covers bark and both foliage LODs below vehicle clearance; high crowns may overhang. */
  allows(profile:TreeProfile,matrix:Readonly<THREE.Matrix4>):boolean {
    const e=matrix.elements;if(!e.every(Number.isFinite))return false;
    const x=e[12]!,y=e[13]!,z=e[14]!;
    const scale=Math.max(Math.hypot(e[0]!,e[2]!),Math.hypot(e[8]!,e[10]!));
    const lean=Math.hypot(e[4]!,e[6]!)*Math.max(Math.abs(profile.minY),Math.abs(profile.maxY));
    const verticalSpread=profile.radius*(Math.abs(e[1]!)+Math.abs(e[9]!));
    const sy=e[5]!;
    const full=profile.radius*scale+lean+.05*scale+TREE_ROAD_MARGIN;
    // Ground is bilinear on the global 10 m lattice. Its extrema over every touched
    // cell are at the corners; include them so a canopy tip on the uphill side cannot
    // slip below clearance even when the nearest road point is lower.
    let terrainRange: [number, number] | undefined;
    const terrain = (): [number, number] => {
      if (terrainRange) return terrainRange;
      let low = Infinity, high = -Infinity;
      for (let gx = Math.floor((x-full)/GROUND_CELL_M)*GROUND_CELL_M; gx <= Math.ceil((x+full)/GROUND_CELL_M)*GROUND_CELL_M; gx += GROUND_CELL_M) {
        for (let gz = Math.floor((z-full)/GROUND_CELL_M)*GROUND_CELL_M; gz <= Math.ceil((z+full)/GROUND_CELL_M)*GROUND_CELL_M; gz += GROUND_CELL_M) {
          const h = this.ground(gx,gz); low = Math.min(low,h); high = Math.max(high,h);
        }
      }
      return terrainRange = [low, high];
    };
    const radiusAt=(height:number, topHeight=height):number|null=>{
      let low:number,high:number;
      if(Math.abs(sy)<1e-8){
        if(y+verticalSpread<height||y-verticalSpread>topHeight+TREE_ROAD_CLEAR_HEIGHT)return null;
        low=profile.minY;high=profile.maxY;
      }else{
        const a=(height-y-verticalSpread)/sy,b=(topHeight+TREE_ROAD_CLEAR_HEIGHT-y+verticalSpread)/sy;
        low=Math.min(a,b);high=Math.max(a,b);
      }
      const r=profile.radiusBetween(low,high);
      return r===null?null:r*scale+lean+.05*scale+TREE_ROAD_MARGIN;
    };
    this.seen.clear();
    for(let cx=Math.floor((x-full)/CELL);cx<=Math.floor((x+full)/CELL);cx++)for(let cz=Math.floor((z-full)/CELL);cz<=Math.floor((z+full)/CELL);cz++){
      for(const id of this.cells.get(key(cx,cz))??[]){
        if(this.seen.has(id))continue;this.seen.add(id);
        if(id>=0){
          const s=this.segments[id]!,dx=s.bx-s.ax,dz=s.bz-s.az,l2=dx*dx+dz*dz;
          const t=Math.max(0,Math.min(1,((x-s.ax)*dx+(z-s.az)*dz)/l2)),px=s.ax+t*dx,pz=s.az+t*dz;
          const r=Number.isFinite(s.ay)?radiusAt(Math.min(s.ay,s.by),Math.max(s.ay,s.by)):radiusAt(...terrain());
          if(r!==null&&Math.hypot(x-px,z-pz)<s.half+r)return false;
        }else{
          const p=this.patches[-id-1]!;
          let inside=false,distance=Infinity;
          for(let i=0,j=p.ring.length-2;i<p.ring.length;j=i,i+=2){
            const ax=p.ring[j]!,az=p.ring[j+1]!,bx=p.ring[i]!,bz=p.ring[i+1]!;
            if((az>z)!==(bz>z)&&x<(bx-ax)*(z-az)/(bz-az)+ax)inside=!inside;
            const dx=bx-ax,dz=bz-az,l2=dx*dx+dz*dz,t=l2?Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/l2)):0;
            const d=Math.hypot(x-ax-t*dx,z-az-t*dz);
            distance=Math.min(distance,d);
          }
          const r=radiusAt(...terrain());
          if(r!==null&&(inside||distance<r))return false;
        }
      }
    }
    return true;
  }
}
