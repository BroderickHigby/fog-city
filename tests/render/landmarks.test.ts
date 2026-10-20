import { describe, expect, it } from "vitest";
import { M_PER_DEG_LAT, M_PER_DEG_LON, ORIGIN, toLatLon } from "../../src/geo/project.ts";
import {
  clockHandAngles,
  clockHandAxis,
  clockHandKind,
  clockHandRotation,
  modelUrl,
  parseLandmarks,
  placeLandmark,
} from "../../src/render/landmarks.ts";

const flat = (): number => 0;

describe("placeLandmark", () => {
  it("puts a landmark at the origin lat/lon at (0, ground, 0)", () => {
    const p = placeLandmark({ id: "ferry", model: "models/ferry.glb", lat: ORIGIN.lat, lon: ORIGIN.lon, headingDeg: 0 }, () => 2.5);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.z).toBeCloseTo(0, 9);
    expect(p.y).toBe(2.5);
    expect(p.scale).toBe(1);
    expect(p.rotationY).toBeCloseTo(0, 12);
  });

  it("maps north to -z and east to +x in metres", () => {
    const n = placeLandmark({ id: "n", model: "m.glb", lat: ORIGIN.lat + 0.01, lon: ORIGIN.lon, headingDeg: 0 }, flat);
    expect(n.x).toBeCloseTo(0, 9);
    expect(n.z).toBeCloseTo(-0.01 * M_PER_DEG_LAT, 6);
    const e = placeLandmark({ id: "e", model: "m.glb", lat: ORIGIN.lat, lon: ORIGIN.lon + 0.01, headingDeg: 0 }, flat);
    expect(e.x).toBeCloseTo(0.01 * M_PER_DEG_LON, 6);
    expect(e.z).toBeCloseTo(0, 9);
  });

  it("round-trips through toLatLon", () => {
    const lat = 37.8024;
    const lon = -122.4058;
    const p = placeLandmark({ id: "t", model: "m.glb", lat, lon, headingDeg: 0 }, flat);
    const back = toLatLon(p.x, p.z);
    expect(back.lat).toBeCloseTo(lat, 10);
    expect(back.lon).toBeCloseTo(lon, 10);
  });

  it("turns compass headings into rotation.y = -heading and applies scale", () => {
    const east = placeLandmark({ id: "a", model: "m.glb", lat: ORIGIN.lat, lon: ORIGIN.lon, headingDeg: 90, scale: 2 }, flat);
    expect(east.rotationY).toBeCloseTo(-Math.PI / 2, 12);
    expect(east.scale).toBe(2);
    // A model facing -z, rotated by rotationY about +y, faces the compass heading.
    const fx = -Math.sin(east.rotationY);
    const fz = -Math.cos(east.rotationY);
    expect(fx).toBeCloseTo(1, 12); // east
    expect(fz).toBeCloseTo(0, 12);
    const sw = placeLandmark({ id: "b", model: "m.glb", lat: ORIGIN.lat, lon: ORIGIN.lon, headingDeg: 225 }, flat);
    expect(-Math.sin(sw.rotationY)).toBeCloseTo(-Math.SQRT1_2, 12); // west
    expect(-Math.cos(sw.rotationY)).toBeCloseTo(Math.SQRT1_2, 12); // south (+z)
  });

  it("samples the ground at the landmark's position and survives a bad ground value", () => {
    const seen: Array<[number, number]> = [];
    const p = placeLandmark({ id: "g", model: "m.glb", lat: ORIGIN.lat - 0.001, lon: ORIGIN.lon - 0.002, headingDeg: 0 }, (x, z) => {
      seen.push([x, z]);
      return 12;
    });
    expect(seen).toEqual([[p.x, p.z]]);
    expect(p.y).toBe(12);
    expect(placeLandmark({ id: "h", model: "m.glb", lat: 0, lon: 0, headingDeg: 0 }, () => NaN).y).toBe(0);
  });

  it("normalises model paths to URLs under public/", () => {
    expect(modelUrl("models/a.glb")).toBe("models/a.glb");
    expect(modelUrl("public/models/a.glb")).toBe("models/a.glb");
    expect(modelUrl("/models/a.glb")).toBe("models/a.glb");
    expect(modelUrl("./models\\a.glb")).toBe("models/a.glb");
  });
});

describe("parseLandmarks", () => {
  it("keeps good entries and skips broken ones without throwing", () => {
    const doc = {
      version: 1,
      landmarks: [
        { id: "ok", model: "models/ok.glb", lat: 37.79, lon: -122.39, headingDeg: 10, scale: 1.5, replacesBuildingIds: ["b1", 7] },
        { id: "no-model", lat: 37.79, lon: -122.39, headingDeg: 0 },
        { id: "nan", model: "m.glb", lat: Number.NaN, lon: -122.39, headingDeg: 0 },
        { id: "bad-scale", model: "m.glb", lat: 37.79, lon: -122.39, headingDeg: 0, scale: -1 },
        null,
      ],
    };
    const { entries, skipped } = parseLandmarks(doc);
    expect(entries.map((e) => e.id)).toEqual(["ok", "bad-scale"]);
    expect(entries[0]!.replacesBuildingIds).toEqual(["b1"]);
    expect(entries[1]!.scale).toBeUndefined();
    expect(skipped).toEqual(["no-model", "nan", "#4"]);
  });

  it("treats a missing or malformed document as no landmarks", () => {
    expect(parseLandmarks(null).entries).toEqual([]);
    expect(parseLandmarks({}).entries).toEqual([]);
    expect(parseLandmarks({ landmarks: "nope" }).entries).toEqual([]);
  });
});

describe("clock hands", () => {
  it("recognises hand nodes by name or extras, and nothing else", () => {
    expect(clockHandKind("ClockHourHand")).toBe("hour");
    expect(clockHandKind("clock_hand_minute_N")).toBe("minute");
    expect(clockHandKind("hand.second")).toBe("second");
    expect(clockHandKind("Minute Hand East")).toBe("minute");
    expect(clockHandKind("hourhand")).toBe("hour");
    expect(clockHandKind("hr_hand")).toBe("hour");
    expect(clockHandKind("ClockFace")).toBeNull();
    expect(clockHandKind("HourGlass")).toBeNull();
    expect(clockHandKind("handrail")).toBeNull();
    expect(clockHandKind("Mesh_12", { clockHand: "minute" })).toBe("minute");
  });

  it("uses local +Z unless extras give an axis, and normalises it", () => {
    expect(clockHandAxis()).toEqual([0, 0, 1]);
    expect(clockHandAxis({ clockAxis: [2, 0, 0] })).toEqual([1, 0, 0]);
    expect(clockHandAxis({ clockAxis: [0, 0, 0] })).toEqual([0, 0, 1]);
  });

  it("computes hand angles clockwise from twelve", () => {
    const q = Math.PI / 2;
    const at3 = clockHandAngles(15 * 60);
    expect(at3.hour).toBeCloseTo(q, 12);
    expect(at3.minute).toBeCloseTo(0, 12);
    const at630 = clockHandAngles(6 * 60 + 30);
    expect(at630.hour).toBeCloseTo((6.5 / 12) * 2 * Math.PI, 12);
    expect(at630.minute).toBeCloseTo(Math.PI, 12);
    const sec = clockHandAngles(10 + 15 / 60);
    expect(sec.second).toBeCloseTo(q, 9);
    expect(clockHandAngles(-60).hour).toBeCloseTo(clockHandAngles(23 * 60).hour, 12);
    expect(clockHandRotation("minute", 15)).toBeCloseTo(-q, 12);
  });
});
