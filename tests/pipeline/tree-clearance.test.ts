import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { TreeClearance } from "../../pipeline/lib/tree-clearance.ts";
import { treeProfile } from "../../pipeline/lib/tree-profile.ts";
import type { RoadGraph } from "../../src/render/types.ts";

const road = (points: Array<[number, number]>, widthM = 10, ys?: [number, number]): RoadGraph => ({
  version: 1, nodes: [{id:"a",x:points[0]![0],z:points[0]![1],y:ys?.[0]},{id:"b",x:points.at(-1)![0],z:points.at(-1)![1],y:ys?.[1]}],
  edges: [{id:"road",a:"a",b:"b",kind:"residential",lanes:2,oneway:false,widthM,points}],
});
const matrix = (x: number, y = 0, z = 0): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x,y,z);
function shape(crownY = 7) {
  const trunk = new THREE.BoxGeometry(.3, 8, .3).translate(0,4,0);
  const crown = new THREE.BoxGeometry(5,1,5).translate(0,crownY,0);
  const p = treeProfile([trunk,crown]); trunk.dispose(); crown.dispose(); return p;
}

describe("tree clearance from drivable streets", () => {
  it("rejects a road-centre trunk and retains a clear sidewalk tree with a high crown", () => {
    const c = new TreeClearance(road([[0,-50],[0,50]]),()=>0), p = shape();
    expect(c.allows(p,matrix(0))).toBe(false);
    expect(c.allows(p,matrix(6))).toBe(true);
    expect(c.allows(p,matrix(5.1))).toBe(false);
  });
  it("includes low foliage in the driving band, not just the planted trunk", () => {
    const c = new TreeClearance(road([[0,-50],[0,50]]),()=>0);
    expect(c.allows(shape(2),matrix(6))).toBe(false);
    expect(c.allows(shape(7),matrix(6))).toBe(true);
  });
  it("checks crossing and curved roads and the full instance scale", () => {
    const graph=road([[0,-50],[0,50]]);graph.edges.push({...graph.edges[0]!,id:"cross",points:[[-50,0],[50,0]]});
    expect(new TreeClearance(graph,()=>0).allows(shape(),matrix(7,0,0))).toBe(false);
    const c=new TreeClearance(road([[0,0],[20,20],[20,60]],6),()=>0);
    expect(c.allows(shape(),matrix(10,0,10))).toBe(false);
    expect(c.allows(shape(),matrix(24,0,40))).toBe(true);
    expect(c.allows(shape(),matrix(24,0,40).scale(new THREE.Vector3(4,1,4)))).toBe(false);
  });
  it("protects the actual junction patch outside the ribbons", () => {
    const c=new TreeClearance(road([[-50,0],[50,0]],4),()=>0);
    c.addJunction([0,-9,9,0,0,9,-9,0],0,0);
    expect(c.allows(shape(),matrix(4,0,4))).toBe(false);
    expect(c.allows(shape(),matrix(10,0,10))).toBe(true);
  });
  it("does not remove a tree below a separate elevated road", () => {
    const c=new TreeClearance(road([[0,-50],[0,50]],10,[20,20]),()=>0);
    expect(c.allows(shape(),matrix(0))).toBe(true);
    expect(c.allows(shape(),matrix(0,20))).toBe(false);
  });
  it("follows the terrain on hills and sloping junction patches", () => {
    const hill = new TreeClearance(road([[0,-50],[0,50]],10,[0,0]), (_x,z)=>10-Math.abs(z)*.2);
    expect(hill.allows(shape(),matrix(0,10,0))).toBe(false);
    const junction = new TreeClearance(null,x=>x*2.5);
    junction.addJunction([0,-9,9,0,0,9,-9,0],0,0);
    expect(junction.allows(shape(),matrix(4,10,4))).toBe(false);
  });
  it("includes higher terrain beneath the edge of a crown", () => {
    // The nearest centreline is flat, but the crown's roadward edge crosses a raised
    // part of the same bilinear terrain cell and drops below 4.5 m relative to it.
    const crown = new THREE.BoxGeometry(5,.1,5).translate(0,4.7,0);
    const profile = treeProfile([crown]); crown.dispose();
    const c = new TreeClearance(road([[0,-50],[0,50]]),(_x,z)=>Math.abs(z)*.2);
    expect(c.allows(profile,matrix(6))).toBe(false);
  });
  it("includes the rendered ribbon extensions at two-road bends", () => {
    const graph=road([[0,-50],[0,0]],10);
    graph.edges.push({...graph.edges[0]!,id:"turn",a:"b",b:"c",points:[[0,0],[50,0]]});
    graph.nodes.push({id:"c",x:50,z:0});
    const c=new TreeClearance(graph,()=>0);
    expect(c.allows(shape(),matrix(-4,0,7))).toBe(false);
  });
  it("rejects the real Drumm Street centreline witness", () => {
    const c=new TreeClearance(road([[-236.96,203.81],[-254.18,101.2]],11),()=>3);
    expect(c.allows(shape(),matrix(-242.3,3,172.1))).toBe(false);
  });
  it("keeps land without road geometry and rejects nonfinite placement", () => {
    const c=new TreeClearance(null,()=>0);
    expect(c.allows(shape(),matrix(50))).toBe(true);
    expect(c.allows(shape(),matrix(NaN))).toBe(false);
  });
});
