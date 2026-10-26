// The old low-detail landmark hulls have no building IDs in their merged far mesh.
// Match their original convex footprints once at load; keep terrain and neighbours.
import * as THREE from "three";
import type { BuildingCollider } from "../sim/world.ts";

type Point = readonly [number, number];

function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  const cross = (a:Point,b:Point,c:Point) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const lower:Point[]=[],upper:Point[]=[];
  for(const p of sorted){while(lower.length>1&&cross(lower.at(-2)!,lower.at(-1)!,p)<=0)lower.pop();lower.push(p);}
  for(const p of sorted.reverse()){while(upper.length>1&&cross(upper.at(-2)!,upper.at(-1)!,p)<=0)upper.pop();upper.push(p);}
  return lower.slice(0,-1).concat(upper.slice(0,-1));
}

function inside(ring:readonly Point[],x:number,z:number):boolean {
  // Far-cell integer position quantisation moves a corner by a few centimetres.
  const tolerance=.12;
  for(let i=0;i<ring.length;i++){
    const a=ring[i]!,b=ring[(i+1)%ring.length]!;
    if((b[0]-a[0])*(z-a[1])-(b[1]-a[1])*(x-a[0]) < -tolerance*Math.hypot(b[0]-a[0],b[1]-a[1]))return false;
  }
  return true;
}

/** Return an independently owned filtered geometry, or null when no hull matched. */
export function filterLandmarkHulls(geometry:THREE.BufferGeometry,matrixWorld:THREE.Matrix4,sources:readonly BuildingCollider[]):THREE.BufferGeometry|null {
  const pos=geometry.getAttribute("position");
  if(!pos||sources.length===0)return null;
  const box=(geometry.boundingBox?.clone()??new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute)).applyMatrix4(matrixWorld);
  const masks=sources.map(b=>({
    ring:convexHull(b.footprint),above:b.baseY+(b.topY-b.baseY)*.5,
    minX:Math.min(...b.footprint.map(p=>p[0]))-.12,maxX:Math.max(...b.footprint.map(p=>p[0]))+.12,
    minZ:Math.min(...b.footprint.map(p=>p[1]))-.12,maxZ:Math.max(...b.footprint.map(p=>p[1]))+.12,
  })).filter(m=>box.max.x>=m.minX&&box.min.x<=m.maxX&&box.max.z>=m.minZ&&box.min.z<=m.maxZ);
  if(masks.length===0)return null;
  const index=geometry.index,count=index?.count??pos.count,kept:number[]=[],offsets=new Uint32Array(count+1);
  const vertices=[new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()];
  let removed=0;
  for(let i=0;i+2<count;i+=3){
    const ids=[index?index.getX(i):i,index?index.getX(i+1):i+1,index?index.getX(i+2):i+2];
    for(let k=0;k<3;k++)vertices[k]!.fromBufferAttribute(pos,ids[k]!).applyMatrix4(matrixWorld);
    const hide=masks.some(m=>vertices.some(v=>v.y>m.above)&&vertices.every(v=>v.x>=m.minX&&v.x<=m.maxX&&v.z>=m.minZ&&v.z<=m.maxZ&&inside(m.ring,v.x,v.z)));
    for(let k=0;k<3;k++)offsets[i+k]=kept.length;
    if(hide)removed++;else kept.push(...ids);
    offsets[i+3]=kept.length;
  }
  if(removed===0)return null;
  const out=geometry.clone().setIndex(kept);
  out.clearGroups();
  for(const group of geometry.groups){
    const start=offsets[Math.min(count,group.start)]!,end=offsets[Math.min(count,group.start+group.count)]!;
    if(end>start)out.addGroup(start,end-start,group.materialIndex);
  }
  const start=offsets[Math.min(count,geometry.drawRange.start)]!;
  const end=offsets[Math.min(count,geometry.drawRange.start+geometry.drawRange.count)]!;
  out.setDrawRange(start,end-start);
  return out;
}
