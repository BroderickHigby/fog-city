import * as THREE from "three";
import type { CombatState, Projectile } from "../sim/combat-contract.ts";

/** A new water shot is drawn leaving the blaster's nozzle, joining the sim's path over this distance (m). */
export const NOZZLE_BLEND_M=1.5;
/** Where a player's stream leaves the nozzle (world), or null when its blaster is not drawn. */
export type NozzleOf=(ownerId:string,out:THREE.Vector3)=>THREE.Vector3|null;

/** Bounded pooled presentation; every projectile position comes from the sim snapshot. */
export class CombatLayer {
  readonly root=new THREE.Group();
  private readonly meshes=new Map<Projectile["kind"],THREE.InstancedMesh>();
  private readonly transform=new THREE.Object3D();
  private readonly velocity=new THREE.Vector3();
  private readonly up=new THREE.Vector3(0,1,0);
  private readonly nozzle=new THREE.Vector3();
  constructor(scene:THREE.Scene){
    for(const [kind,color] of [["water",0x78daff],["cone",0xff983d],["balloon",0xa1def9],["flower",0xedc4f5]] as const){
      const geometry=kind==="cone"?new THREE.ConeGeometry(.18,.4,8):new THREE.SphereGeometry(kind==="water"?.09:.16,7,5);
      const material=new THREE.MeshStandardMaterial({color,roughness:kind==="water"?.15:.6,metalness:0,emissive:kind==="water"?0x123545:0});
      const mesh=new THREE.InstancedMesh(geometry,material,kind==="water"?256:64);mesh.count=0;mesh.frustumCulled=false;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.meshes.set(kind,mesh);this.root.add(mesh);
    }
    this.root.name="gameplay-projectiles";scene.add(this.root);
  }
  update(previous:CombatState|undefined,current:CombatState|undefined,alpha:number,nozzleOf?:NozzleOf):void {
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
  dispose():void {for(const mesh of this.meshes.values()){mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}this.root.removeFromParent();}
}
