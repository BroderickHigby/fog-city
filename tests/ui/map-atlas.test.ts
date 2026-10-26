import { describe, expect, it } from "vitest";
import { drawMap, mapCacheInfo, mapScale, releaseMapCache } from "../../src/ui/minimap.ts";
import { atlasFor, MAP_COLORS, MapAtlas, routeSegments } from "../../src/ui/map-atlas.ts";
import { mapCoordinates } from "../../src/ui/navigation.ts";
import { uiProjection } from "../../src/ui/projection.ts";
import { createInitialState } from "../../src/sim/step.ts";
import { buildWorld } from "../../src/sim/world.ts";
import type { RoadGraph } from "../../src/render/types.ts";
import type { MapGeography, UiView } from "../../src/ui/types.ts";

type Matrix=[number,number,number,number,number,number];
class RecordingContext {
  matrix:Matrix=[1,0,0,1,0,0];stack:Matrix[]=[];lines:number[][]=[];moves:number[][]=[];rects:number[][]=[];rotations:number[]=[];texts:string[]=[];strokeStyle:string|CanvasGradient|CanvasPattern="";fillStyle:string|CanvasGradient|CanvasPattern="";lineWidth=1;imageDraws=0;strokes:Array<{style:unknown;width:number}>=[];
  xy(x:number,y:number):number[]{const m=this.matrix;return[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];}
  setTransform(a:number,b:number,c:number,d:number,e:number,f:number){this.matrix=[a,b,c,d,e,f];}
  save(){this.stack.push([...this.matrix]);}restore(){this.matrix=this.stack.pop()!;}
  translate(x:number,y:number){const p=this.xy(x,y);this.matrix[4]=p[0]!;this.matrix[5]=p[1]!;}
  scale(x:number,y:number){this.matrix[0]*=x;this.matrix[1]*=x;this.matrix[2]*=y;this.matrix[3]*=y;}
  rotate(angle:number){this.rotations.push(angle);const m=this.matrix,c=Math.cos(angle),s=Math.sin(angle);this.matrix=[m[0]*c+m[2]*s,m[1]*c+m[3]*s,m[2]*c-m[0]*s,m[3]*c-m[1]*s,m[4],m[5]];}
  clearRect(){}fillRect(x:number,y:number,w:number,h:number){this.rects.push([...this.xy(x,y),w,h]);}beginPath(){}closePath(){}moveTo(x:number,y:number){this.moves.push(this.xy(x,y));}lineTo(x:number,y:number){this.lines.push(this.xy(x,y));}stroke(){this.strokes.push({style:this.strokeStyle,width:this.lineWidth});}strokeRect(){}arc(){}fill(){}fillText(text:string){this.texts.push(text);}strokeText(){}measureText(text:string){return{width:text.length*5};}drawImage(){this.imageDraws++;}
}
function canvas(cached=false,ratio=1){
  const context=new RecordingContext();
  const value={width:200,height:200,getContext:()=>context,...(cached?{ownerDocument:{defaultView:{devicePixelRatio:ratio},createElement:()=>canvas(false).value}}:{})} as unknown as HTMLCanvasElement;
  return{value,context};
}
const points:[[number,number],[number,number],[number,number]]=[[0,0],[50,-50],[100,0]];
const roads:RoadGraph={version:1,nodes:[{id:"a",x:0,z:0},{id:"b",x:100,z:0}],edges:[{id:"sf-bend",a:"a",b:"b",points,kind:"arterial",lanes:2,widthM:14,oneway:false,name:"SF Bend"}]};
const view=():UiView=>({tick:0,playerId:"p",x:0,z:0,heading:0,speedMps:0,runwayMonths:1,cashCents:0,reputation:0,waterLitres:8,capacityLitres:8,salt:false,threat:0,map:{nodes:roads.nodes,edges:[{from:"a",to:"b",points,widthM:14,name:"SF Bend"}],blips:[],radius:100}});
const geography=():MapGeography=>({roads,tiles:[{tileId:"sf-tile",ground:null,buildings:[{id:"actual-building",footprint:[[20,20],[40,20],[40,40],[20,40]],baseY:0,topY:30}]}],boundary:{version:1,edges:[],shore:[{closed:false,points:[[80,-100],[80,100]]}]},districts:{districts:[{name:"Golden Gate Park",polygons:[[[[-40,-40],[-20,-40],[-20,-20],[-40,-20]]]]},{name:"Not a park",polygons:[[[[0,0],[1,0],[1,1]]]]}]}});

it("draws the actual curved SF road polyline rather than connecting only its graph endpoints",()=>{
  const target=canvas();drawMap(target.value,view(),200,0,100);
  expect(target.context.lines).toContainEqual([150,50]);
  expect(target.context.strokes).toContainEqual({style:MAP_COLORS.street,width:14});
});
it("keeps world north fixed while the player arrow turns",()=>{
  expect(mapCoordinates({x:0,z:-50},{x:0,z:0},0,100,200)).toEqual({x:100,z:50});
  const target=canvas();drawMap(target.value,{...view(),heading:Math.PI/2},200);
  expect(target.context.lines).toContainEqual([150,50]);expect(target.context.rotations.at(-1)).toBe(Math.PI/2);
  expect(target.context.texts).toContain("N");expect(target.context.texts.some(text=>text.endsWith(" m"))).toBe(true);
});
it("paints building footprints, parks and shoreline in the same metre frame without copying source vertices",()=>{
  const source=geography(),atlas=new MapAtlas(source),features=atlas.query([-100,-100,100,100]);
  const building=features.find(f=>f.kind==="building")!;expect(building.kind).toBe("building");if(building.kind==="building")expect(building.rings[0]).toBe(source.tiles[0]!.buildings[0]!.footprint);
  const road=features.find(f=>f.kind==="road")!;expect(road.kind).toBe("road");if(road.kind==="road")expect(road.points).toBe(points);
  expect(features.filter(f=>f.kind==="park")).toHaveLength(1);expect(features.filter(f=>f.kind==="shore")).toHaveLength(1);
  const target=canvas(),v=view();drawMap(target.value,{...v,map:{...v.map!,geography:source}},200);
  expect(target.context.moves).toContainEqual([120,120]);expect(target.context.lines).toContainEqual([140,140]);
  expect(source.tiles[0]!.buildings[0]!.footprint).toEqual([[20,20],[40,20],[40,40],[20,40]]);
});
it("uses actual directed curved route edges for the phone and mini map",()=>{
  const state=createInitialState(buildWorld([]),1,["p"],{x:0,z:0,heading:0}),source=geography();
  const projection=uiProjection(state,"p",roads,{x:100,z:0},2,undefined,source),map=projection.map!;
  expect(map.geography).toBe(source);expect(map.edges[0]!.points).toBe(points);expect(map.edges[0]!.length).toBeCloseTo(2*Math.hypot(50,50));
  expect(map.edges[1]!.reversed).toBe(true);
  const outward=routeSegments(map,roads.nodes[0]!,roads.nodes[1]!),back=routeSegments(map,roads.nodes[1]!,roads.nodes[0]!);
  expect(outward[0]!.points).toBe(points);expect(outward[0]!.reversed).toBe(false);expect(back[0]!.reversed).toBe(true);
  const target=canvas();drawMap(target.value,projection,200,0,100);
  expect(target.context.strokes).toContainEqual({style:MAP_COLORS.route,width:3.5});
  expect(routeSegments({...map,edges:[map.edges[0]!]},roads.nodes[1]!,roads.nodes[0]!)).toHaveLength(0);
});
it("draws the same shortest parallel SF edge chosen by the directed route solver",()=>{
  const shortest:readonly (readonly [number,number])[]=[[0,0],[100,0]],detour:readonly (readonly [number,number])[]=[[0,0],[50,200],[100,0]];
  const map={nodes:roads.nodes,edges:[{from:"a",to:"b",length:100,points:shortest},{from:"a",to:"b",length:420,points:detour},{from:"a",to:"b",length:NaN,points:detour}],blips:[]};
  expect(routeSegments(map,roads.nodes[0]!,roads.nodes[1]!)[0]!.points).toBe(shortest);
});
it("reuses bounded offscreen geography across blips, heading and small movement, and invalidates for travel/zoom/source",()=>{
  const target=canvas(true,2),v=view(),source=geography(),current={...v,map:{...v.map!,geography:source}};
  drawMap(target.value,current,200);expect(mapCacheInfo(target.value)).toMatchObject({paints:1,width:800,height:800});
  drawMap(target.value,{...current,tick:60,heading:1,x:20,z:5,map:{...current.map,blips:[{id:"target",kind:"bounty",label:"Robot",x:30,z:20}]}},200);
  expect(mapCacheInfo(target.value)?.paints).toBe(1);expect(target.context.imageDraws).toBe(2);
  drawMap(target.value,{...current,x:250},200);expect(mapCacheInfo(target.value)?.paints).toBe(2);
  drawMap(target.value,current,200,0,50);expect(mapCacheInfo(target.value)?.paints).toBe(3);
  const other=geography();drawMap(target.value,{...current,map:{...current.map,geography:other}},200);expect(mapCacheInfo(target.value)?.paints).toBe(4);
  expect(atlasFor(current.map)).toBe(atlasFor(current.map));expect(atlasFor(current.map)).not.toBe(atlasFor({...current.map,geography:other}));
  drawMap(target.value,current,600);expect(mapCacheInfo(target.value)!.width).toBeLessThanOrEqual(1024);
  releaseMapCache(target.value);expect(mapCacheInfo(target.value)).toBeNull();
});
it("has finite fallback rendering and useful metric scales without world metadata",()=>{
  const target=canvas();expect(()=>drawMap(target.value,{...view(),map:undefined},200,0,NaN)).not.toThrow();
  expect(mapScale(100,200)).toEqual({metres:20,pixels:20,label:"20 m"});expect(mapScale(5000,400).label).toBe("2 km");
  const empty=atlasFor(undefined);expect(empty.features).toBe(0);expect(empty.query([0,0,100,100])).toEqual([]);
  const state=createInitialState(buildWorld([]),1,["p"],{x:0,z:0,heading:0}),first=uiProjection(state,"p",null),second=uiProjection(state,"p",null);
  expect(first.map!.edges).toBe(second.map!.edges);expect(atlasFor(first.map)).toBe(atlasFor(second.map));
});
it("uses the loaded ground water mask rather than invented coast geography",()=>{
  const source:MapGeography={roads:null,boundary:null,tiles:[{tileId:"water",buildings:[],ground:{x0:0,z0:0,nx:3,nz:2,cellSizeM:10,heights:[0,0,0,0,0,0],water:[0,1,1,0,1,1]}}]};
  const target=canvas(),v={...view(),x:0,z:0,map:{nodes:[],edges:[],blips:[],geography:source}};drawMap(target.value,v,200,0,100);
  expect(atlasFor(v.map).hasGround).toBe(true);expect(target.context.rects).toContainEqual([100,100,10,10]);
});
