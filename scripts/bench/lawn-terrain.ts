// Cloud/CI-only geometry audit. Does not launch the game or a browser.
// node scripts/bench/lawn-terrain.ts [output.json]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { loadWorld, ROOT } from "../../tests/helpers.ts";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
import { LawnTerrain } from "../../src/render/lawn-terrain.ts";
import { createPavementMask } from "../../src/render/pavement.ts";
import { onFarLattice } from "../../src/render/far-layer.ts";
import { tileLayer } from "../../src/render/materials.ts";
import type { Manifest, RoadGraph } from "../../src/render/types.ts";

const base=join(ROOT,"public/tiles/sf");
const {world,manifest}=loadWorld("sf");
const t0=performance.now(),lawns=new LawnTerrain(JSON.parse(readFileSync(join(base,"street-grass.json"),"utf8")));
const roads=JSON.parse(readFileSync(join(base,"roads.json"),"utf8")) as RoadGraph;
const pavement=createPavementMask(roads,new Map(world.tiles.map(t=>[t.tileId,t])),lawns.regions);
const setupMs=performance.now()-t0, loader=createTileLoader();
const results:Array<{file:string;kind:string;before:number;after:number;added:number;ms:number;maxEventLoopGapMs:number}>=[];
async function inspect(file:string,kind:"near"|"far"):Promise<void> {
  const bytes=readFileSync(join(base,file));
  const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),"");
  gltf.scene.updateMatrixWorld(true);
  const meshes:THREE.Mesh[]=[];
  gltf.scene.traverse(o=>{const mesh=o as THREE.Mesh;if(mesh.isMesh)meshes.push(mesh);});
  for(const mesh of meshes){
    const material=Array.isArray(mesh.material)?mesh.material[0]!:mesh.material;
    if(kind==="near"&&tileLayer(material.name,mesh.name)!=="ground")continue;
    const geo=mesh.geometry,before=(geo.index?.count??geo.getAttribute("position").count)/3,start=performance.now();
    let lastBeat=performance.now(),maxEventLoopGapMs=0;
    const heartbeat=setInterval(()=>{const now=performance.now();maxEventLoopGapMs=Math.max(maxEventLoopGapMs,now-lastBeat);lastBeat=now;},0);
    let added:number;
    try {added=await lawns.paintAsync(geo,mesh.matrixWorld,pavement,kind==="far"?onFarLattice:undefined);}
    finally {clearInterval(heartbeat);maxEventLoopGapMs=Math.max(maxEventLoopGapMs,performance.now()-lastBeat);}

    const ms=performance.now()-start,after=(geo.index?.count??geo.getAttribute("position").count)/3;
    results.push({file,kind,before,after,added,ms,maxEventLoopGapMs});
  }
  gltf.scene.traverse(o=>{const mesh=o as THREE.Mesh;if(mesh.isMesh){mesh.geometry.dispose();for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material])m.dispose();}});
}
for(const far of (manifest as Manifest).far??[]) await inspect(far.glb,"far");
// Every terrain tile intersecting a mapped lawn, not just showcase neighbourhoods.
for(const tile of manifest.tiles) {
  const box=tile.bbox;
  if(!tile.glb||!box||!lawns.regions.some(b=>b[0]<=box[2]!&&b[2]>=box[0]!&&b[1]<=box[3]!&&b[3]>=box[1]!))continue;
  await inspect(tile.glb,"near");
}
const sum=(kind:string,key:"before"|"after"|"added")=>results.filter(r=>r.kind===kind).reduce((n,r)=>n+r[key],0);
const report={setupMs,meshes:results.length,farBefore:sum("far","before"),farAfter:sum("far","after"),nearAdded:sum("near","added"),maxPaintMs:Math.max(...results.map(r=>r.ms)),maxEventLoopGapMs:Math.max(...results.map(r=>r.maxEventLoopGapMs)),totalPaintMs:results.reduce((n,r)=>n+r.ms,0),peakRssBytes:process.resourceUsage().maxRSS*1024,results};
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({...report,results:undefined},null,2));
if(report.farAfter>600000)throw new Error("Persistent lawn terrain exceeds the 600k far-triangle budget");
