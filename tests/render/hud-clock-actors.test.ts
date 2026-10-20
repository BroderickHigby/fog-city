import { describe, expect, it } from "vitest";
import { footPose } from "../../src/render/actors.ts";
import { DAY_START_MINUTE, NIGHT_START_MINUTE, formatClock, gameMinuteOfDay } from "../../src/render/clock.ts";
import { compassPoint, hudText, type HudData } from "../../src/render/hud.ts";
import type { Pose } from "../../src/render/types.ts";

const base: HudData = {
  world: "dev",
  speedMps: 10,
  x: 0,
  z: 0,
  onFoot: false,
  tilesReady: 3,
  tilesTotal: 9,
  tilesPending: 2,
  drawCalls: 42,
  triangles: 123456,
  fps: 59.6,
  cameraMode: "chase",
  night: false,
  minuteOfDay: 18 * 60 + 52,
  viewHeading: 0,
};

describe("HUD", () => {
  it("shows speed in km/h and mph, position, tiles, draw calls, triangles and FPS", () => {
    const t = hudText(base);
    expect(t).toContain(" 36 km/h");
    expect(t).toContain(" 22 mph");
    expect(t).toContain("x 0.0  z 0.0  37.79550, -122.39370");
    expect(t).toContain("tiles 3/9 (+2 loading)");
    expect(t).toContain("calls 42");
    expect(t).toContain("tris 123k");
    expect(t).toContain("60 fps");
    expect(t).toContain("18:52");
    expect(hudText({ ...base, speedMps: -5 })).toContain(" 18 km/h");
  });

  it("names compass points for headings", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(Math.PI / 2)).toBe("E");
    expect(compassPoint(Math.PI)).toBe("S");
    expect(compassPoint(-Math.PI / 4)).toBe("NW");
    expect(compassPoint((5 * Math.PI) / 4)).toBe("SW");
  });
});

describe("game clock", () => {
  it("runs at real-time speed from golden hour (day) or late evening (night)", () => {
    expect(gameMinuteOfDay({ tick: 0 }, false)).toBe(DAY_START_MINUTE);
    expect(gameMinuteOfDay({ tick: 3600 }, false)).toBe(DAY_START_MINUTE + 1);
    expect(gameMinuteOfDay({ tick: 0 }, true)).toBe(NIGHT_START_MINUTE);
    expect(gameMinuteOfDay({ tick: 60 * 60 * 60 * 6 }, true)).toBeCloseTo((NIGHT_START_MINUTE + 360) % 1440, 9);
  });

  it("prefers a time the sim publishes in ext", () => {
    expect(gameMinuteOfDay({ tick: 999, ext: { clock: 600 } }, false)).toBe(600);
    expect(gameMinuteOfDay({ tick: 999, ext: { time: { minuteOfDay: 75 } } }, true)).toBe(75);
    expect(gameMinuteOfDay({ tick: 0, ext: { clock: "noon" } }, false)).toBe(DAY_START_MINUTE);
    expect(formatClock(9 * 60 + 5.9)).toBe("09:05");
  });
});

describe("footPose", () => {
  const out = (): Pose => ({ x: 0, y: 0, z: 0, heading: 0 });
  it("reads the on-foot position under any of the likely field names", () => {
    expect(footPose({ mode: "foot", foot: { x: 1, y: 2, z: 3, heading: 0.5 } }, out())).toEqual({ x: 1, y: 2, z: 3, heading: 0.5 });
    expect(footPose({ mode: "foot", pos: { x: 4, z: 5, yaw: 1 } }, out())).toMatchObject({ x: 4, z: 5, heading: 1 });
    const p = footPose({ onFoot: { x: 1, z: 2 } }, out())!;
    expect(Number.isNaN(p.y)).toBe(true);
    expect(Number.isNaN(p.heading)).toBe(true);
  });

  it("returns null when there is no usable position", () => {
    expect(footPose({ mode: "foot" }, out())).toBeNull();
    expect(footPose({ foot: { x: "1", z: 2 } }, out())).toBeNull();
    expect(footPose(null, out())).toBeNull();
  });
});
