import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CAR_COLORS, playerColorIndex, recolorCar } from "../../src/render/actors.ts";
import { DAY_START_MINUTE, NIGHT_START_MINUTE, clockStartMinute, formatClock, gameMinuteOfDay } from "../../src/render/clock.ts";
import { HINT_NO_ROOM, HINT_TOO_FAR, compassPoint, exitHint, hudText, type HudData } from "../../src/render/hud.ts";

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
  it("runs at real-time speed from the start minute chosen at boot", () => {
    expect(clockStartMinute(false)).toBe(DAY_START_MINUTE);
    expect(clockStartMinute(true)).toBe(NIGHT_START_MINUTE);
    expect(gameMinuteOfDay({ tick: 0 })).toBe(DAY_START_MINUTE);
    expect(gameMinuteOfDay({ tick: 3600 }, DAY_START_MINUTE)).toBe(DAY_START_MINUTE + 1);
    expect(gameMinuteOfDay({ tick: 0 }, NIGHT_START_MINUTE)).toBe(NIGHT_START_MINUTE);
    expect(gameMinuteOfDay({ tick: 60 * 60 * 60 * 6 }, NIGHT_START_MINUTE)).toBeCloseTo((NIGHT_START_MINUTE + 360) % 1440, 9);
  });

  it("does not depend on the night look: toggling night mode never moves the clock", () => {
    // The clock takes no night flag at all: the same tick gives the same minute whatever the look.
    const start = clockStartMinute(false);
    const before = gameMinuteOfDay({ tick: 5000 }, start);
    const after = gameMinuteOfDay({ tick: 5001 }, start);
    expect(after - before).toBeCloseTo(1 / 3600, 9);
  });

  it("prefers a time the sim publishes in ext", () => {
    expect(gameMinuteOfDay({ tick: 999, ext: { clock: 600 } })).toBe(600);
    expect(gameMinuteOfDay({ tick: 999, ext: { time: { minuteOfDay: 75 } } }, NIGHT_START_MINUTE)).toBe(75);
    expect(gameMinuteOfDay({ tick: 0, ext: { clock: "noon" } })).toBe(DAY_START_MINUTE);
    expect(formatClock(9 * 60 + 5.9)).toBe("09:05");
  });
});

describe("exit hint", () => {
  const car = (exitPending = false) => ({ mode: "vehicle" as const, exitPending });
  const foot = { mode: "foot" as const, exitPending: false };

  it("says there is no room when F leaves the player in the stopped car", () => {
    expect(exitHint(car(), car(), true)).toBe(HINT_NO_ROOM);
  });

  it("says there is no room when a pending exit ends with the player still in the car", () => {
    expect(exitHint(car(true), car(false), false)).toBe(HINT_NO_ROOM);
  });

  it("is quiet when F works, starts a braking exit, or cancels one", () => {
    expect(exitHint(car(), foot, true)).toBeNull();
    expect(exitHint(car(), car(true), true)).toBeNull();
    expect(exitHint(car(true), car(false), true)).toBeNull();
    expect(exitHint(car(true), car(true), false)).toBeNull();
    expect(exitHint(car(), car(), false)).toBeNull();
    expect(exitHint(foot, car(), true)).toBeNull();
    expect(exitHint(undefined, car(), true)).toBeNull();
  });

  it("says the car is too far when F on foot does not get the player in", () => {
    expect(exitHint(foot, foot, true)).toBe(HINT_TOO_FAR);
    expect(exitHint(foot, foot, false)).toBeNull();
  });
});

describe("player car colours", () => {
  it("gives twelve player paint palettes deterministic unique slots and wraps after the twelfth", () => {
    const slots = Array.from({length:12},(_,i)=>playerColorIndex(`p${i+1}`));
    expect(slots[0]).toBe(0);
    expect(new Set(slots).size).toBe(CAR_COLORS.length);
    expect(playerColorIndex("p13")).toBe(0);
    expect(playerColorIndex("guest-42")).toBe(playerColorIndex("guest-42"));
    for (const id of ["alice", "bob", "p0", "p999"]) {
      expect(playerColorIndex(id)).toBeGreaterThanOrEqual(0);
      expect(playerColorIndex(id)).toBeLessThan(CAR_COLORS.length);
    }
  });

  it("recolours a loaded car's paint with one clone per car, leaving the shared materials alone", () => {
    const paint = new THREE.MeshPhysicalMaterial({ name: "paint", color: 0xe0552b });
    const lamp = new THREE.MeshStandardMaterial({ name: "light_headlight" });
    const proto = new THREE.Group();
    const g = new THREE.BoxGeometry();
    proto.add(new THREE.Mesh(g, paint), new THREE.Mesh(g, paint), new THREE.Mesh(g, [lamp, paint]));
    const car = proto.clone(true);
    expect(recolorCar(car, null)).toEqual([]);
    const own = recolorCar(car, CAR_COLORS[1]!);
    expect(own).toHaveLength(1);
    expect((own[0] as THREE.MeshPhysicalMaterial).color.getHex()).toBe(CAR_COLORS[1]);
    const meshes = car.children as THREE.Mesh[];
    expect(meshes[0]!.material).toBe(own[0]);
    expect(meshes[1]!.material).toBe(own[0]);
    expect((meshes[2]!.material as THREE.Material[])[0]).toBe(lamp);
    expect((meshes[2]!.material as THREE.Material[])[1]).toBe(own[0]);
    // The prototype (and every other player's clone) keeps the original paint.
    expect((proto.children[0] as THREE.Mesh).material).toBe(paint);
    expect(paint.color.getHex()).toBe(0xe0552b);
  });
});
