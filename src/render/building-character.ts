// Stable per-building identity, read from the actual loaded wall vertices, plus a bounded
// street-distance batch of architectural relief. Nothing here changes collision or world data.
import * as THREE from "three";
import type { BuildingCollider } from "../sim/world.ts";
import { hashString, unit } from "./hash.ts";
import { MeshBuilder, facadeGrid, srgb, type FacadeCode, type MeshData, type RGB } from "./tile-geometry.ts";
import { geometryFromMeshData } from "./props.ts";
import { windowProfileRect } from "./building-window-profile.ts";
import type { GroundFn } from "./types.ts";

/** Historic stone, deco office, brick/utility, low-rise residential, curtain wall. */
export type BuildingFamily = 0 | 1 | 2 | 3 | 4;
export interface CharacterWall {
  ax:number; az:number; bx:number; bz:number;
  nx:number; nz:number; u0:number; u1:number;
  bottom:number; top:number; baseY:number;
}
export interface BuildingCharacter {
  id:string; seed:number; family:BuildingFamily; baseY:number; height:number;
  facade:FacadeCode; wall:RGB; walls:CharacterWall[];
  footprint:ReadonlyArray<readonly[number,number]>;
  minX:number;maxX:number;minZ:number;maxZ:number;
  underY?:number;
}

/** Classify only from the available visual record; unknown dates remain unknown. */
export function buildingFamily(height:number,glazing:number,year:number|null,color:Readonly<RGB>):BuildingFamily {
  if(glazing<.2)return 2;
  if(height<20&&glazing<.46)return 3;
  if(year!==null&&year<1945)return height>32?1:0;
  if(glazing>=.7||height>=65)return 4;
  if(glazing<.4&&color[0]>color[1]*1.15)return 2;
  return 1;
}

const position=new THREE.Vector3();
/** Attach `_building`=[seed, world baseY, height, family] without rewriting the shipped GLB. */
export function characterizeBuildings(geo:THREE.BufferGeometry,matrix:THREE.Matrix4,colliders:ReadonlyMap<string,BuildingCollider>):BuildingCharacter[] {
  const ranges=geo.userData.fcBuildings as Array<[string,number,number]>|undefined;
  const index=geo.getIndex(),pos=geo.getAttribute("position"),uv=geo.getAttribute("uv"),facade=geo.getAttribute("_facade"),color=geo.getAttribute("color");
  if(!ranges||!index||!pos||!uv||!facade)return [];
  const values=new Float32Array(pos.count*4);
  for(let i=0;i<pos.count;i++){values[i*4]=-1;values[i*4+3]=-1;}
  const out:BuildingCharacter[]=[];
  for(const [id,first,count]of ranges){
    if(typeof id!=="string"||!Number.isInteger(first)||!Number.isInteger(count)||first<0||count<=0)continue;
    const end=Math.min(first+count,index.count),collider=colliders.get(id);
    const walls=new Map<string,CharacterWall>();
    let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,minY=Infinity,maxY=-Infinity;
    let baseY=collider?.baseY??0,code:FacadeCode|undefined,wall:RGB=[.55,.52,.47];
    const worldVertex=(i:number):[number,number,number]=>{position.fromBufferAttribute(pos,i).applyMatrix4(matrix);return[position.x,position.y,position.z];};
    for(let at=first;at+2<end;at+=3){
      const ids=[index.getX(at),index.getX(at+1),index.getX(at+2)];
      if(ids.some(i=>i<0||i>=pos.count))continue;
      const points=ids.map(worldVertex);
      for(const p of points){minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);minZ=Math.min(minZ,p[2]);maxZ=Math.max(maxZ,p[2]);minY=Math.min(minY,p[1]);maxY=Math.max(maxY,p[1]);}
      const i0=ids[0]!;
      if(facade.getW(i0)>=.5)continue;
      if(!code){
        const date=facade.getZ(i0);code={storeyM:facade.getX(i0)*8,glazing:facade.getY(i0),year:date>.01?1840+date*190:null};
        baseY=points[0]![1]-uv.getY(i0);
        if(color)wall=[color.getX(i0),color.getY(i0),color.getZ(i0)];
      }
      const p=points[0]!,q=points[1]!,r=points[2]!;
      const ex=q[0]-p[0],ey=q[1]-p[1],ez=q[2]-p[2],fx=r[0]-p[0],fy=r[1]-p[1],fz=r[2]-p[2];
      let nx=ey*fz-ez*fy,nz=ex*fy-ey*fx;
      const ny=ez*fx-ex*fz,nl=Math.hypot(nx,ny,nz);
      if(nl<1e-8||Math.abs(ny)/nl>.02)continue;
      const order=[0,1,2].sort((a,b)=>uv.getX(ids[a]!)-uv.getX(ids[b]!));
      const lo=order[0]!,hi=order[2]!,a=points[lo]!,b=points[hi]!;
      const u0=uv.getX(ids[lo]!),u1=uv.getX(ids[hi]!);
      if(u1-u0<.25||Math.hypot(b[0]-a[0],b[2]-a[2])<.25)continue;
      const len=Math.hypot(nx,nz);nx/=len;nz/=len;
      const floor=Math.min(...points.map(v=>v[1])),top=Math.max(...points.map(v=>v[1]));
      const wallBase=p[1]-uv.getY(i0);
      const key=[a[0],a[2],b[0],b[2],wallBase].map(n=>n.toFixed(2)).join(":");
      const old=walls.get(key);
      if(old){old.bottom=Math.min(old.bottom,floor);old.top=Math.max(old.top,top);}
      else walls.set(key,{ax:a[0],az:a[2],bx:b[0],bz:b[2],nx,nz,u0,u1,bottom:floor,top,baseY:wallBase});
    }
    if(!code||!Number.isFinite(baseY)||!Number.isFinite(maxY)||maxY-baseY<=.5)continue;
    const height=collider?collider.topY-baseY:maxY-baseY;
    const seed=unit(hashString(id)),family=buildingFamily(height,code.glazing,code.year,wall);
    for(let at=first;at<end;at++){const i=index.getX(at);if(i>=pos.count)continue;values[i*4]=seed;values[i*4+1]=baseY;values[i*4+2]=height;values[i*4+3]=family;}
    out.push({id,seed,family,baseY,height,facade:code,wall,walls:[...walls.values()],footprint:collider?.footprint??[],minX,maxX,minZ,maxZ,...(collider?.underY!==undefined?{underY:collider.underY}:{})});
  }
  geo.setAttribute("_building",new THREE.BufferAttribute(values,4));
  return out;
}

export const BUILDING_DETAIL_RADIUS=140;
export const BUILDING_DETAIL_COUNT=36;
export const BUILDING_DETAIL_TRIANGLES=90000;
const TRIM=srgb(0xd5cbb7),METAL=srgb(0x485457);
function tint(c:Readonly<RGB>,scale:number):RGB{return[c[0]*scale,c[1]*scale,c[2]*scale];}

/** A closed box in a wall's tangent/outward coordinate frame. */
function box(mb:MeshBuilder,x:number,y:number,z:number,width:number,height:number,depth:number,tx:number,tz:number,color:RGB):void{
  const nx=-tz,nz=tx;
  const vertex=(a:number,b:number,c:number):[number,number,number]=>[x+tx*a+nx*c,y+b,z+tz*a+nz*c];
  const hw=width/2,hh=height/2,hd=depth/2;
  const faces:[number,number,number,number[][]][]=[
    [nx,0,nz,[[-hw,-hh,hd],[hw,-hh,hd],[hw,hh,hd],[-hw,hh,hd]]],
    [-nx,0,-nz,[[hw,-hh,-hd],[-hw,-hh,-hd],[-hw,hh,-hd],[hw,hh,-hd]]],
    [tx,0,tz,[[hw,-hh,hd],[hw,-hh,-hd],[hw,hh,-hd],[hw,hh,hd]]],
    [-tx,0,-tz,[[-hw,-hh,-hd],[-hw,-hh,hd],[-hw,hh,hd],[-hw,hh,-hd]]],
    [0,1,0,[[-hw,hh,hd],[hw,hh,hd],[hw,hh,-hd],[-hw,hh,-hd]]],
    [0,-1,0,[[-hw,-hh,-hd],[hw,-hh,-hd],[hw,-hh,hd],[-hw,-hh,hd]]],
  ];
  for(const[fx,fy,fz,corners]of faces){const ids=corners.map(v=>{const p=vertex(v[0]!,v[1]!,v[2]!);return mb.v(...p,fx,fy,fz,color);});mb.triFacing(ids[0]!,ids[1]!,ids[2]!,fx,fy,fz);mb.triFacing(ids[0]!,ids[2]!,ids[3]!,fx,fy,fz);}
}
function inside(fp:ReadonlyArray<readonly[number,number]>,x:number,z:number):boolean{
  let hit=false;for(let i=0,j=fp.length-1;i<fp.length;j=i++){const a=fp[i]!,b=fp[j]!;if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;
}
/** Corners alone can straddle a courtyard notch; every box edge must also stay in the roof. */
function roofContains(fp:ReadonlyArray<readonly[number,number]>,x:number,z:number,w:number,d:number):boolean{
  const corners:[[number,number],[number,number],[number,number],[number,number]]=[[x-w/2,z-d/2],[x+w/2,z-d/2],[x+w/2,z+d/2],[x-w/2,z+d/2]];
  if(!corners.every(p=>inside(fp,p[0],p[1])))return false;
  const cross=(a:readonly[number,number],b:readonly[number,number],p:readonly[number,number])=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
  for(let i=0;i<4;i++)for(let j=0;j<fp.length;j++){
    const a=corners[i]!,b=corners[(i+1)%4]!,c=fp[j]!,e=fp[(j+1)%fp.length]!;
    if(Math.max(a[0],b[0])<Math.min(c[0],e[0])||Math.max(c[0],e[0])<Math.min(a[0],b[0])||Math.max(a[1],b[1])<Math.min(c[1],e[1])||Math.max(c[1],e[1])<Math.min(a[1],b[1]))continue;
    if(cross(a,b,c)*cross(a,b,e)<=0&&cross(c,e,a)*cross(c,e,b)<=0)return false;
  }
  return true;
}

/** Physical relief follows the loaded UV grid rather than inventing a second window layout. */
export function addBuildingCharacter(mb:MeshBuilder,b:Readonly<BuildingCharacter>,limit=BUILDING_DETAIL_TRIANGLES,ground?:GroundFn):void{
  if(b.underY!==undefined||b.height<3.5||!b.walls.length)return;
  const stop=Math.min(limit,mb.indexCount/3+4800),grid=facadeGrid(b.facade.storeyM,b.facade.glazing);
  let win=grid.win;
  if(b.facade.year!==null&&b.facade.year<1910.3)win=[.5+(win[0]-.5)*.78,.5+(win[1]-.5)*.78,win[2]*.8,Math.min(.95,win[3]+.06)];
  win=windowProfileRect(win,b.family,b.seed);
  const stone=b.family===2?tint(b.wall,1.26):b.family===3?TRIM:tint(b.wall,1.3);
  const accent=b.family===4?METAL:tint(stone,.82+b.seed*.25);
  const walls=[...b.walls].sort((a,c)=>Math.hypot(c.bx-c.ax,c.bz-c.az)-Math.hypot(a.bx-a.ax,a.bz-a.az)).slice(0,6);
  const add=(w:CharacterWall,along:number,y:number,width:number,height:number,protrusion:number,col:RGB):void=>{
    if(width<=.01||height<=.01||mb.indexCount/3+12>stop||y-height/2<b.baseY+3)return;
    const len=Math.hypot(w.bx-w.ax,w.bz-w.az),tx=(w.bx-w.ax)/len,tz=(w.bz-w.az)/len;
    if(ground){
      const low=y-height/2;
      for(const offset of[-width/2,0,width/2]){
        const gx=w.ax+tx*(along+offset)+w.nx*.15,gz=w.az+tz*(along+offset)+w.nz*.15;
        if(low<ground(gx,gz)+3.25)return;
      }
    }
    // The box extends at most 15 cm beyond the wall; low-level navigation sees no new body.
    const offset=protrusion/2-.012;
    box(mb,w.ax+tx*along+w.nx*offset,y,w.az+tz*along+w.nz*offset,width,height,protrusion,tx,tz,col);
  };
  for(const w of walls){
    const len=Math.hypot(w.bx-w.ax,w.bz-w.az);
    if(len<2||w.top-w.bottom<3||Math.abs(w.baseY-b.baseY)>.5)continue;
    const top=Math.min(w.top,b.baseY+b.height);
    // Cornices, friezes and corner piers give buildings distinct silhouettes and depth.
    add(w,len/2,top-.2,len+.12,b.family===1?.36:.22,.15,stone);
    if(b.family!==4)add(w,len/2,top-.5,len,.12,.1,accent);
    if(b.family===0||b.family===1||b.family===3){
      for(const x of [.22,len-.22])add(w,x,(Math.max(w.bottom,b.baseY+3)+top-.65)/2,.2,Math.max(0,top-.65-Math.max(w.bottom,b.baseY+3)),.1,stone);
    }
    if(b.family===1&&b.height>12){for(let floor=2;floor<Math.min(9,b.height/grid.floorH);floor+=2)add(w,len/2,b.baseY+floor*grid.floorH,len,.14,.09,stone);}
    if(b.facade.glazing<.04)continue;
    const first=Math.ceil(w.u0/grid.colW),last=Math.floor(w.u1/grid.colW);
    for(let cell=first;cell<=last;cell++){
      const center=(cell+.5)*grid.colW;
      const along=(center-w.u0)/(w.u1-w.u0)*len;
      if(along<.6||along>len-.6||cell-first>=18)continue;
      const ww=(win[1]-win[0])*grid.colW*len/(w.u1-w.u0);
      for(let floor=0;floor<Math.min(8,Math.ceil(b.height/grid.floorH));floor++){
        const y0=b.baseY+(floor+win[2])*grid.floorH,y1=b.baseY+(floor+win[3])*grid.floorH;
        if(y0<Math.max(b.baseY+3,w.bottom+.15,b.baseY+grid.shopH)||y1>top-.8)continue;
        if(b.family===4){add(w,along,y0+(y1-y0)/2,.055,y1-y0+.15,.055,accent);continue;}
        add(w,along,y0-.045,ww+.2,.1,.14,stone);
        add(w,along,y1+.045,ww+.16,b.family===3?.17:.1,.12,stone);
        if((b.family===0||b.family===3)&&floor%2===0)for(const side of[-1,1])add(w,along+side*(ww/2+.035),(y0+y1)/2,.075,y1-y0,.06,accent);
      }
    }
    // A shallow high entrance canopy marks one facade without creating a ground obstacle.
    if(w===walls[0]&&b.family!==4&&b.height>6&&len>7){add(w,len*(.35+b.seed*.3),b.baseY+3.35,Math.min(3.2,len*.28),.18,.15,accent);}
  }
  // A small rooftop service stack, only where its complete footprint fits inside the real roof.
  const fp=b.footprint;
  if(fp.length>=3&&b.height>8){
    const w=1.2+b.seed*.8,d=.9+b.seed*.6,spots=[[.24,.26],[.74,.24],[.73,.74],[.26,.72]];
    const first=Math.floor(b.seed*spots.length),spot=Array.from({length:spots.length},(_,i)=>spots[(first+i)%spots.length]!).map(([u,v])=>({x:b.minX+(b.maxX-b.minX)*u!,z:b.minZ+(b.maxZ-b.minZ)*v!})).find(p=>roofContains(fp,p.x,p.z,w+.08,d+.08));
    if(spot&&mb.indexCount/3+36<=stop){
      const{x,z}=spot;
      const y=b.baseY+b.height,h=.55+b.seed*.5;
      box(mb,x,y+h/2,z,w,h,d,1,0,METAL);
      box(mb,x,y+h+.045,z,w+.08,.09,d+.08,1,0,accent);
      box(mb,x-w*.25,y+h+.22,z,.16,.36,.16,1,0,METAL);
    }
  }
}

const FAMILY_NAMES=["masonry","deco","brick","residential","modern"] as const;
export interface BuildingDetailStats {buildings:number;triangles:number;drawCalls:number;pending:boolean;registered:number;styles:Record<typeof FAMILY_NAMES[number],number>}
/** One material / one draw call, nearest 36 buildings only, incrementally rebuilt on movement. */
export class BuildingDetailLayer {
  private readonly tiles=new Map<string,readonly BuildingCharacter[]>();
  private readonly material=new THREE.MeshStandardMaterial({name:"building-character-relief",vertexColors:true,roughness:.82,metalness:.06});
  private readonly mesh:THREE.Mesh;
  private readonly hidden=new Set<string>();
  private dirty=true;private key="";private x=Infinity;private z=Infinity;
  private pending:Generator<void,{mesh:MeshData;count:number;styles:number[]},void>|null=null;private count=0;private styles=[0,0,0,0,0];
  private readonly parent:THREE.Object3D;
  private readonly ground:GroundFn|undefined;
  constructor(parent:THREE.Object3D,ground?:GroundFn){this.parent=parent;this.ground=ground;this.mesh=new THREE.Mesh(new THREE.BufferGeometry(),this.material);this.mesh.name="building-character-details";this.mesh.receiveShadow=true;}
  register(tile:string,buildings:readonly BuildingCharacter[]):void{this.tiles.set(tile,buildings);this.dirty=true;}
  unregister(tile:string):void{if(this.tiles.delete(tile)){this.clear();this.dirty=true;}}
  hide(ids:Iterable<string>):void{for(const id of ids)this.hidden.add(id);this.clear();this.dirty=true;}
  private clear():void{this.pending=null;this.key="";this.count=0;this.styles=[0,0,0,0,0];this.mesh.removeFromParent();this.mesh.geometry.dispose();this.mesh.geometry=new THREE.BufferGeometry();}
  update(x:number,z:number,budgetMs=1):void{
    if(this.dirty||Math.hypot(x-this.x,z-this.z)>20){
      this.dirty=false;this.x=x;this.z=z;
      const nearest=[...this.tiles.values()].flat().filter(b=>!this.hidden.has(b.id)&&b.underY===undefined).map(b=>({b,d:Math.hypot(Math.max(b.minX-x,0,x-b.maxX),Math.max(b.minZ-z,0,z-b.maxZ))})).filter(v=>v.d<BUILDING_DETAIL_RADIUS).sort((a,b)=>a.d-b.d||(a.b.id<b.b.id?-1:a.b.id>b.b.id?1:0)).slice(0,BUILDING_DETAIL_COUNT).map(v=>v.b);
      const key=nearest.map(b=>b.id).sort().join("|");
      if(key!==this.key){this.key=key;const ground=this.ground;this.pending=(function*(){const mb=new MeshBuilder(),styles=[0,0,0,0,0];let count=0;for(const b of nearest){const before=mb.indexCount;mb.beginRange(b.id);addBuildingCharacter(mb,b,BUILDING_DETAIL_TRIANGLES,ground);mb.endRange();if(mb.indexCount>before){count++;styles[b.family]=styles[b.family]!+1;}yield;}return{mesh:mb.build(),count,styles};})();}
    }
    const start=performance.now();
    while(this.pending){const next=this.pending.next();if(next.done){this.mesh.geometry.dispose();this.mesh.geometry=geometryFromMeshData(next.value.mesh);this.count=next.value.count;this.styles=next.value.styles;this.pending=null;if(next.value.mesh.indices.length)this.parent.add(this.mesh);else this.mesh.removeFromParent();break;}if(performance.now()-start>=budgetMs)break;}
  }
  settled():boolean{return !this.dirty&&!this.pending;}
  stats():BuildingDetailStats{const triangles=(this.mesh.geometry.getIndex()?.count??0)/3;return{buildings:this.count,triangles,drawCalls:triangles>0?1:0,pending:!this.settled(),registered:[...this.tiles.values()].reduce((n,b)=>n+b.length,0),styles:Object.fromEntries(FAMILY_NAMES.map((name,i)=>[name,this.styles[i]!])) as BuildingDetailStats["styles"]};}
  dispose():void{this.tiles.clear();this.clear();this.mesh.geometry.dispose();this.material.dispose();}
}
