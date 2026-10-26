import { describe, expect, it } from "vitest";
import placements from "../../content/landmarks.json" with { type: "json" };
import { landmarkBlips } from "../../src/ui/landmarks.ts";
import { uiProjection } from "../../src/ui/projection.ts";
import { MapAtlas } from "../../src/ui/map-atlas.ts";
import { PALACE_LAGOON } from "../../src/render/landmark-water.ts";
import { createInitialState } from "../../src/sim/step.ts";
import { buildWorld } from "../../src/sim/world.ts";

describe("SF landmark map destinations", () => {
  it("uses the Palace model placement for its selectable map destination", () => {
    const landmarks = landmarkBlips(placements);
    const palace = landmarks.find(item => item.id === "palace-of-fine-arts")!;
    expect(palace).toMatchObject({ label: "Palace of Fine Arts", kind: "landmark" });
    expect(palace.x).toBeCloseTo(-4818.56, 2); expect(palace.z).toBeCloseTo(-823.9325, 2);
    const state = createInitialState(buildWorld([]), 1, ["p"], { x: 0, z: 0, heading: 0 });
    const before = JSON.stringify(state);
    const geography = { tiles: [], roads: null, boundary: null, landmarks, inlandWater: [PALACE_LAGOON.ring as [number, number][]] };
    const view = uiProjection(state, "p", null, palace, 2, undefined, geography);
    expect(view.map!.blips).toContain(palace);
    expect(view.map!.waypoint).toBe(palace);
    expect(JSON.stringify(state)).toBe(before);
    expect(new MapAtlas(geography).query([-4900, -1000, -4600, -700]).filter(item => item.kind === "water")).toHaveLength(1);
    expect(landmarkBlips(null)).toEqual([]);
  });
});
