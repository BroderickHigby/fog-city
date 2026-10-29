import { MISSIONS } from "../../content/catalog.ts";
import { ACTIVITIES,SITES } from "../../content/places.ts";
import { VENDOR } from "../../content/vendor.ts";
import { CITY_DIRECTOR_CARDS } from "../../content/cityLife.ts";
import { STARTUP_KITS } from "../../content/kits.ts";
import { ACTIVITY_DEFINITIONS,PROGRESSION } from "../../content/gameplay.ts";
import { toLocal } from "../../geo/project.ts";
import type { GameplayContext,GameplaySite } from "./types.ts";
import { activityAvailable,legacyActivityAvailable } from "../activities/availability.ts";
import legacyActivities from "./legacy-activity-definitions.json" with { type: "json" };

const sites:GameplaySite[]=SITES.map(site=>({...toLocal(site.lat,site.lon),y:0,id:site.id,kind:site.kind,wave:site.wave,radius:25}));
for(const vendor of VENDOR.vendors){const site=sites.find(s=>s.id===vendor.site);if(site)sites.push({...site,kind:"vendor",vendorItems:vendor.items});}
for(const activity of ACTIVITIES)if(activity.kind==="carWash"||activity.kind==="repairKiosk")sites.push({...toLocal(activity.lat,activity.lon),y:0,id:activity.id,kind:activity.kind,wave:activity.wave,radius:15});
/** Main's activity definitions before SIM_VERSION 27: main's ids only, each changed one as main had it. */
const LEGACY_DEFINITIONS:typeof ACTIVITY_DEFINITIONS=ACTIVITY_DEFINITIONS.filter(def=>legacyActivities.ids.includes(def.id)).map(def=>((legacyActivities.definitions as Record<string,unknown>)[def.id] as typeof def|undefined)??def);
export const LEGACY_CATALOG:Pick<GameplayContext,"missions"|"items"|"sites"|"directorCards"|"activities"|"validKitIds">={
 missions:MISSIONS.filter(mission=>mission.id!=="office-hours"),items:VENDOR.items,sites,
 directorCards:CITY_DIRECTOR_CARDS,
 activities:[...ACTIVITIES.filter(activity=>!LEGACY_DEFINITIONS.some(def=>def.id===activity.id)).map(activity=>({...toLocal(activity.lat,activity.lon),y:0,id:activity.id,kind:activity.kind,wave:activity.wave,radius:25})),...LEGACY_DEFINITIONS.filter(def=>def.wave<=3).map(def=>({id:def.id,kind:def.kind,wave:def.wave,...toLocal(def.checkpoints[0]!.lat,def.checkpoints[0]!.lon),y:0,radius:def.checkpoints[0]!.radiusM,rewardCents:def.reward.cashCents,rewardXp:def.reward.xp,objective:def.objective,timeLimitS:def.timeLimitS,repeatable:def.repeatable,cooldownS:def.cooldownS,checkpoints:def.checkpoints.map(point=>({id:point.id,...toLocal(point.lat,point.lon),y:0,radius:point.radiusM}))}))].filter(legacyActivityAvailable),
 validKitIds:STARTUP_KITS.map(kit=>kit.id),
};

/** SIM21 adds only measured activity producers and authored property/upgrade choices. */
const upgrades=PROGRESSION.upgrades.filter(item=>item.priceCents>0).map(item=>({id:item.id,kind:item.kind,priceCents:item.priceCents,rank:item.rank,wave:4,effect:{}}));
const modernSites=sites.map(site=>({...site,...(PROGRESSION.safehousePrices.find(price=>price.id===site.id)??{}),...(site.vendorItems?{vendorItems:[...new Set([...site.vendorItems,...upgrades.map(item=>item.id)])]}:{})}));
export const DEFAULT_CATALOG:typeof LEGACY_CATALOG={
 ...LEGACY_CATALOG,missions:MISSIONS,items:[...VENDOR.items.filter(item=>!upgrades.some(upgrade=>upgrade.id===item.id)),...upgrades],sites:modernSites,
 activities:[...ACTIVITIES.filter(activity=>!ACTIVITY_DEFINITIONS.some(def=>def.id===activity.id)).map(activity=>({...toLocal(activity.lat,activity.lon),y:0,id:activity.id,kind:activity.kind,wave:activity.wave,radius:25})).filter(activityAvailable),...ACTIVITY_DEFINITIONS.map(def=>({id:def.id,kind:def.kind,wave:def.wave,...toLocal(def.checkpoints[0]!.lat,def.checkpoints[0]!.lon),y:0,radius:def.checkpoints[0]!.radiusM,rewardCents:def.reward.cashCents,rewardXp:def.reward.xp,objective:def.objective,timeLimitS:def.timeLimitS,repeatable:def.repeatable,cooldownS:def.cooldownS,...("maxSpeedMps" in def?{maxSpeedMps:def.maxSpeedMps}:{}),checkpoints:def.checkpoints.map(point=>({id:point.id,...toLocal(point.lat,point.lon),y:0,radius:point.radiusM}))}))].filter(activityAvailable),
};
