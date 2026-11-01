// Persistent mapped lawns on the terrain itself. Detailed turf/blades may stream out at
// 550 m; their base colour must not. Clip to actual lawn polygons, holes and paving, even
// when a small lawn lies wholly between a far terrain triangle's three 100 m vertices.
// No new draw calls or camera-dependent work: partition terrain faces once per loaded mesh.
import * as THREE from "three";
import { grassShapes } from "./grass.ts";
import { intersectLawns, subtractLawns, unionLawns, type LawnMultiPolygon, type LawnPolygon } from "./lawn-clipping.ts";
import type { PavementMask } from "./pavement.ts";

type Point = [number, number];
type Bounds = [number, number, number, number];
interface Patch { rings: Point[][]; bounds: Bounds }
const CELL = 100;
const LAND_MIN = .1;
const GREEN = new THREE.Color(0x426e30);
const cross = (a: Point,b: Point,c: Point): number => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const overlaps = (a: Bounds,b: Bounds): boolean => a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
function bounds(points: readonly (readonly number[])[]): Bounds {
  let x0=Infinity,z0=Infinity,x1=-Infinity,z1=-Infinity;
  for(const p of points){x0=Math.min(x0,p[0]!);z0=Math.min(z0,p[1]!);x1=Math.max(x1,p[0]!);z1=Math.max(z1,p[1]!);}
  return [x0,z0,x1,z1];
}
function triangulate(rings: readonly (readonly (readonly number[])[])[]): Point[][] {
  const open=rings.map(r=>r.length>1&&r[0]![0]===r.at(-1)![0]&&r[0]![1]===r.at(-1)![1]?r.slice(0,-1):r);
  const points=open.flat();
  return THREE.ShapeUtils.triangulateShape(open[0]!.map(p=>new THREE.Vector2(p[0],p[1])),open.slice(1).map(r=>r.map(p=>new THREE.Vector2(p[0],p[1]))))
    .map(t=>t.map(i=>[points[i]![0]!,points[i]![1]!] as Point));
}

export class LawnTerrain {
  private readonly buckets = new Map<string, Patch[]>();
  private readonly coverage = new WeakMap<PavementMask, Map<Patch, LawnMultiPolygon>>();
  readonly regions: Bounds[] = [];
  constructor(doc: unknown) {
    for(const lawn of grassShapes(doc)) {
      const patch: Patch={rings:lawn.rings,bounds:lawn.bbox};
      this.regions.push(patch.bounds);
      for(let x=Math.floor(lawn.bbox[0]/CELL);x<=Math.floor(lawn.bbox[2]/CELL);x++) for(let z=Math.floor(lawn.bbox[1]/CELL);z<=Math.floor(lawn.bbox[3]/CELL);z++) {
        const key=`${x},${z}`, list=this.buckets.get(key);
        if(list) list.push(patch); else this.buckets.set(key,[patch]);
      }
    }
  }
  private candidates(box: Bounds): Patch[] {
    const found=new Set<Patch>();
    for(let x=Math.floor(box[0]/CELL);x<=Math.floor(box[2]/CELL);x++) for(let z=Math.floor(box[1]/CELL);z<=Math.floor(box[3]/CELL);z++) {
      for(const p of this.buckets.get(`${x},${z}`)??[]) if(overlaps(p.bounds,box)) found.add(p);
    }
    return [...found];
  }
  private cover(patch:Patch,pavement:PavementMask):LawnMultiPolygon {
    let cache=this.coverage.get(pavement);
    if(!cache){cache=new Map();this.coverage.set(pavement,cache);}
    let cover=cache.get(patch);
    if(!cover){
      const obstacles=pavement.polygonsIn(patch.bounds).map(p=>[p.map(v=>[v[0],v[1]] as Point)]);
      cover=obstacles.length?subtractLawns([patch.rings],obstacles):[patch.rings];
      cache.set(patch,cover);
    }
    return cover;
  }
  /** `terrain` identifies original far lattice vertices, so building hulls are never painted. */
  paint(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, pavement: PavementMask, terrain: (x:number,y:number,z:number)=>boolean=()=>true): number {
    const work=this.paintSteps(geo,matrix,pavement,terrain);
    for(;;){const next=work.next();if(next.done)return next.value;}
  }
  /** Browser admission yields to input/rendering; obsolete work never changes its geometry. */
  async paintAsync(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, pavement: PavementMask, terrain: (x:number,y:number,z:number)=>boolean=()=>true, current:()=>boolean=()=>true):Promise<number> {
    const work=this.paintSteps(geo,matrix,pavement,terrain);
    let deadline=performance.now()+2;
    for(;;){
      if(!current()){work.return(0);return 0;}
      const next=work.next();if(next.done)return next.value;
      if(performance.now()>=deadline){await new Promise<void>(resolve=>setTimeout(resolve,0));deadline=performance.now()+2;}
    }
  }
  /** Pure, resumable preparation. All attribute/index replacements commit in the last step. */
  *paintSteps(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, pavement: PavementMask, terrain: (x:number,y:number,z:number)=>boolean=()=>true):Generator<void,number> {
    if(!this.regions.length || geo.userData.fcLawnTerrain) return 0;
    const position=geo.getAttribute("position"), color=geo.getAttribute("color");
    if(!position||!color) return 0;
    const attributes=Object.entries(geo.attributes);
    const added: Record<string,number[]> = Object.fromEntries(attributes.map(([name])=>[name,[]]));
    const indices: number[] = [], originalIndex=geo.index;
    const replaced=new Set<number>(), appendedGroups: Array<{start:number;count:number;materialIndex:number}>=[];
    const count=originalIndex?.count??position.count;
    const first=Math.max(0,geo.drawRange.start),end=Math.min(count,first+geo.drawRange.count);
    const vectors=[new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()];
    const inverse=matrix.clone().invert(), local=new THREE.Vector3();
    let vertices=position.count;
    for(let i=first;i+2<end;i+=3) {
      yield;
      const ids=[0,1,2].map(n=>originalIndex?originalIndex.getX(i+n):i+n);
      vectors.forEach((v,n)=>v.fromBufferAttribute(position,ids[n]!).applyMatrix4(matrix));
      if(!vectors.every(v=>Number.isFinite(v.y)&&terrain(v.x,v.y,v.z))) continue;
      const triangle=vectors.map(v=>[v.x,v.z] as Point), determinant=cross(triangle[0]!,triangle[1]!,triangle[2]!);
      if(Math.abs(determinant)<1e-6) continue;
      const box=bounds(triangle), patches=this.candidates(box);
      if(!patches.length) continue;
      const height=(p:Point):number=>(cross(triangle[1]!,triangle[2]!,p)*vectors[0]!.y+cross(triangle[2]!,triangle[0]!,p)*vectors[1]!.y+cross(triangle[0]!,triangle[1]!,p)*vectors[2]!.y)/determinant;
      const land=(polygon:Point[]):Point[]=>{
        const result:Point[]=[];
        for(let k=0;k<polygon.length;k++){
          const a=polygon[k]!,b=polygon[(k+1)%polygon.length]!,ha=height(a)-LAND_MIN,hb=height(b)-LAND_MIN;
          if(ha>=0)result.push(a);
          if((ha>0&&hb<0)||(ha<0&&hb>0)){const t=ha/(ha-hb);result.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}
        }
        return result;
      };
      const landTriangle=land(triangle);
      if(landTriangle.length<3)continue;
      const patchesOnLand: LawnMultiPolygon=[];
      for(const patch of patches) {
        yield;
        const cover=this.cover(patch,pavement);
        if(cover.length)patchesOnLand.push(...intersectLawns([[landTriangle]],cover));
      }
      if(!patchesOnLand.length)continue;
      const grass=patchesOnLand.length===1?patchesOnLand:unionLawns(patchesOnLand);
      if(!grass.length)continue;
      const neutral=subtractLawns([[triangle]],grass);
      const before=indices.length;
      const emit=(polygon:LawnPolygon,green:boolean):void=>{
        for(const face of triangulate(polygon)) {
          if(Math.abs(cross(...face as [Point,Point,Point]))<1e-6)continue;
          if(cross(...face as [Point,Point,Point])*determinant<0)face.reverse();
          for(const point of face) {
            const weights=[cross(triangle[1]!,triangle[2]!,point)/determinant,cross(triangle[2]!,triangle[0]!,point)/determinant,cross(triangle[0]!,triangle[1]!,point)/determinant];
            local.set(point[0],height(point),point[1]).applyMatrix4(inverse);
            for(const [name,attribute] of attributes)for(let c=0;c<attribute.itemSize;c++) {
              const value=name==="position"?local.getComponent(c):green&&name==="color"&&c<3?[GREEN.r,GREEN.g,GREEN.b][c]!:weights.reduce((s,w,n)=>s+w*attribute.getComponent(ids[n]!,c),0);
              added[name]!.push(value);
            }
            indices.push(vertices++);
          }
        }
      };
      // Boolean clipping removes internal split edges before triangulation, instead of
      // multiplying neutral fragments for every triangle of a complex lawn/road polygon.
      for(const polygon of grass)emit(polygon,true);
      for(const polygon of neutral)emit(polygon,false);
      if(indices.length>before) {
        replaced.add(i);
        const material=geo.groups.find(g=>i>=g.start&&i<g.start+g.count)?.materialIndex??0;
        appendedGroups.push({start:before,count:indices.length-before,materialIndex:material});
      }
    }
    if(!indices.length) return 0;
    const preparedAttributes:Array<[string,THREE.BufferAttribute]>=[];
    for(const [name,attribute] of attributes) {
      const data=new Float32Array(attribute.count*attribute.itemSize+added[name]!.length);
      for(let i=0;i<attribute.count;i++){
        if(i%8192===0)yield;
        for(let c=0;c<attribute.itemSize;c++) data[i*attribute.itemSize+c]=attribute.getComponent(i,c);
      }
      const extra=added[name]!,offset=attribute.count*attribute.itemSize;
      for(let i=0;i<extra.length;i++) {
        if(i%32768===0)yield;
        data[offset+i]=extra[i]!;
      }
      preparedAttributes.push([name,new THREE.BufferAttribute(data,attribute.itemSize)]);
    }
    const kept=end-first-replaced.size*3, index=new Uint32Array(kept+indices.length), prefix=new Uint32Array(count+1);
    let at=0;
    for(let i=0;i<count;i++) {
      if(i%12288===0)yield;
      if(i>=first&&i<end&&!replaced.has(i-(i-first)%3)) index[at++]=originalIndex?originalIndex.getX(i):i;
      prefix[i+1]=at;
    }
    for(let i=0;i<indices.length;i++) {
      if(i%32768===0)yield;
      index[kept+i]=indices[i]!;
    }
    const preparedGroups:Array<{start:number;count:number;materialIndex:number}>=[];
    if(geo.groups.length) {
      const group=(start:number,count:number,material=0):void=>{
        if(!count)return;
        const previous=preparedGroups.at(-1);
        if(previous&&previous.materialIndex===material&&previous.start+previous.count===start) previous.count+=count;
        else preparedGroups.push({start,count,materialIndex:material});
      };
      for(const g of geo.groups) group(prefix[g.start]!,prefix[g.start+g.count]!-prefix[g.start]!,g.materialIndex);
      for(let i=0;i<appendedGroups.length;i++) {
        if(i%4096===0)yield;
        const g=appendedGroups[i]!;group(kept+g.start,g.count,g.materialIndex);
      }
    }
    const preparedPosition=preparedAttributes.find(([name])=>name==="position")![1];
    const box=new THREE.Box3(),sphere=new THREE.Sphere(),point=new THREE.Vector3();
    for(let i=0;i<preparedPosition.count;i++) {
      if(i%8192===0)yield;
      box.expandByPoint(point.fromBufferAttribute(preparedPosition,i));
    }
    box.getCenter(sphere.center);let radiusSquared=0;
    for(let i=0;i<preparedPosition.count;i++) {
      if(i%8192===0)yield;
      radiusSquared=Math.max(radiusSquared,sphere.center.distanceToSquared(point.fromBufferAttribute(preparedPosition,i)));
    }
    sphere.radius=Math.sqrt(radiusSquared);
    yield;
    for(const [name,attribute] of preparedAttributes)geo.setAttribute(name,attribute);
    geo.setIndex(new THREE.BufferAttribute(index,1));geo.groups=preparedGroups;
    geo.setDrawRange(0,Infinity);
    geo.boundingBox=box;geo.boundingSphere=sphere;
    geo.userData.fcLawnTerrain=true;
    return (kept+indices.length-count)/3;
  }
}
