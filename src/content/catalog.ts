// Static authored catalogs. Safe to import in the browser or deterministic simulation:
// no filesystem, clock, network, random source, or runtime side effects.
import hotDesk from "../../content/missions/hot-desk.json" with { type: "json" };
import spill from "../../content/missions/spill.json" with { type: "json" };
import partnerMeeting from "../../content/missions/ramen-pitch.json" with { type: "json" };
import launchDay from "../../content/missions/launch-day.json" with { type: "json" };
import demoedCorrectly from "../../content/missions/demoed-correctly.json" with { type: "json" };
import officeHours from "../../content/missions/office-hours.json" with { type: "json" };
import demoDay from "../../content/missions/demo-day.json" with { type: "json" };
import fleetWeek from "../../content/missions/fleet-week.json" with { type: "json" };
import hillClimb from "../../content/missions/hill-climb.json" with { type: "json" };
import acquiHireOffer from "../../content/missions/acqui-hire-offer.json" with { type: "json" };
import marineLayer from "../../content/missions/marine-layer.json" with { type: "json" };
import comebackRound from "../../content/missions/comeback-round.json" with { type: "json" };
import activities from "../../content/activities.json" with { type: "json" };
import safehouses from "../../content/safehouses.json" with { type: "json" };
import instances from "../../content/modes/instances.json" with { type: "json" };
import { type Mission } from "./missions.ts";
export { VENDOR } from "./vendor.ts";
export { DIRECTOR_CARDS } from "./directorCards.ts";

export const MISSIONS: readonly Mission[] = [hotDesk, spill, launchDay, demoedCorrectly, demoDay, fleetWeek, hillClimb, acquiHireOffer, marineLayer, comebackRound, partnerMeeting, officeHours] as unknown as readonly Mission[];
export const CAMPAIGN_MISSIONS: readonly Mission[] = MISSIONS.filter((mission) => mission.campaign !== undefined);
export const ACTIVITIES = activities.activities;
export const SAFEHOUSES = safehouses.sites;
export const MODE_INSTANCES = instances.instances;
/** Stable presentation keys; the simulation never parses this text. */
export const MISSION_OBJECTIVES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  MISSIONS.flatMap((mission) => mission.steps.flatMap((step) => step.type === "objective" && step.hint ? [[`${mission.id}.${step.id}`, step.hint]] : [])),
));
/** Exact facts that runtime integrations must produce from observed gameplay. */
export const MISSION_FACTS: readonly string[] = Object.freeze([...new Set(MISSIONS.flatMap((mission) =>
  mission.steps.flatMap((step) => step.type === "objective" && step.objective.event ? [step.objective.event] : []),
))].sort());

export function missionById(id: string): Mission {
  const mission = MISSIONS.find((candidate) => candidate.id === id);
  if (!mission) throw new Error(`Unknown mission: ${id}`);
  return mission;
}
