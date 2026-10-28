// Full vehicle hulls and relative sweeps. This module owns geometry only: no state, impulses,
// world pushes or route decisions. Sorted spatial candidates keep the normal tick local.
import type { Box } from "./collide.ts";
import { dcos, dsin, wrapAngle } from "./dmath.ts";

export interface VehicleHull extends Box { key: string; y: number; height: number }
export interface VehicleMotion { before: VehicleHull; after: VehicleHull }
export interface HullContact { gap: number; nx: number; nz: number; x: number; z: number }
export interface HullSweep extends HullContact { t: number }
/** A millimetre between solid hulls absorbs the narrow phase's floating point tolerance. */
export const VEHICLE_SKIN = .001;
const diagonal=(hl:number,hw:number):number=>Math.sqrt(hl*hl+hw*hw);

export function hullAt(m: Readonly<VehicleMotion>, t: number): VehicleHull {
  const a = m.before, b = m.after;
  return { ...b, x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t,
    z: a.z + (b.z-a.z)*t, heading: a.heading + wrapAngle(b.heading-a.heading)*t };
}
export function hullBandsMeet(a: Readonly<VehicleHull>, b: Readonly<VehicleHull>): boolean {
  return a.y < b.y+b.height && b.y < a.y+a.height;
}

/** Largest separating-axis gap, negative inside; its normal points from b toward a. */
export function hullContact(a: Readonly<VehicleHull>, b: Readonly<VehicleHull>): HullContact {
  const ax=dsin(a.heading), az=-dcos(a.heading), bx=dsin(b.heading), bz=-dcos(b.heading);
  let gap=-Infinity, nx=0, nz=0;
  const axis=(x:number,z:number):void=>{
    const extent=a.hl*Math.abs(ax*x+az*z)+a.hw*Math.abs(-az*x+ax*z)
      +b.hl*Math.abs(bx*x+bz*z)+b.hw*Math.abs(-bz*x+bx*z);
    const d=(a.x-b.x)*x+(a.z-b.z)*z, g=Math.abs(d)-extent;
    if(g>gap){gap=g;const sign=d<0?-1:1;nx=x*sign;nz=z*sign;}
  };
  axis(ax,az);axis(-az,ax);axis(bx,bz);axis(-bz,bx);
  // Face centres for a parallel contact, a corner when the normal is oblique. A zero dot
  // product contributes zero, avoiding an artificial spin on a centred head-on collision.
  const sign=(n:number)=>Math.abs(n)<1e-10?0:n<0?-1:1;
  const af=sign(ax*nx+az*nz), ar=sign(-az*nx+ax*nz);
  const bf=sign(bx*nx+bz*nz), br=sign(-bz*nx+bx*nz);
  const px=a.x-ax*a.hl*af+az*a.hw*ar, pz=a.z-az*a.hl*af-ax*a.hw*ar;
  const qx=b.x+bx*b.hl*bf-bz*b.hw*br, qz=b.z+bz*b.hl*bf+bx*b.hw*br;
  return {gap,nx,nz,x:(px+qx)/2,z:(pz+qz)/2};
}

/**
 * Relative continuous hull sweep. On each iteration the current separating axis stays valid
 * until its gap can close: translation plus each corner's angular travel bounds that change.
 * Exhausting the bounded search fails closed at its last proven-safe pose, never tunnels.
 */
export function sweepHulls(a: Readonly<VehicleMotion>, b: Readonly<VehicleMotion>, iterationBudget: 32 | 128 = 32): HullSweep|null {
  const dyA=a.after.y-a.before.y,dyB=b.after.y-b.before.y;
  // The common height interval is linear even on a hill / airborne step.
  let lo=0,hi=1;
  const band=(value:number,delta:number):boolean=>{
    if(Math.abs(delta)<1e-12)return value<0;
    const t=-value/delta;if(delta>0)hi=Math.min(hi,t);else lo=Math.max(lo,t);
    return lo<hi;
  };
  if(!band(a.before.y-b.before.y-b.before.height,dyA-dyB)
    ||!band(b.before.y-a.before.y-a.before.height,dyB-dyA)||lo>1||hi<0)return null;
  lo=Math.max(0,lo);hi=Math.min(1,hi);
  const dx=(a.after.x-a.before.x)-(b.after.x-b.before.x);
  const dz=(a.after.z-a.before.z)-(b.after.z-b.before.z);
  const angular=diagonal(a.after.hl,a.after.hw)*Math.abs(wrapAngle(a.after.heading-a.before.heading))
    +diagonal(b.after.hl,b.after.hw)*Math.abs(wrapAngle(b.after.heading-b.before.heading));
  // A previously resolved contact can start inside the numerical safety skin. Keeping
  // that skin as an obstacle would reject every turning-away move at t=0, even when
  // its actual hull stays clear. Sweep to physical contact in that case: the same
  // conservative distance/closing bound proves every advance safe, including rotation.
  const startGap=hullContact(hullAt(a,lo),hullAt(b,lo)).gap;
  const margin=startGap>0&&startGap<=VEHICLE_SKIN+1e-9?0:VEHICLE_SKIN;
  let t=lo,last:HullContact|null=null;
  // Legacy replays retain their exact work budget. SIM21 can spend more bounded
  // iterations proving a tight separating turn, with the same skin and closing bound.
  const iterations = iterationBudget === 128 ? 128 : 32;
  for(let i=0;i<iterations;i++){
    const c=hullContact(hullAt(a,t),hullAt(b,t));last=c;
    if(c.gap<=margin+1e-9){
      // A touching pair that is separating along a fixed axis may leave contact freely.
      const outward=dx*c.nx+dz*c.nz;
      if(t===0&&c.gap>=-1e-8&&outward>=angular-1e-10)return null;
      return {...c,t};
    }
    const closing=Math.abs(dx*c.nx+dz*c.nz)+angular;
    if(closing<1e-12)return null;
    const advance=(c.gap-margin)/closing;
    if(t+advance>hi)return null;
    if(advance<1e-10)return {...c,t};
    t+=advance;
  }
  return last?{...last,t}:null;
}

/** Swept broad phase, stable regardless of map/cell insertion order. */
export function vehiclePairs(motions: readonly VehicleMotion[]): Array<[number,number]> {
  const cell=16,n=motions.length,grid=new Map<string,number[]>(),wide:number[]=[],seen=new Set<number>();
  const pairs:Array<[number,number]>=[];
  const pair=(i:number,j:number):void=>{
    if(i===j)return;if(j<i){const swap=i;i=j;j=swap;}
    const key=i*n+j;if(!seen.has(key)){seen.add(key);pairs.push([i,j]);}
  };
  motions.forEach((m,i)=>{
    // Half-diagonal covers every intermediate orientation; maxPush covers bounded recovery.
    const r=Math.max(diagonal(m.before.hl,m.before.hw),diagonal(m.after.hl,m.after.hw))+.5;
    const x0=Math.floor((Math.min(m.before.x,m.after.x)-r)/cell),x1=Math.floor((Math.max(m.before.x,m.after.x)+r)/cell);
    const z0=Math.floor((Math.min(m.before.z,m.after.z)-r)/cell),z1=Math.floor((Math.max(m.before.z,m.after.z)+r)/cell);
    // A malformed / teleporting input cannot allocate millions of grid cells. The bounded
    // actor list is the fallback for an unusually long sweep, retaining collision coverage.
    if((x1-x0+1)*(z1-z0+1)>64){wide.push(i);return;}
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){
      const key=`${x},${z}`,at=grid.get(key);
      if(at){for(const j of at)pair(i,j);at.push(i);}else grid.set(key,[i]);
    }
  });
  for(const i of wide)for(let j=0;j<n;j++)pair(i,j);
  return pairs.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
}
