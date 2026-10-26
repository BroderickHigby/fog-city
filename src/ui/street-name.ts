import type { RoadGraph } from "../render/types.ts";

const CELL = 128;
const REACH = 45;
interface Segment { name:string; id:string; ax:number; az:number; bx:number; bz:number }
const indexes = new WeakMap<RoadGraph, Map<string, Segment[]>>();
const cellKey = (x:number,z:number):string => `${Math.floor(x/CELL)},${Math.floor(z/CELL)}`;

/** A small presentation index; labels use the source street names without touching routing. */
export function streetNameAt(roads:RoadGraph|null,x:number,z:number):string|undefined {
  if(!roads||!Number.isFinite(x+z))return;
  let index=indexes.get(roads);
  if(!index){
    index=new Map();
    for(const edge of roads.edges){
      if(!edge.name?.trim()||edge.kind==="freeway"||edge.kind==="ramp")continue;
      for(let i=1;i<edge.points.length;i++){
        const a=edge.points[i-1]!,b=edge.points[i]!;
        if(!Number.isFinite(a[0]+a[1]+b[0]+b[1]))continue;
        const segment={name:edge.name,id:`${edge.id}:${i}`,ax:a[0],az:a[1],bx:b[0],bz:b[1]};
        for(let cx=Math.floor((Math.min(a[0],b[0])-REACH)/CELL);cx<=Math.floor((Math.max(a[0],b[0])+REACH)/CELL);cx++){
          for(let cz=Math.floor((Math.min(a[1],b[1])-REACH)/CELL);cz<=Math.floor((Math.max(a[1],b[1])+REACH)/CELL);cz++){
            const key=`${cx},${cz}`,list=index.get(key);
            if(list)list.push(segment);else index.set(key,[segment]);
          }
        }
      }
    }
    indexes.set(roads,index);
  }
  let result:Segment|undefined,best=REACH*REACH;
  for(const s of index.get(cellKey(x,z))??[]){
    const dx=s.bx-s.ax,dz=s.bz-s.az;
    const t=Math.max(0,Math.min(1,((x-s.ax)*dx+(z-s.az)*dz)/(dx*dx+dz*dz||1)));
    const d=(x-s.ax-t*dx)**2+(z-s.az-t*dz)**2;
    if(d<best||d===best&&(!result||s.id<result.id)){result=s;best=d;}
  }
  return result?.name;
}
