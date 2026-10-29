import {describe,expect,it} from "vitest";
import {buildWorld,type Heightfield,type TileCollider} from "../../../src/sim/world.ts";
import {createInitialState} from "../../../src/sim/step.ts";
import {canonicalJson} from "../../../src/sim/serialize.ts";
import {createCombatPlacement} from "../../../src/sim/combat/placement.ts";
import {PROTECTED_AREAS} from "../../../src/content/places.ts";
import {toLocal} from "../../../src/geo/project.ts";
import type {CombatActor,CombatPlayer} from "../../../src/sim/combat/types.ts";
import type {AgentState} from "../../../src/sim/agents.ts";
const base={x:20000,z:20000};
function field(x=base.x-100,z=base.z-100):Heightfield{return {x0:x,z0:z,nx:201,nz:201,cellSizeM:1,heights:Array(201*201).fill(0),water:Array(201*201).fill(0)};}
const tile=(ground:Heightfield):TileCollider=>({tileId:"fixture",buildings:[],ground});
const person=(x:number,z:number):CombatActor=>({id:"person",kind:"person",firmware:"none",x,y:0,z,heading:0,speed:0,radius:.35,height:1.8,protected:true});
function fixture(tiles=[tile(field())]){const world=buildWorld(tiles),state=createInitialState(world,7,["p"],{x:base.x+40,z:base.z+40,heading:0});return {world,state};}
const point={...base,y:0};
describe("trusted world combat placement",()=>{
 it("finds deterministic supported offroad lots only when requested and leaves source state unchanged",()=>{
  const {world,state}=fixture(),before=canonicalJson(state);expect(createCombatPlacement(world,state).safeLots).toEqual([]);
  const a=createCombatPlacement(world,state,{includeLots:true}),b=createCombatPlacement(world,JSON.parse(JSON.stringify(state)),{includeLots:true});expect(a.safeLots!.length).toBeGreaterThan(0);expect(a.safeLots).toEqual(b.safeLots);expect(a.devicePlacementAllowed!(point,3)).toBe(true);expect(canonicalJson(state)).toBe(before);
 });
 it("rejects missing support, narrow uncovered gaps and a water cell touched only by the footprint",()=>{
  const {state}=fixture();expect(createCombatPlacement(buildWorld([]),state).devicePlacementAllowed!(point,3)).toBe(false);
  const g=field();g.water![(102)*201+100]=1;expect(createCombatPlacement(buildWorld([tile(g)]),state).devicePlacementAllowed!(point,3)).toBe(false);
  const left={...field(),nx:100,heights:Array(100*201).fill(0),water:undefined},right={...field(base.x+.1),nx:100,heights:Array(100*201).fill(0),water:undefined};const gapWorld=buildWorld([{...tile(left),tileId:"left"},{...tile(right),tileId:"right"}]);expect(createCombatPlacement(gapWorld,state).devicePlacementAllowed!({...point,x:base.x-2},3)).toBe(false);
 });
 it("excludes protected polygons by the full footprint, buildings, drivable corridors and people/animal bodies",()=>{
  const area=PROTECTED_AREAS[0]!,ring=area.polygon.map(([lat,lon])=>toLocal(lat,lon)),inside={x:ring.reduce((sum,p)=>sum+p.x,0)/ring.length,z:ring.reduce((sum,p)=>sum+p.z,0)/ring.length,y:0},protectedWorld=buildWorld([tile(field(inside.x-100,inside.z-100))]);
  const {world,state}=fixture();expect(createCombatPlacement(protectedWorld,state).devicePlacementAllowed!(inside,.6)).toBe(false);
  const buildingWorld=buildWorld([{...tile(field()),buildings:[{id:"building",footprint:[[base.x+2,base.z-3],[base.x+5,base.z-3],[base.x+5,base.z+3],[base.x+2,base.z+3]],baseY:0,topY:10}]}]);expect(createCombatPlacement(buildingWorld,state).devicePlacementAllowed!(point,3)).toBe(false);
  const roads=buildWorld([tile(field())],{version:1,nodes:[{id:"a",x:base.x-100,z:base.z},{id:"b",x:base.x+100,z:base.z}],edges:[{id:"road",a:"a",b:"b",kind:"residential",lanes:2,oneway:false,widthM:8,points:[[base.x-100,base.z],[base.x+100,base.z]]}]});expect(createCombatPlacement(roads,state).devicePlacementAllowed!(point,3)).toBe(false);
  for(const actor of [person(base.x+3.9,base.z),{...person(base.x+3.9,base.z),kind:"animal" as const}])expect(createCombatPlacement(world,state,{actors:[actor]}).devicePlacementAllowed!(point,3)).toBe(false);
 });
 it("uses the complete oriented vehicle hull instead of only its centre/radius",()=>{
  const {world,state}=fixture();state.ext.agents={nextId:2,list:[{id:1,kind:"robotaxi",x:base.x+6,y:0,z:base.z,heading:1.5707963267948966,halfLength:8,halfWidth:1.2} as AgentState]};
  expect(createCombatPlacement(world,state).devicePlacementAllowed!(point,.6)).toBe(false);
 });
 it("derives a bounded desired point from recorded aim and actual accepted pose, ignoring claimed coordinates",()=>{
  const {world,state}=fixture(),placement=createCombatPlacement(world,state),player={id:"p",x:-1e6,y:0,z:-1e6,heading:0,speed:0,mount:"foot",tankTier:0,flowTier:0,scannerTier:1} as CombatPlayer;
  const target=placement.aimPlacement!(player,{aimYaw:0,aimPitch:0,targetX:-1e6,targetZ:-1e6},2)!;expect(target.x).toBe(state.players.p!.car.x);expect(target.z).toBeCloseTo(state.players.p!.car.z-2,8);expect(placement.aimPlacement!(player,{},201)).toBeNull();expect(placement.aimPlacement!({...player,id:"unknown"},{},2)).toBeNull();
 });
});
