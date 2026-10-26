// Authored landmark collision is static world data, never tied to a model-load promise.
// Browser, relay and replay clients all replace the same source records before indexing.
import palace from "../../content/palace-of-fine-arts.json" with { type: "json" };
import { toLocal } from "../geo/project.ts";
import { buildWorld, groundHeight, type BuildingCollider, type TileCollider } from "../sim/world.ts";
import { dcos, dsin } from "../sim/dmath.ts";

export interface LandmarkWorldReplacement {
  id: string;
  version: number;
  /** Original records retained only for hiding their baked near/far rendering. */
  sources: BuildingCollider[];
  /** The model's individual solid parts, in world coordinates. */
  colliders: BuildingCollider[];
}

export const PALACE_LAYOUT = palace;

export function replaceLandmarkWorld(tiles:TileCollider[],world:string|undefined):{tiles:TileCollider[];landmarkReplacements?:LandmarkWorldReplacement[]} {
  if(world!==palace.world)return {tiles};
  const ids=new Set(palace.replacesBuildingIds);
  const sources=tiles.flatMap(tile=>tile.buildings.filter(b=>ids.has(b.id)));
  // A small test/partial world that contains none of this site is left untouched.
  if(sources.length===0)return {tiles};
  if(sources.length!==ids.size)throw new Error(`Palace landmark expected ${ids.size} source buildings, found ${sources.length}`);
  const origin=toLocal(palace.origin.lat,palace.origin.lon);
  const target=tiles.find(t=>{
    const g=t.ground;
    return g&&origin.x>=g.x0&&origin.z>=g.z0&&origin.x<=g.x0+(g.nx-1)*g.cellSizeM&&origin.z<=g.z0+(g.nz-1)*g.cellSizeM;
  });
  if(!target)throw new Error("Palace landmark has no ground at its origin");
  // Same bilinear placement as LandmarkLayer's ground callback, without building the
  // full city's spatial index a second time. Ground samples themselves are unchanged.
  const y=groundHeight(buildWorld([{tileId:target.tileId,ground:target.ground,buildings:[]}]),origin.x,origin.z);
  const heading=palace.origin.headingDeg*Math.PI/180,c=dcos(heading),s=dsin(heading);
  const colliders:BuildingCollider[]=palace.colliders.map(part=>({
    id:part.id,
    footprint:part.footprint.map(([x,z])=>[origin.x+c*x!-s*z!,origin.z+s*x!+c*z!]),
    baseY:y+part.baseY,
    topY:y+part.topY,
    ...("underY" in part?{underY:y+part.underY!}:{}),
  }));
  return {
    tiles:tiles.map(tile=>{
      if(tile!==target&&!tile.buildings.some(b=>ids.has(b.id)))return tile;
      return {...tile,buildings:[...tile.buildings.filter(b=>!ids.has(b.id)),...(tile===target?colliders:[])]};
    }),
    landmarkReplacements:[{id:palace.id,version:palace.version,sources,colliders}],
  };
}
