import * as THREE from "three";
import type { CombatState, Projectile } from "../sim/combat-contract.ts";

/** Droplets in one splash, and the most splashes alive at once. */
export const SPLASH_DROPS = 10;
export const SPLASH_MAX = 24;
/** A splash lasts this long (render seconds). */
export const SPLASH_S = 0.55;

interface Splash { x: number; y: number; z: number; vx: number; vz: number; seed: number; born: number }

/** A new water shot is drawn leaving the blaster's nozzle, joining the sim's path over this distance (m). */
export const NOZZLE_BLEND_M=1.5;
/** Where a player's stream leaves the nozzle (world), or null when its blaster is not drawn. */
export type NozzleOf=(ownerId:string,out:THREE.Vector3)=>THREE.Vector3|null;

/**
 * Bounded pooled presentation; every projectile position comes from the sim snapshot. A water
 * projectile the sim retires (it hit something, or ran out of range) leaves a splash where it
 * was last: droplets thrown out and up that fall back under gravity, render-only and pooled.
 */
export class CombatLayer {
  readonly root=new THREE.Group();
  private readonly meshes=new Map<Projectile["kind"],THREE.InstancedMesh>();
  private readonly transform=new THREE.Object3D();
  private readonly velocity=new THREE.Vector3();
  private readonly up=new THREE.Vector3(0,1,0);
  private readonly drops: THREE.InstancedMesh;
  private readonly splashes: Splash[] = [];
  private lastCurrent: CombatState | undefined;
  private clock = 0;
  private readonly nozzle=new THREE.Vector3();
  constructor(scene:THREE.Scene){
    for(const [kind,color] of [["water",0x78daff],["cone",0xff983d],["balloon",0xa1def9],["flower",0xedc4f5]] as const){
      const geometry=kind==="cone"?new THREE.ConeGeometry(.18,.4,8):new THREE.SphereGeometry(kind==="water"?.09:.16,7,5);
      const material=new THREE.MeshStandardMaterial({color,roughness:kind==="water"?.15:.6,metalness:0,emissive:kind==="water"?0x123545:0});
      const mesh=new THREE.InstancedMesh(geometry,material,kind==="water"?256:64);mesh.count=0;mesh.frustumCulled=false;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.meshes.set(kind,mesh);this.root.add(mesh);
    }
    const drop = new THREE.SphereGeometry(0.05, 6, 4);
    const dropMat = new THREE.MeshStandardMaterial({ color: 0xb8e6ff, roughness: 0.05, metalness: 0, emissive: 0x16323d, transparent: true, opacity: 0.85 });
    this.drops = new THREE.InstancedMesh(drop, dropMat, SPLASH_DROPS * SPLASH_MAX);
    this.drops.name = "gameplay-splashes";
    this.drops.count = 0;
    this.drops.frustumCulled = false;
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.drops);
    this.root.name="gameplay-projectiles";scene.add(this.root);
  }

  /** Splashes alive now (for tests and reports). */
  get splashCount(): number {
    return this.splashes.length;
  }

  /** Water projectiles in `previous` that `current` no longer has: each leaves a splash. */
  private retire(previous: CombatState | undefined, current: CombatState | undefined): void {
    if (!previous || !current) return;
    const live = new Set(current.projectiles.map((p) => p.id));
    for (const p of previous.projectiles) {
      if (p.kind !== "water" || live.has(p.id)) continue;
      if (this.splashes.length >= SPLASH_MAX) this.splashes.shift();
      const h = Math.hypot(p.vx, p.vz) || 1;
      this.splashes.push({ x: p.x, y: p.y, z: p.z, vx: p.vx / h, vz: p.vz / h, seed: p.id, born: this.clock });
    }
  }

  /** Advance the splashes by `dt` render seconds and place their droplets. */
  private drawSplashes(dt: number): void {
    this.clock += Math.max(0, dt);
    while (this.splashes.length && this.clock - this.splashes[0]!.born > SPLASH_S) this.splashes.shift();
    let n = 0;
    for (const s of this.splashes) {
      const t = this.clock - s.born;
      const k = 1 - t / SPLASH_S;
      for (let d = 0; d < SPLASH_DROPS; d++) {
        // Thrown back against the stream and out to the sides, a little up; deterministic per projectile.
        const a = ((s.seed * 7 + d * 37) % 360) * (Math.PI / 180);
        const speed = 1.6 + ((s.seed * 13 + d * 29) % 10) * 0.18;
        const ox = Math.cos(a) * speed - s.vx * 1.2;
        const oz = Math.sin(a) * speed - s.vz * 1.2;
        const up = 2.2 + ((s.seed + d * 11) % 7) * 0.25;
        this.transform.position.set(s.x + ox * t, s.y + up * t - 4.9 * t * t, s.z + oz * t);
        this.transform.quaternion.identity();
        this.transform.scale.setScalar(0.4 + 0.6 * k);
        this.transform.updateMatrix();
        this.drops.setMatrixAt(n++, this.transform.matrix);
      }
    }
    this.drops.count = n;
    this.drops.instanceMatrix.needsUpdate = true;
  }
  /** `dt`: render seconds since the last call (the splashes' clock). */
  update(previous:CombatState|undefined,current:CombatState|undefined,alpha:number,nozzleOf?:NozzleOf,dt=1/60):void {
    if (current !== this.lastCurrent) {
      this.retire(previous, current);
      this.lastCurrent = current;
    }
    this.drawSplashes(dt);
    const counts=new Map<Projectile["kind"],number>();
    const old=new Map(previous?.projectiles.map(p=>[p.id,p]));
    for(const projectile of current?.projectiles??[]){
      const mesh=this.meshes.get(projectile.kind)!;const index=counts.get(projectile.kind)??0;if(index>=mesh.instanceMatrix.count)continue;
      const from=old.get(projectile.id)??projectile;
      this.transform.position.set(from.x+(projectile.x-from.x)*alpha,from.y+(projectile.y-from.y)*alpha,from.z+(projectile.z-from.z)*alpha);
      // A fresh water shot leaves the nozzle the player holds and joins the sim's path within NOZZLE_BLEND_M.
      if(projectile.kind==="water"&&projectile.distance<NOZZLE_BLEND_M&&nozzleOf?.(projectile.ownerId,this.nozzle)){
        this.transform.position.lerp(this.nozzle,1-Math.max(0,projectile.distance)/NOZZLE_BLEND_M);
      }
      this.velocity.set(projectile.vx,projectile.vy,projectile.vz).normalize();this.transform.quaternion.setFromUnitVectors(this.up,this.velocity);
      this.transform.scale.set(1,projectile.kind==="water"?2.8:1,1);this.transform.updateMatrix();mesh.setMatrixAt(index,this.transform.matrix);counts.set(projectile.kind,index+1);
    }
    for(const [kind,mesh]of this.meshes){mesh.count=counts.get(kind)??0;mesh.instanceMatrix.needsUpdate=true;}
  }
  dispose():void {for(const mesh of [...this.meshes.values(), this.drops]){mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}this.root.removeFromParent();}
}
