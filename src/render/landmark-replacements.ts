import { parseLandmarks } from "./landmarks.ts";
import type { TileCollider } from "../sim/world.ts";
import type { LandmarkWorldReplacement } from "../io/landmark-world.ts";

/** Render-only massing replacement. Never mutates the world's collision packet.
 * Generic record fallbacks keep both near/far sites visible until the real model arrives. */
export function landmarkRenderReplacements(document:unknown,tiles:Iterable<TileCollider>,authored:readonly LandmarkWorldReplacement[]=[]):LandmarkWorldReplacement[]{
  const covered=new Set(authored.map(entry=>entry.id)),byId=new Map<string,TileCollider["buildings"][number]>();
  const entries=parseLandmarks(document).entries.filter(entry=>!covered.has(entry.id)&&entry.replacesBuildingIds?.length);
  const wanted=new Set(entries.flatMap(entry=>entry.replacesBuildingIds??[]));
  for(const tile of tiles)for(const building of tile.buildings)if(wanted.has(building.id))byId.set(building.id,building);
  return [...authored,...entries.flatMap(entry=>{
    const sources=(entry.replacesBuildingIds??[]).flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);
    return sources.length?[{id:entry.id,version:1,sources,colliders:sources}]:[];
  })];
}
