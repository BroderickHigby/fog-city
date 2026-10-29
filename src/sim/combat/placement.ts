import { PROTECTED_AREAS } from "../../content/places.ts";
import { toLocal } from "../../geo/project.ts";
import { sortedIds,type SimState } from "../contract.ts";
import { playerPose } from "../ride.ts";
import { carBox } from "../car.ts";
import { AGENT_SPEC,ROBOTAXI_BODY,agentsOf } from "../agents.ts";
import { circleHitsWall,onWater } from "../boundary.ts";
import { boxDistance } from "../dodge.ts";
import { clamp,dcos,dsin,sq } from "../dmath.ts";
import { areaKey,projectOnPath } from "../roads.ts";
import { circleBlockedBand,circleTouchesPolygon,meshGroundHeight,meshGroundRange,cellKey,type Heightfield,type World } from "../world.ts";
import type { CombatActor,CombatContext,CombatInput,CombatPlayer,Vec3 } from "../combat-contract.ts";

export const COMBAT_PLACEMENT={lotRadius:3,lotRange:150,gridM:12,maxLotsPerPlayer:16,bodyGap:.75,maxRelief:.35} as const;
const protectedRings=PROTECTED_AREAS.map(area=>area.polygon.map(([lat,lon])=>{const p=toLocal(lat,lon);return [p.x,p.z] as const;}));
const finite=(p:Vec3)=>[p.x,p.y,p.z].every(Number.isFinite);
interface Bounds {minX:number;minZ:number;maxX:number;maxZ:number}
function fieldsNear(world:World,b:Bounds):Heightfield[]{
  const found=new Map<string,Heightfield>();
  for(let x=Math.floor(b.minX/250);x<=Math.floor(b.maxX/250);x++)for(let z=Math.floor(b.minZ/250);z<=Math.floor(b.maxZ/250);z++)for(const tile of world.groundIndex.get(cellKey(x,z))??[]){const g=tile.ground;if(g&&g.x0<=b.maxX&&g.z0<=b.maxZ&&g.x0+(g.nx-1)*g.cellSizeM>=b.minX&&g.z0+(g.nz-1)*g.cellSizeM>=b.minZ)found.set(tile.tileId,g);}
  return [...found.keys()].sort().map(id=>found.get(id)!);
}
/** Require full loaded coverage, including narrow gaps; a missing tile is not sea-level land. */
function covered(fields:readonly Heightfield[],b:Bounds):boolean {
  const xs=[b.minX,b.maxX],zs=[b.minZ,b.maxZ];
  for(const g of fields){xs.push(clamp(g.x0,b.minX,b.maxX),clamp(g.x0+(g.nx-1)*g.cellSizeM,b.minX,b.maxX));zs.push(clamp(g.z0,b.minZ,b.maxZ),clamp(g.z0+(g.nz-1)*g.cellSizeM,b.minZ,b.maxZ));}
  const xx=[...new Set(xs)].sort((a,b)=>a-b),zz=[...new Set(zs)].sort((a,b)=>a-b);
  for(let i=1;i<xx.length;i++)for(let j=1;j<zz.length;j++){
    const x=(xx[i-1]!+xx[i]!)/2,z=(zz[j-1]!+zz[j]!)/2;
    if(!fields.some(g=>x>=g.x0&&z>=g.z0&&x<=g.x0+(g.nx-1)*g.cellSizeM&&z<=g.z0+(g.nz-1)*g.cellSizeM))return false;
  }
  return fields.length>0;
}
/** Inspect every intersected nearest-sample water cell, not a few perimeter probes. */
function dry(fields:readonly Heightfield[],b:Bounds,x:number,z:number,r:number):boolean {
  for(const g of fields){if(!g.water)continue;const cell=g.cellSizeM;
    const ix0=Math.max(0,Math.floor((b.minX-g.x0)/cell-.5)),ix1=Math.min(g.nx-1,Math.ceil((b.maxX-g.x0)/cell+.5)),iz0=Math.max(0,Math.floor((b.minZ-g.z0)/cell-.5)),iz1=Math.min(g.nz-1,Math.ceil((b.maxZ-g.z0)/cell+.5));
    for(let i=ix0;i<=ix1;i++)for(let j=iz0;j<=iz1;j++)if(g.water[j*g.nx+i]===1){
      const minX=Math.max(g.x0,g.x0+(i-.5)*cell),maxX=Math.min(g.x0+(g.nx-1)*cell,g.x0+(i+.5)*cell),minZ=Math.max(g.z0,g.z0+(j-.5)*cell),maxZ=Math.min(g.z0+(g.nz-1)*cell,g.z0+(j+.5)*cell);
      const dx=x-clamp(x,minX,maxX),dz=z-clamp(z,minZ,maxZ);if(dx*dx+dz*dz<=r*r)return false;
    }
  }return true;
}
const roadPadding=new WeakMap<NonNullable<World["roads"]>,number>();
function roadClear(world:World,x:number,z:number,r:number):boolean {
  const graph=world.roads;if(!graph)return true;
  let half=roadPadding.get(graph);if(half===undefined){half=graph.edges.reduce((value,edge)=>Math.max(value,edge.widthM/2),0);roadPadding.set(graph,half);}
  const indices=new Set<number>(),pad=r+half+.5;
  for(let ax=Math.floor((x-pad)/250);ax<=Math.floor((x+pad)/250);ax++)for(let az=Math.floor((z-pad)/250);az<=Math.floor((z+pad)/250);az++){
    const index=graph.areaIndex.get(areaKey(ax,az)),area=index===undefined?undefined:graph.areas[index];
    for(const piece of area?.drive??[])indices.add(piece.edge);for(const piece of area?.walk??[])indices.add(piece.edge);
  }
  if(!indices.size&&graph.areas.length)return true;
  const edges=indices.size?[...indices].sort((a,b)=>a-b).map(index=>graph.edges[index]!):graph.edges;
  return !edges.some(edge=>(edge.drivable||edge.walkable)&&projectOnPath(edge.center,x,z).dist<=edge.widthM/2+r+.5);
}
interface Circle {x:number;z:number;radius:number}
interface Hull {x:number;z:number;heading:number;hl:number;hw:number}
export interface CombatPlacementOptions {actors?:readonly CombatActor[];includeLots?:boolean}
export type CombatPlacementFields=Pick<CombatContext,"safeLots"|"devicePlacementAllowed"|"aimPlacement"|"deviceEffectAllowed">;
/** Context-only factory over actual accepted bodies and immutable physical map data. */
export function createCombatPlacement(world:World,state:Readonly<SimState>,options:CombatPlacementOptions={}):CombatPlacementFields {
  const circles:Circle[]=[],effectCircles:Circle[]=[],hulls:Hull[]=[],poses=new Map<string,ReturnType<typeof playerPose>>();
  for(const id of sortedIds(state.players)){const player=state.players[id]!,pose=playerPose(player);poses.set(id,{...pose});hulls.push(carBox(player.car));if(player.mode==="foot")circles.push({...pose,radius:.35});}
  for(const actor of agentsOf(state)){
    if(actor.kind==="robotaxi")hulls.push({x:actor.x,z:actor.z,heading:actor.heading,hl:actor.halfLength??ROBOTAXI_BODY.halfLength,hw:actor.halfWidth??ROBOTAXI_BODY.halfWidth});
    else if(actor.kind==="person"){const circle={x:actor.x,z:actor.z,radius:actor.radius??AGENT_SPEC.person.radius};circles.push(circle);effectCircles.push(circle);}
  }
  for(const actor of options.actors??[])if(actor.kind==="person"||actor.kind==="animal"||actor.protected===true){const circle={x:actor.x,z:actor.z,radius:actor.radius};circles.push(circle);effectCircles.push(circle);}
  const allowed=(point:Vec3,clearance:number):boolean=>{
    if(state.version<27||!finite(point)||!Number.isFinite(clearance)||clearance<.05||clearance>20)return false;
    const r=clearance,b={minX:point.x-r,minZ:point.z-r,maxX:point.x+r,maxZ:point.z+r},fields=fieldsNear(world,b),y=meshGroundHeight(world,point.x,point.z);
    if(!covered(fields,b)||!dry(fields,b,point.x,point.z,r)||world.walls&&onWater(world.walls.shore,point.x,point.z)||Math.abs(point.y-y)>.4)return false;
    if(protectedRings.some(ring=>circleTouchesPolygon(point.x,point.z,r*r,ring)))return false;
    const terrain=meshGroundRange(world,b.minX,b.minZ,b.maxX,b.maxZ);
    if(!Number.isFinite(terrain.min)||!Number.isFinite(terrain.max)||terrain.max-terrain.min>COMBAT_PLACEMENT.maxRelief)return false;
    if(circleBlockedBand(world,point.x,point.z,r,y+.01,y+2.5)||circleHitsWall(world.walls,point.x,point.z,r)||!roadClear(world,point.x,point.z,r))return false;
    if(circles.some(body=>sq(body.x-point.x)+sq(body.z-point.z)<=sq(body.radius+r+COMBAT_PLACEMENT.bodyGap)))return false;
    return !hulls.some(box=>boxDistance(point.x,point.z,box.x,box.z,dsin(box.heading),-dcos(box.heading),box.hl,box.hw)<=r+COMBAT_PLACEMENT.bodyGap);
  };
  const safeLots:(Vec3&{id:string;radius:number})[]=[];
  const include=options.includeLots??((state.ext.combat?.pauseUntil??0)<=state.tick&&sortedIds(state.ext.progression?.players??{}).some(id=>state.ext.progression!.players[id]!.pendingStreak?.kind==="tensor"));
  if(state.version>=27&&include){
    const unique=new Map<string,Vec3&{id:string;radius:number}>();
    for(const id of sortedIds(state.players)){
      const pose=poses.get(id)!,candidates:{x:number;z:number;key:string;d:number}[]=[],grid=COMBAT_PLACEMENT.gridM,range=COMBAT_PLACEMENT.lotRange;
      for(let ix=Math.ceil((pose.x-range)/grid);ix<=Math.floor((pose.x+range)/grid);ix++)for(let iz=Math.ceil((pose.z-range)/grid);iz<=Math.floor((pose.z+range)/grid);iz++){
        const x=ix*grid,z=iz*grid,d=sq(x-pose.x)+sq(z-pose.z);if(d<=range*range)candidates.push({x,z,key:`lot:${ix}:${iz}`,d});
      }
      candidates.sort((a,b)=>a.d-b.d||(a.key<b.key?-1:a.key>b.key?1:0));let found=0;
      for(const candidate of candidates){const point={x:candidate.x,y:meshGroundHeight(world,candidate.x,candidate.z),z:candidate.z};if(!allowed(point,COMBAT_PLACEMENT.lotRadius))continue;unique.set(candidate.key,{...point,id:candidate.key,radius:COMBAT_PLACEMENT.lotRadius});if(++found>=COMBAT_PLACEMENT.maxLotsPerPlayer)break;}
    }
    for(const key of [...unique.keys()].sort())safeLots.push(unique.get(key)!);
  }
  return {safeLots,devicePlacementAllowed:allowed,deviceEffectAllowed:(point,clearance)=>{
    if(!finite(point)||!Number.isFinite(clearance)||clearance<0||clearance>20)return false;
    const hull=hulls.find(body=>sq(body.x-point.x)+sq(body.z-point.z)<.01),radius=hull?Math.max(clearance,hull.hl+hull.hw):clearance;
    return !protectedRings.some(ring=>circleTouchesPolygon(point.x,point.z,radius*radius,ring))&&!effectCircles.some(body=>sq(body.x-point.x)+sq(body.z-point.z)<=sq(body.radius+radius+COMBAT_PLACEMENT.bodyGap));
  },aimPlacement:(player:Readonly<CombatPlayer>,input:Readonly<CombatInput>,range:number)=>{
    const pose=poses.get(player.id);if(state.version<27||!pose||!Number.isFinite(range)||range<.1||range>200)return null;
    const yaw=Number.isFinite(input.aimYaw)?input.aimYaw!:pose.heading,pitch=clamp(Number.isFinite(input.aimPitch)?input.aimPitch!:0,-1.2,1.2),fx=dsin(yaw),fz=-dcos(yaw),slope=dsin(pitch)/dcos(pitch);
    let distance=range;
    for(let at=Math.min(1,range);at<range;at+=1){const x=pose.x+fx*at,z=pose.z+fz*at;if(pose.y+1.4+slope*at<=meshGroundHeight(world,x,z)+.1){distance=at;break;}}
    const x=pose.x+fx*distance,z=pose.z+fz*distance,point={x,y:meshGroundHeight(world,x,z),z};
    return finite(point)&&covered(fieldsNear(world,{minX:x-.1,minZ:z-.1,maxX:x+.1,maxZ:z+.1}),{minX:x-.1,minZ:z-.1,maxX:x+.1,maxZ:z+.1})?point:null;
  }};
}
