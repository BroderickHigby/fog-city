import { toLocal } from "../geo/project.ts";
import { parseLandmarks } from "../render/landmarks.ts";
import type { MapBlip } from "./types.ts";

const labels: Readonly<Record<string, string>> = {
  "ferry-building": "Ferry Building",
  "r-evolution": "R-evolution",
  "palace-of-fine-arts": "Palace of Fine Arts",
};

/** Map destinations come from the same placements as the architectural models. */
export function landmarkBlips(document: unknown): MapBlip[] {
  return parseLandmarks(document).entries.filter(entry => labels[entry.id]).map(entry => ({
    id: entry.id, kind: "landmark", label: labels[entry.id]!, ...toLocal(entry.lat, entry.lon),
  }));
}
