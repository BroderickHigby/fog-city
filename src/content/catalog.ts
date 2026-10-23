import launch_day from "../../content/missions/launch-day.json" with { type: "json" };
import demod_correctly from "../../content/missions/demod-correctly.json" with { type: "json" };
import demo_day from "../../content/missions/demo-day.json" with { type: "json" };
import fleet_week from "../../content/missions/fleet-week.json" with { type: "json" };
import hill_climb from "../../content/missions/hill-climb.json" with { type: "json" };
import acqui_hire_offer from "../../content/missions/acqui-hire-offer.json" with { type: "json" };
import marine_layer from "../../content/missions/marine-layer.json" with { type: "json" };
import comeback_round from "../../content/missions/comeback-round.json" with { type: "json" };
// Static authored catalogs. Safe to import in the browser or deterministic simulation:
// no filesystem, clock, network, random source, or runtime side effects.
import hotDesk from "../../content/missions/hot-desk.json" with { type: "json" };
import spill from "../../content/missions/spill.json" with { type: "json" };
import partnerMeeting from "../../content/missions/ramen-pitch.json" with { type: "json" };
import activities from "../../content/activities.json" with { type: "json" };
import safehouses from "../../content/safehouses.json" with { type: "json" };
import instances from "../../content/modes/instances.json" with { type: "json" };
import { type Mission } from "./missions.ts";
export { VENDOR } from "./vendor.ts";
export { DIRECTOR_CARDS } from "./directorCards.ts";

export const MISSIONS: readonly Mission[] = [hotDesk, spill, launch_day, demod_correctly, demo_day, fleet_week, hill_climb, acqui_hire_offer, marine_layer, comeback_round, partnerMeeting] as unknown as readonly Mission[];
export const CAMPAIGN_MISSIONS: readonly Mission[] = MISSIONS.filter((mission) => mission.campaign !== undefined);
export const ACTIVITIES = activities.activities;
export const SAFEHOUSES = safehouses.sites;
export const MODE_INSTANCES = instances.instances;

export function missionById(id: string): Mission {
  const mission = MISSIONS.find((candidate) => candidate.id === id);
  if (!mission) throw new Error(`Unknown mission: ${id}`);
  return mission;
}
