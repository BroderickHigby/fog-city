import {describe,it,expect} from 'vitest';
import {Group,InstancedMesh,BoxGeometry,MeshBasicMaterial,Matrix4,Vector3} from 'three';
import {TreeFallbacks} from '../../src/render/trees.ts';
function fixture(){const scene=new Group(),root=new Group();scene.add(root);const mesh=new InstancedMesh(new BoxGeometry(),new MeshBasicMaterial(),2);mesh.name='street-trees-0';mesh.setMatrixAt(0,new Matrix4().makeTranslation(2,0,3));mesh.setMatrixAt(1,new Matrix4().makeTranslation(20,0,30));root.add(mesh);return {scene,root,mesh,fallback:new TreeFallbacks()};}
function scale(mesh:InstancedMesh,i:number){const m=new Matrix4();mesh.getMatrixAt(i,m);return new Vector3().setFromMatrixScale(m).x;}
describe('detailed tree fallback',()=>{
 it('retains originals until a replacement is actually drawn and restores capacity-limited trees',()=>{const {root,mesh,fallback}=fixture();fallback.add(root,()=>true);fallback.update(()=>false);expect(scale(mesh,0)).toBe(1);fallback.update(x=>x===2);expect(scale(mesh,0)).toBe(0);expect(scale(mesh,1)).toBe(1);fallback.update(()=>false);expect(scale(mesh,0)).toBe(1);});
 it('does not hide the outside half of a boundary-straddling mesh',()=>{const {root,mesh,fallback}=fixture();expect(fallback.add(root,x=>x<10)).toEqual([{x:2,z:3}]);fallback.update(()=>true);expect(scale(mesh,0)).toBe(0);expect(scale(mesh,1)).toBe(1);});
 it('registers once and retires detached tiles',()=>{const {root,mesh,fallback}=fixture();fallback.add(root,()=>true);expect(fallback.add(root,()=>true)).toEqual([]);root.removeFromParent();fallback.update(()=>true);expect(scale(mesh,0)).toBe(1);});
});
