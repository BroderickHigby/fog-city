// Versions below 27 run LEGACY_CATALOG. It must be the catalog main had at 4e9b2553 (SIM_VERSION 26),
// so a v21-v26 save or replay offers the same activities on the same routes. The fixture is main's
// computed DEFAULT_CATALOG, written from main's own code, not from this branch's frozen definitions.
import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG, LEGACY_CATALOG } from "../../../src/sim/player/catalog.ts";
import { activityAvailable, legacyActivityAvailable } from "../../../src/sim/activities/availability.ts";
import main from "./fixtures/legacy-catalog-main-4e9b2553.json";

describe("the legacy (below SIM_VERSION 27) catalog is main's", () => {
  it("offers main's activities with main's checkpoints, rewards and order", () => {
    expect(JSON.parse(JSON.stringify(LEGACY_CATALOG.activities))).toEqual(main.activities);
  });
  it("keeps main's routes for the activities whose content moved (embarcadero-sprint, hill-delivery)", () => {
    for (const id of ["embarcadero-sprint", "hill-delivery"]) {
      const legacy = LEGACY_CATALOG.activities.find(a => a.id === id)!, pinned = main.activities.find(a => a.id === id)!;
      expect(JSON.parse(JSON.stringify(legacy.checkpoints))).toEqual(pinned.checkpoints);
      expect([legacy.x, legacy.z]).toEqual([pinned.x, pinned.z]);
    }
  });
  it("offers main's missions only", () => {
    expect(LEGACY_CATALOG.missions.map(m => m.id)).toEqual(main.missionIds);
  });
});

describe("legacy activity availability is pinned to main's kinds", () => {
  const kinds: Array<[string, string]> = [["timeTrial", "race.finished"], ["delivery", "delivery.completed"], ["photo", "photo.landmarkFramed"],
    ["relic", "relic.viewerFound"], ["washBoards", "board.washed"], ["interview", "demo.robotPresented"], ["parking", "parking.legalStop"],
    ["faction", "faction.pauserCompleted"], ["faction", "faction.acceleratorCompleted"], ["recon", "recon.signalFound"], ["recon", "recon.viewerCompleted"]];
  const at = (kind: string, event: string) => ({ wave: 3, kind, objective: { event, count: 1 }, checkpoints: [{ id: "a", lat: 0, lon: 0, radiusM: 10 }] }) as unknown as Parameters<typeof activityAvailable>[0];
  it("below v27: timed runs, deliveries, photos and relics, as main had them", () => {
    expect(kinds.filter(([k, e]) => legacyActivityAvailable(at(k, e))).map(([k]) => k)).toEqual(["timeTrial", "delivery", "photo", "relic"]);
  });
  it("v27 widens only the modern list", () => {
    expect(kinds.every(([k, e]) => activityAvailable(at(k, e)))).toBe(true);
    for (const activity of DEFAULT_CATALOG.activities) expect(activityAvailable(activity)).toBe(true);
    expect(DEFAULT_CATALOG.missions.some(m => m.id === "office-hours")).toBe(true);
  });
});
