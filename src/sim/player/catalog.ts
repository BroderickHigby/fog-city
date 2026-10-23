import { MISSIONS } from "../../content/catalog.ts";
import { ACTIVITIES,SITES } from "../../content/places.ts";
import { VENDOR } from "../../content/vendor.ts";
import { DIRECTOR_CARDS } from "../../content/directorCards.ts";
import { STARTUP_KITS } from "../../content/kits.ts";
import { ACTIVITY_DEFINITIONS } from "../../content/gameplay.ts";
import { toLocal } from "../../geo/project.ts";
import type { GameplayContext,GameplaySite } from "./types.ts";

const sites:GameplaySite[]=SITES.map(site=>({...toLocal(site.lat,site.lon),y:0,id:site.id,kind:site.kind,wave:site.wave,radius:25}));
for(const vendor of VENDOR.vendors){const site=sites.find(s=>s.id===vendor.site);if(site)sites.push({...site,kind:"vendor",vendorItems:vendor.items});}
for(const activity of ACTIVITIES)if(activity.kind==="carWash"||activity.kind==="repairKiosk")sites.push({...toLocal(activity.lat,activity.lon),y:0,id:activity.id,kind:activity.kind,wave:activity.wave,radius:15});
export const DEFAULT_CATALOG:Pick<GameplayContext,"missions"|"items"|"sites"|"directorCards"|"activities"|"validKitIds">={
 missions:MISSIONS,items:VENDOR.items,sites,
 directorCards:DIRECTOR_CARDS.cards,
 activities:[...ACTIVITIES.filter(activity=>!ACTIVITY_DEFINITIONS.some(def=>def.id===activity.id)).map(activity=>({...toLocal(activity.lat,activity.lon),y:0,id:activity.id,kind:activity.kind,wave:activity.wave,radius:25})),...ACTIVITY_DEFINITIONS.filter(def=>def.wave<=3).map(def=>({id:def.id,kind:def.kind,wave:def.wave,...toLocal(def.checkpoints[0]!.lat,def.checkpoints[0]!.lon),y:0,radius:def.checkpoints[0]!.radiusM,rewardCents:def.reward.cashCents,rewardXp:def.reward.xp,objective:def.objective,timeLimitS:def.timeLimitS,repeatable:def.repeatable,cooldownS:def.cooldownS,checkpoints:def.checkpoints.map(point=>({id:point.id,...toLocal(point.lat,point.lon),y:0,radius:point.radiusM}))}))],
 validKitIds:STARTUP_KITS.map(kit=>kit.id),
};
