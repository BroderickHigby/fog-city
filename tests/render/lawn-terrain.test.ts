import * as THREE from "three";
import { describe,expect,it } from "vitest";
import { LawnTerrain } from "../../src/render/lawn-terrain.ts";
import { createPavementMask } from "../../src/render/pavement.ts";
import { onFarLattice } from "../../src/render/far-layer.ts";

const square=(x:number,z:number,size:number):number[]=>[x,z,x+size,z,x+size,z+size,x,z+size];
const lawn=(rings:number[][])=>({id:"rpd:test:0@0,0",kind:"lawn",rings});
function ground(heights=[2,2,2]):THREE.BufferGeometry {
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.Float32BufferAttribute([0,heights[0]!,0,100,heights[1]!,0,0,heights[2]!,100],3));
  g.setAttribute("color",new THREE.Float32BufferAttribute([.5,.5,.5,1,.5,.5,.5,1,.5,.5,.5,1],4));
  g.setAttribute("uv",new THREE.Float32BufferAttribute([0,0,1,0,0,1],2));
  g.computeVertexNormals();g.setIndex([0,1,2]);
  return g;
}
function areas(g:THREE.BufferGeometry):{total:number;green:number} {
  const p=g.getAttribute("position"),c=g.getAttribute("color"),idx=g.index!;
  let total=0,green=0;
  for(let i=0;i<idx.count;i+=3){
    const a=idx.getX(i),b=idx.getX(i+1),d=idx.getX(i+2);
    const area=Math.abs((p.getX(b)-p.getX(a))*(p.getZ(d)-p.getZ(a))-(p.getZ(b)-p.getZ(a))*(p.getX(d)-p.getX(a)))/2;
    total+=area;if([a,b,d].every(j=>c.getY(j)>c.getX(j)))green+=area;
  }
  return {total,green};
}
describe("persistent mapped lawn terrain",()=>{
  it("fills a small lawn entirely between far vertices, retaining exactly one continuous floor",()=>{
    const g=ground(),layer=new LawnTerrain({grass:[lawn([square(10,10,10)])]});
    expect(layer.paint(g,new THREE.Matrix4(),createPavementMask(null),onFarLattice)).toBeGreaterThan(0);
    expect(areas(g).green).toBeCloseTo(100,3);expect(areas(g).total).toBeCloseTo(5000,2);
    const count=g.index!.count;expect(layer.paint(g,new THREE.Matrix4(),createPavementMask(null))).toBe(0);expect(g.index!.count).toBe(count);
    g.dispose();
  });
  it("retains holes, paved paths and concave building courtyards without duplicated overlapping lawns",()=>{
    const g=ground(),patch=lawn([square(10,10,20),square(12,12,4)]);
    const layer=new LawnTerrain({grass:[patch,{...patch,id:"duplicate"}]});
    const mask=createPavementMask(null);
    mask.addPolygon([[20,0],[22,0],[22,50],[20,50]]);
    mask.addPolygon([[10,10],[18,10],[18,12],[12,12],[12,18],[10,18]]);
    layer.paint(g,new THREE.Matrix4(),mask);
    expect(areas(g).green).toBeCloseTo(400-16-40-28,2);
    expect(areas(g).total).toBeCloseTo(5000,2);g.dispose();
  });
  it("paints low coastal land but never the water half of a mixed shore triangle",()=>{
    const g=ground([2,2,-2]),layer=new LawnTerrain({grass:[lawn([square(5,5,10)]),lawn([square(5,70,10)])]});
    layer.paint(g,new THREE.Matrix4(),createPavementMask(null),onFarLattice);
    expect(areas(g).green).toBeCloseTo(100,2);expect(areas(g).total).toBeCloseTo(5000,2);
    const low=ground([.2,.2,.2]);new LawnTerrain({grass:[lawn([square(5,5,10)])]}).paint(low,new THREE.Matrix4(),createPavementMask(null));
    expect(areas(low).green).toBeCloseTo(100,2);g.dispose();low.dispose();
  });
  it("clips a lawn crossing the water line without cutting a gap in the floor",()=>{
    const g=ground([2,2,-2]);
    new LawnTerrain({grass:[lawn([square(5,40,10)])]}).paint(g,new THREE.Matrix4(),createPavementMask(null),onFarLattice);
    expect(areas(g).green).toBeCloseTo(75,2);expect(areas(g).total).toBeCloseTo(5000,2);g.dispose();
  });
  it("preserves the original terrain plane, normals, UVs and alpha on every new face",()=>{
    const g=ground([2,12,22]);g.addGroup(0,3,0);
    new LawnTerrain({grass:[lawn([square(10,10,20)])]}).paint(g,new THREE.Matrix4(),createPavementMask(null));
    const p=g.getAttribute("position"),uv=g.getAttribute("uv"),normal=g.getAttribute("normal"),c=g.getAttribute("color");
    for(let i=0;i<p.count;i++){
      expect(p.getY(i)).toBeCloseTo(2+p.getX(i)*.1+p.getZ(i)*.2,4);
      expect(uv.getX(i)).toBeCloseTo(p.getX(i)/100,5);expect(uv.getY(i)).toBeCloseTo(p.getZ(i)/100,5);
      expect(c.getW(i)).toBe(1);expect(normal.getY(i)).toBeCloseTo(normal.getY(0),5);
    }
    expect(g.groups.reduce((n,group)=>n+group.count,0)).toBe(g.index!.count);g.dispose();
  });
  it("preserves finite draw ranges and coalesces partitions using the same material",()=>{
    const g=ground();g.setIndex([0,1,2,0,1,2]);g.addGroup(0,6,0);g.setDrawRange(3,3);
    new LawnTerrain({grass:[lawn([square(10,10,10)])]}).paint(g,new THREE.Matrix4(),createPavementMask(null));
    expect(areas(g).total).toBeCloseTo(5000,2);expect(areas(g).green).toBeCloseTo(100,2);
    expect(g.groups).toHaveLength(1);expect(g.groups[0]!.count).toBe(g.index!.count);g.dispose();
  });
  it("applies world-space polygons to translated meshes and ignores far building hulls",()=>{
    const g=ground(),m=new THREE.Matrix4().makeTranslation(500,0,500);
    const layer=new LawnTerrain({grass:[lawn([square(510,510,10)])]});
    layer.paint(g,m,createPavementMask(null),onFarLattice);expect(areas(g).green).toBeCloseTo(100,2);
    const hull=ground();hull.translate(1,0,1);const before=Array.from(hull.getAttribute("position").array);
    expect(new LawnTerrain({grass:[lawn([square(10,10,10)])]}).paint(hull,new THREE.Matrix4(),createPavementMask(null),onFarLattice)).toBe(0);
    expect(Array.from(hull.getAttribute("position").array)).toEqual(before);g.dispose();hull.dispose();
  });
  it("leaves missing optional data and unmapped land unchanged",()=>{
    const g=ground(),before=g.getAttribute("position");
    expect(new LawnTerrain(null).paint(g,new THREE.Matrix4(),createPavementMask(null))).toBe(0);
    expect(new LawnTerrain({grass:[lawn([square(200,200,10)])]}).paint(g,new THREE.Matrix4(),createPavementMask(null))).toBe(0);
    expect(g.getAttribute("position")).toBe(before);g.dispose();
  });
});
