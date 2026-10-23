import {it,expect} from 'vitest';
import * as THREE from 'three';
import {finishCar} from '../../src/render/actors.ts';
it('layers a private clear coat without modifying shared model materials or geometry',()=>{
 const original=new THREE.MeshStandardMaterial({name:'paint',color:0xff6611,roughness:.6});const geometry=new THREE.BoxGeometry();const a=new THREE.Mesh(geometry,original),b=new THREE.Mesh(geometry,original);const root=new THREE.Group();root.add(a,b);const materials=finishCar(root);expect(materials).toHaveLength(1);expect(a.material).toBe(b.material);expect(a.material).not.toBe(original);expect((a.material as THREE.MeshPhysicalMaterial).clearcoat).toBe(1);expect(original.roughness).toBe(.6);expect(a.geometry).toBe(geometry);materials.forEach(m=>m.dispose());original.dispose();geometry.dispose();
});
