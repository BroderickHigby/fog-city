// A failed architectural asset must not bring back the old solid building. Draw the
// same placed collision pieces as one inexpensive mesh until the detailed model loads.
import * as THREE from "three";
import type { LandmarkWorldReplacement } from "../io/landmark-world.ts";
import { retireRenderTree } from "./renderer-warmup.ts";

type Point = [number,number,number];

function geometryFor(replacement:LandmarkWorldReplacement):{geometry:THREE.BufferGeometry;x:number;z:number} {
  const first=replacement.sources[0]?.footprint??replacement.colliders[0]?.footprint??[[0,0]];
  const x=first.reduce((sum,p)=>sum+p[0],0)/first.length,z=first.reduce((sum,p)=>sum+p[1],0)/first.length;
  const positions:number[]=[];
  const triangle=(a:Point,b:Point,c:Point,normal:Point)=>{
    const u=b.map((v,i)=>v-a[i]!) as Point,v=c.map((value,i)=>value-a[i]!) as Point;
    const dot=(u[1]*v[2]-u[2]*v[1])*normal[0]+(u[2]*v[0]-u[0]*v[2])*normal[1]+(u[0]*v[1]-u[1]*v[0])*normal[2];
    positions.push(...a,...(dot<0?c:b),...(dot<0?b:c));
  };
  for(const part of replacement.colliders){
    const low=part.underY??part.baseY,high=part.topY,ring=part.footprint;
    if(high<=low||ring.length<3)continue;
    const points=ring.map(p=>new THREE.Vector2(p[0]-x,p[1]-z));
    const at=(i:number,y:number):Point=>[points[i]!.x,y,points[i]!.y];
    for(const face of THREE.ShapeUtils.triangulateShape(points,[])){
      triangle(at(face[0]!,high),at(face[1]!,high),at(face[2]!,high),[0,1,0]);
      triangle(at(face[0]!,low),at(face[1]!,low),at(face[2]!,low),[0,-1,0]);
    }
    const area=ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length]!;return sum+p[0]*q[1]-q[0]*p[1];},0);
    for(let i=0;i<ring.length;i++){
      const j=(i+1)%ring.length,a=ring[i]!,b=ring[j]!;
      const normal:Point=[(b[1]-a[1])*Math.sign(area),0,(a[0]-b[0])*Math.sign(area)];
      triangle(at(i,low),at(j,low),at(j,high),normal);
      triangle(at(i,low),at(j,high),at(i,high),normal);
    }
  }
  const geometry=new THREE.BufferGeometry().setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
  return {geometry,x,z};
}

export class LandmarkFallbacks {
  readonly group=new THREE.Group();
  private readonly entries=new Map<string,{mesh:THREE.Mesh;material:THREE.MeshStandardMaterial}>();

  constructor(replacements:readonly LandmarkWorldReplacement[],hide:(ids:string[])=>void){
    this.group.name="landmark-fallbacks";
    for(const replacement of replacements){
      const {geometry,x,z}=geometryFor(replacement);
      const material=new THREE.MeshStandardMaterial({name:"fc:landmark-fallback",color:0xc8ae88,roughness:.92,metalness:0});
      const mesh=new THREE.Mesh(geometry,material);
      mesh.name=`landmark-fallback:${replacement.id}`;mesh.position.set(x,0,z);
      this.entries.set(replacement.id,{mesh,material});this.group.add(mesh);
      // Covers existing/future streamed source meshes, facade detail and collider fallback proxies.
      hide([...replacement.sources.map(b=>b.id),...replacement.colliders.map(b=>b.id)]);
    }
  }

  retire(id:string):void {
    const entry=this.entries.get(id);if(!entry)return;
    this.entries.delete(id);
    void retireRenderTree(entry.mesh,()=>{
      entry.mesh.dispose();entry.mesh.geometry.dispose();
      // The original material owns its GPU adapter counterpart through its dispose event.
      entry.material.dispose();
    });
  }

  dispose():void {for(const id of this.entries.keys())this.retire(id);}
}
