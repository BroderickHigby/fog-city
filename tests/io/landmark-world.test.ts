import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PALACE_LAYOUT, replaceLandmarkWorld } from "../../src/io/landmark-world.ts";
import { assembleWorldFiles, buildLoadedWorld } from "../../src/io/world-load.ts";
import { worldFingerprint } from "../../src/net/world-id.ts";
import { buildWorld, circleBlocked, circleBlockedBand, groundHeight, meshGroundHeight, type TileCollider } from "../../src/sim/world.ts";
import { toLocal } from "../../src/geo/project.ts";
import { encodeWorldColliders } from "../../pipeline/lib/world-colliders.ts";

const tile = JSON.parse(readFileSync(new URL("../../public/tiles/sf/t-10_-2.collider.json", import.meta.url), "utf8")) as TileCollider;
const manifest = {world:"sf",spawn:{x:0,z:0,heading:0},tiles:[{id:tile.tileId,collider:`${tile.tileId}.collider.json`}]};
const origin = toLocal(PALACE_LAYOUT.origin.lat,PALACE_LAYOUT.origin.lon);
function placed(x:number,z:number):[number,number]{
  const a=PALACE_LAYOUT.origin.headingDeg*Math.PI/180;
  return [origin.x+Math.cos(a)*x-Math.sin(a)*z,origin.z+Math.sin(a)*x+Math.cos(a)*z];
}

describe("Palace static world replacement",()=>{
  it("opens the real rotunda interior and keeps individual columns solid through the world loader",()=>{
    const original=JSON.stringify(tile),raw=buildWorld([tile]);
    expect(circleBlocked(raw,origin.x,origin.z,.35)).toBe(true); // previous solid extrusion
    const files=assembleWorldFiles(manifest,{json:[tile]},null,null),world=buildLoadedWorld(files);
    expect(circleBlocked(world,origin.x,origin.z,.35)).toBe(false);
    for(const distance of [-32,-20,-10,0,10,20,32]){
      for(const [x,z] of [placed(distance,0),placed(0,distance)]){
        const floor=meshGroundHeight(world,x,z);
        expect(circleBlockedBand(world,x,z,.3,floor+.5,floor+1.8),`${distance} at ${x},${z}`).toBe(false);
      }
    }
    const column=files.landmarkReplacements![0]!.colliders.find(c=>c.id.startsWith("palace:column:"))!;
    const x=column.footprint.reduce((sum,p)=>sum+p[0],0)/column.footprint.length;
    const z=column.footprint.reduce((sum,p)=>sum+p[1],0)/column.footprint.length;
    expect(circleBlockedBand(world,x,z,.25,column.baseY+.6,column.baseY+1.8)).toBe(true);
    const dome=files.landmarkReplacements![0]!.colliders.find(c=>c.id.startsWith("palace:dome:"))!;
    expect(dome.underY).toBeGreaterThan(30);
    expect(circleBlockedBand(world,origin.x,origin.z,.25,2,4)).toBe(false);
    expect(circleBlockedBand(world,origin.x,origin.z,.25,dome.underY!+.1,dome.underY!+1)).toBe(true);
    expect(JSON.stringify(tile)).toBe(original);
    expect(files.tiles[0]!.ground).toBe(tile.ground);
    const hall=tile.buildings.find(b=>b.id==="201006.0000031")!;
    expect(files.tiles[0]!.buildings.find(b=>b.id===hall.id)).toBe(hall);
    expect(groundHeight(world,origin.x,origin.z)).toBe(groundHeight(raw,origin.x,origin.z));
  });

  it("applies identically to packed and JSON worlds and fingerprints collision changes",()=>{
    const pack=encodeWorldColliders({origin:{lat:37.7955,lon:-122.3937},tileSizeM:500,tiles:[{
      ...tile,ix:-10,iz:-2,ground:tile.ground as NonNullable<TileCollider["ground"]>&{water:number[]},
    }]});
    const json=assembleWorldFiles(manifest,{json:[tile]},null,null);
    const packed=assembleWorldFiles(manifest,{pack},null,null);
    expect(packed.landmarkReplacements![0]!.colliders).toEqual(json.landmarkReplacements![0]!.colliders);
    expect(worldFingerprint(packed)).toBe(worldFingerprint(json));
    const before={...json,landmarkReplacements:undefined};
    expect(worldFingerprint(json)).not.toBe(worldFingerprint(before));
    const changed=structuredClone(json);
    changed.landmarkReplacements![0]!.colliders[0]!.topY+=.1;
    expect(worldFingerprint(changed)).not.toBe(worldFingerprint(json));
  });

  it("leaves other worlds and unrelated tiles untouched; rejects a partial source replacement",()=>{
    const elsewhere=replaceLandmarkWorld([tile],"dev");
    expect(elsewhere.tiles[0]).toBe(tile);expect(elsewhere.landmarkReplacements).toBeUndefined();
    const empty={...tile,buildings:[]};
    expect(replaceLandmarkWorld([empty],"sf").tiles[0]).toBe(empty);
    const partial={...tile,buildings:tile.buildings.filter(b=>b.id!==PALACE_LAYOUT.replacesBuildingIds[0])};
    expect(()=>replaceLandmarkWorld([partial],"sf")).toThrow("expected 6 source buildings, found 5");
  });
});
