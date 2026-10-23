import {MISSIONS} from "../content/catalog.ts";
import type {Mission} from "../content/missions.ts";

/** Standalone authoring fixtures never enter the automatic campaign sequence. */
export function nextCampaignMission(completedIds:readonly string[],wave:number):Mission|undefined {
  const completed=new Set(completedIds);
  return MISSIONS.filter(mission=>mission.campaign!==undefined&&(mission.wave??2)<=wave&&!completed.has(mission.id))
    .sort((a,b)=>a.campaign!-b.campaign!)[0];
}
