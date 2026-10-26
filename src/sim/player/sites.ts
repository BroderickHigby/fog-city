import { planarDistanceSquared } from "./common.ts";
import type { GameplayBody,GameplaySite } from "./types.ts";

/** Catalog sites are map locations: their placeholder y is not a physical floor. */
export function canInteractAtSite(body:Pick<GameplayBody,"x"|"z"|"speed">,site:Pick<GameplaySite,"x"|"z"|"radius">):boolean {
 return Number.isFinite(body.speed)&&Math.abs(body.speed)<=3&&Number.isFinite(site.radius)&&site.radius>=0&&planarDistanceSquared(body,site)<=site.radius*site.radius;
}
