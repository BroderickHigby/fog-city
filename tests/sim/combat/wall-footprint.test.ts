import {describe,it,expect} from "vitest";
import {segmentWallFraction,lineOfSight} from "../../../src/sim/combat/physics.ts";
import {contextFromState} from "../../../src/sim/combat/adapter.ts";
import {buildWorld,createInitialState} from "../../../src/sim/index.ts";
import type {Wall} from "../../../src/sim/combat-contract.ts";
const diamond:Wall={id:"rotated",minX:-2,maxX:2,minZ:-2,maxZ:2,minY:1,maxY:3,footprint:[[0,2],[2,0],[0,-2],[-2,0]]};
const notch:Wall={id:"concave",minX:0,maxX:6,minZ:0,maxZ:6,minY:1,maxY:3,footprint:[[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6]]};
describe("exact combat wall footprints",()=>{
 it("keeps open rotated-box corners and concave notches clear",()=>{
  expect(segmentWallFraction({x:1.8,y:2,z:1.8},{x:1.9,y:2,z:1.8},diamond)).toBeNull();
  expect(segmentWallFraction({x:3,y:2,z:3},{x:3,y:2,z:5},notch)).toBeNull();
  expect(lineOfSight({x:3,y:2,z:3},{x:3,y:2,z:5},[notch])).toBe(true);
 });
 it("hits actual facades, closed edges and the first concave segment",()=>{
  expect(segmentWallFraction({x:-3,y:2,z:0},{x:3,y:2,z:0},diamond)).toBeCloseTo(1/6);
  expect(segmentWallFraction({x:-3,y:2,z:2},{x:3,y:2,z:2},diamond)).toBe(.5);
  expect(segmentWallFraction({x:3,y:2,z:5},{x:3,y:2,z:0},notch)).toBeCloseTo(.6);
  expect(segmentWallFraction({x:-1,y:2,z:4},{x:7,y:2,z:4},notch)).toBeCloseTo(.125);
  expect(segmentWallFraction({x:0,y:2,z:0},{x:1,y:2,z:0},diamond)).toBe(0);
 });
 it("clips vertical rays and preserves above/below clearance",()=>{
  expect(segmentWallFraction({x:1,y:-1,z:4},{x:1,y:5,z:4},notch)).toBeCloseTo(1/3);
  expect(segmentWallFraction({x:3,y:-1,z:4},{x:3,y:5,z:4},notch)).toBeNull();
  expect(segmentWallFraction({x:-1,y:4,z:4},{x:7,y:4,z:4},notch)).toBeNull();
  expect(segmentWallFraction({x:-1,y:0,z:4},{x:7,y:0,z:4},notch)).toBeNull();
  expect(segmentWallFraction({x:1,y:2,z:4},{x:1,y:2,z:4},notch)).toBe(0);
  expect(segmentWallFraction({x:3,y:2,z:4},{x:3,y:2,z:4},notch)).toBeNull();
  expect(segmentWallFraction({x:-1,y:-3,z:4},{x:3,y:5,z:4},notch)).toBe(.5);
  expect(segmentWallFraction({x:-1,y:-3,z:4},{x:7,y:5,z:4},notch)).toBe(.625);
 });
 it("keeps plain boxes and invalid optional footprints fail closed",()=>{
  const {footprint:_footprint,...box}=diamond;
  expect(segmentWallFraction({x:1.8,y:2,z:1.8},{x:1.9,y:2,z:1.8},box)).toBe(0);
  expect(segmentWallFraction({x:1.8,y:2,z:1.8},{x:1.9,y:2,z:1.8},{...diamond,footprint:[]})).toBe(0);
  expect(segmentWallFraction({x:-3,y:2,z:0},{x:3,y:2,z:0},{...diamond,footprint:[...diamond.footprint!].reverse()})).toBeCloseTo(1/6);
 });
 it("carries exact immutable world geometry into the combat adapter",()=>{
  const world=buildWorld([{tileId:"notch",ground:null,buildings:[{id:"notch",baseY:1,topY:3,footprint:notch.footprint!.map(p=>[p[0],p[1]])}]}]);
  const state=createInitialState(buildWorld([]),1,["p"],{x:10,z:10,heading:0});
  const wall=contextFromState(world,state).walls.find(w=>w.id==="notch")!;
  expect(wall.footprint).toEqual(notch.footprint);
  expect(segmentWallFraction({x:3,y:2,z:3},{x:3,y:2,z:5},wall)).toBeNull();
 });
});
