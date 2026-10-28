/** Current exact sweep retained; only SIM21 flowers gain solid NPC interception. */
import { DT, sortedActors } from "./shared.ts";
import type { CombatActor, CombatContext, Projectile, Vec3, Wall } from "./types.ts";

export const PROJECTILE_GRAVITY = 9.81;
const CONTACT_EPSILON = 1e-10;

function inFootprint(x:number,z:number,polygon:readonly (readonly [number,number])[]):boolean {
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const [ax,az]=polygon[j]!,[bx,bz]=polygon[i]!;
    const cross=(x-ax)*(bz-az)-(z-az)*(bx-ax);
    if(Math.abs(cross)<=CONTACT_EPSILON&&x>=Math.min(ax,bx)-CONTACT_EPSILON&&x<=Math.max(ax,bx)+CONTACT_EPSILON&&z>=Math.min(az,bz)-CONTACT_EPSILON&&z<=Math.max(az,bz)+CONTACT_EPSILON)return true;
    if((az>z)!==(bz>z)&&x<(bx-ax)*(z-az)/(bz-az)+ax)inside=!inside;
  }
  return inside;
}

/** Exact first contact with a possibly concave polygon during the clipped height interval. */
function footprintFraction(a:Vec3,b:Vec3,polygon:readonly (readonly [number,number])[],enter:number,exit:number):number|null {
  const dx=b.x-a.x,dz=b.z-a.z;
  if(inFootprint(a.x+dx*enter,a.z+dz*enter,polygon))return enter;
  let first:number|null=null;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const [ax,az]=polygon[j]!,[bx,bz]=polygon[i]!,ex=bx-ax,ez=bz-az,ox=ax-a.x,oz=az-a.z;
    const determinant=dx*ez-dz*ex;
    let contact:number|null=null;
    if(Math.abs(determinant)>CONTACT_EPSILON){
      const t=(ox*ez-oz*ex)/determinant,u=(ox*dz-oz*dx)/determinant;
      if(t>=enter-CONTACT_EPSILON&&t<=exit+CONTACT_EPSILON&&u>=-CONTACT_EPSILON&&u<=1+CONTACT_EPSILON)contact=Math.max(enter,Math.min(exit,t));
    }else if(Math.abs(ox*dz-oz*dx)<=CONTACT_EPSILON){
      const length=dx*dx+dz*dz;
      if(length>0){
        const ta=(ox*dx+oz*dz)/length,tb=((bx-a.x)*dx+(bz-a.z)*dz)/length;
        const low=Math.max(enter,Math.min(ta,tb)),high=Math.min(exit,Math.max(ta,tb));
        if(low<=high)contact=low;
      }
    }
    if(contact!==null&&(first===null||contact<first))first=contact;
  }
  return first;
}

/** First contact with a closed box, or its exact extruded footprint when supplied. */
export function segmentWallFraction(a: Vec3, b: Vec3, wall: Wall): number | null {
  let enter = 0;
  let exit = 1;
  const axes = [
    [a.x, b.x - a.x, wall.minX, wall.maxX],
    [a.y, b.y - a.y, wall.minY, wall.maxY],
    [a.z, b.z - a.z, wall.minZ, wall.maxZ],
  ] as const;
  for (const [start, delta, min, max] of axes) {
    if (!Number.isFinite(start) || !Number.isFinite(delta) || !Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
    if (delta === 0) {
      if (start < min || start > max) return null;
      continue;
    }
    const first = (min - start) / delta;
    const second = (max - start) / delta;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return null;
  }
  if(!wall.footprint)return enter;
  // Invalid optional geometry falls back to the enclosing wall rather than opening a hole.
  if(wall.footprint.length<3||wall.footprint.some(point=>point.length!==2||!Number.isFinite(point[0])||!Number.isFinite(point[1])))return enter;
  return footprintFraction(a,b,wall.footprint,enter,exit);
}

/**
 * Exact segment against an upright, flat-capped cylinder. The actor position is
 * its feet, and height and radius define its physical target volume.
 */
export function segmentActorFraction(a: Vec3, b: Vec3, actor: CombatActor): number | null {
  if (!Number.isFinite(actor.x) || !Number.isFinite(actor.y) || !Number.isFinite(actor.z) ||
      !Number.isFinite(actor.radius) || !Number.isFinite(actor.height) || actor.radius < 0 || actor.height < 0) return null;
  const ox = a.x - actor.x;
  const oz = a.z - actor.z;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dy = b.y - a.y;
  const quadratic = dx * dx + dz * dz;
  const linear = 2 * (ox * dx + oz * dz);
  const constant = ox * ox + oz * oz - actor.radius * actor.radius;
  let enter = 0;
  let exit = 1;
  if (quadratic === 0) {
    if (constant > 0) return null;
  } else {
    const discriminant = linear * linear - 4 * quadratic * constant;
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    // This form avoids subtracting two almost-equal values for the nearer root.
    const q = -0.5 * (linear + (linear >= 0 ? root : -root));
    const first = q === 0 ? 0 : q / quadratic;
    const second = q === 0 ? 0 : constant / q;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return null;
  }
  if (dy === 0) {
    if (a.y < actor.y || a.y > actor.y + actor.height) return null;
  } else {
    const first = (actor.y - a.y) / dy;
    const second = (actor.y + actor.height - a.y) / dy;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
  }
  return enter <= exit ? enter : null;
}

/** Opaque walls include their boundary, so a ray cannot see through a thin wall. */
export function lineOfSight(a: Vec3, b: Vec3, walls: readonly Wall[]): boolean {
  return !walls.some(wall => segmentWallFraction(a, b, wall) !== null);
}

function canHit(projectile: Projectile, actor: CombatActor,ctx:CombatContext): boolean {
  if (actor.id === projectile.ownerId || actor.playerId === projectile.ownerId) return false;
  if (projectile.kind === "flower") return (ctx.simVersion??20)>=21?true:actor.kind === "player";
  if (projectile.kind === "water" && actor.kind === "player" && actor.robotBody !== true) return false;
  // Protected subjects still intercept the path. The effect layer removes the
  // projectile without applying an effect, including when another target is behind.
  return true;
}

/** First sampled terrain crossing, refined by a fixed number of bisection steps. */
export function segmentGroundFraction(a: Vec3, b: Vec3, ctx: CombatContext): number | null {
  if (!ctx.groundHeight) {
    if (a.y < 0 || a.y === 0 && b.y <= 0) return 0;
    return a.y > 0 && b.y <= CONTACT_EPSILON && b.y < a.y ? Math.min(1, a.y / (a.y - b.y)) : null;
  }
  const height = ctx.groundHeight;
  const clearance = (t: number): number => {
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    return a.y + (b.y - a.y) * t - height(x, z);
  };
  let previousT = 0;
  let previousClearance = clearance(0);
  if (previousClearance < 0) return 0;
  // Inspect the path as well as its endpoint: a broad terrain crest can cross a
  // projectile even when both segment endpoints are above the ground.
  for (let sample = 1; sample <= 32; sample++) {
    const t = sample / 32;
    const current = clearance(t);
    if (current <= 0) {
      if (previousClearance <= 0) return previousT;
      let low = previousT;
      let high = t;
      for (let pass = 0; pass < 28; pass++) {
        const middle = (low + high) / 2;
        if (clearance(middle) > 0) low = middle;
        else high = middle;
      }
      return high;
    }
    previousT = t;
    previousClearance = current;
  }
  return null;
}

export interface ProjectileAdvance {
  projectile: Projectile;
  hit: CombatActor | null;
  blocked: boolean;
  landed: boolean;
  expired: boolean;
}

/**
 * One fixed ballistic tick with a continuous sweep, rather than endpoint overlap.
 * Range counts horizontal travel, so an arc preserves its advertised throw range.
 * The last segment is clipped before
 * any collision query. Equal contacts resolve to a wall/ground, then the actor id.
 */
export function advanceProjectile(projectile: Projectile, ctx: CombatContext): ProjectileAdvance {
  const remaining = Math.max(0, projectile.range - projectile.distance);
  if (remaining === 0) return { projectile: { ...projectile }, hit: null, blocked: false, landed: false, expired: true };

  const dx = projectile.vx * DT;
  const dy = projectile.vy * DT - 0.5 * PROJECTILE_GRAVITY * DT * DT;
  const dz = projectile.vz * DT;
  const length = Math.sqrt(dx * dx + dz * dz);
  const rangeFraction = length > remaining ? remaining / length : 1;
  const end = { x: projectile.x + dx * rangeFraction, y: projectile.y + dy * rangeFraction, z: projectile.z + dz * rangeFraction };
  let stop = 1;
  let blocked = false;
  let landed = false;
  let hit: CombatActor | null = null;

  for (const wall of ctx.walls) {
    const contact = segmentWallFraction(projectile, end, wall);
    if (contact !== null && contact <= stop) {
      stop = contact;
      blocked = true;
    }
  }
  const ground = segmentGroundFraction(projectile, end, ctx);
  if (ground !== null && ground <= stop) {
    landed = true;
    blocked = blocked && Math.abs(ground - stop) <= CONTACT_EPSILON;
    stop = ground;
  }

  for (const actor of sortedActors(ctx)) {
    if (!canHit(projectile, actor,ctx)) continue;
    const contact = segmentActorFraction(projectile, end, actor);
    if (contact === null) continue;
    if (contact < stop - CONTACT_EPSILON || !hit && !blocked && !landed && contact <= stop) {
      stop = contact;
      hit = actor;
      blocked = false;
      landed = false;
    }
  }

  const fraction = rangeFraction * stop;
  const x = projectile.x + dx * fraction;
  const z = projectile.z + dz * fraction;
  const next: Projectile = {
    ...projectile,
    x,
    y: landed ? ctx.groundHeight?.(x, z) ?? 0 : projectile.y + dy * fraction,
    z,
    vy: projectile.vy - PROJECTILE_GRAVITY * DT * fraction,
    distance: Math.min(projectile.range, projectile.distance + length * fraction),
  };
  return {
    projectile: next,
    hit,
    blocked,
    landed,
    expired: !hit && !blocked && !landed && (rangeFraction < 1 || next.distance >= projectile.range),
  };
}
