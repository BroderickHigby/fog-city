import { toLocal } from "../geo/project.ts";
import { parseLandmarks } from "../render/landmarks.ts";
import type { MapBlip } from "./types.ts";

const labels: Readonly<Record<string, string>> = {
  "ferry-building": "Ferry Building",
  "r-evolution": "R-evolution",
  "palace-of-fine-arts": "Palace of Fine Arts",
  "coit-tower": "Coit Tower",
  "415-mission": "Salesforce Tower",
  "600-montgomery": "Transamerica Pyramid",
  "city-hall": "San Francisco City Hall",
  "sutro-tower": "Sutro Tower",
  "golden-gate-bridge": "Golden Gate Bridge",
  "bay-bridge-west": "Bay Bridge west span",
  "grace-cathedral": "Grace Cathedral",
  "dragon-gate": "Dragon Gate",
  "mission-dolores": "Mission Dolores",
  "conservatory-of-flowers": "Conservatory of Flowers",
  "sutro-baths": "Sutro Baths",
};

/** Map destinations come from the same placements as the architectural models. */
export function landmarkBlips(document: unknown): MapBlip[] {
  return parseLandmarks(document).entries.filter(entry => labels[entry.id]).map(entry => ({
    id: entry.id, kind: "landmark", label: labels[entry.id]!, ...toLocal(entry.viewpoint?.lat??entry.lat, entry.viewpoint?.lon??entry.lon),
  }));
}
