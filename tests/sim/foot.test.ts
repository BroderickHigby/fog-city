// On foot: getting out (F), walking, sprinting, collisions, terrain, getting back in.
import { describe, expect, it } from "vitest";
import {
  Action,
  CAR,
  FOOT,
  activeBody,
  buildWorld,
  canEnterCar,
  carBox,
  closestOnCar,
  createInitialState,
  distanceToCar,
  groundHeight,
  pointInPolygon,
  segmentBlocked,
  step,
  type BuildingCollider,
  type InputFrame,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { deepFreeze } from "../helpers.ts";
import { terrainWorld, wallWorld } from "./fixtures.ts";

const F = (throttle = 0, steer = 0, brake = 0, actions = 0): InputFrame => ({ p1: { throttle, steer, brake, actions } });
const PRESS = F(0, 0, 0, Action.enterExit);

function run(world: World, s: SimState, input: InputFrame, ticks: number, each?: (s: SimState) => void): SimState {
  for (let t = 0; t < ticks; t++) {
    s = step(world, s, input);
    each?.(s);
  }
  return s;
}

const wall = wallWorld(); // wall from z = -60 to -50
const WALL: Array<[number, number]> = [[-300, -60], [300, -60], [300, -50], [-300, -50]];

describe("getting out and back in", () => {
  it("F at rest puts the walker beside the car; the car stays parked where it was", () => {
    let s = createInitialState(wall, 1, ["p1"], { x: 0, z: 0, heading: 0 });
    const car0 = s.players.p1!.car;
    s = step(wall, s, PRESS);
    const p = s.players.p1!;
    expect(p.mode).toBe("foot");
    expect(p.foot).not.toBeNull();
    expect(p.car.x).toBe(car0.x);
    expect(p.car.z).toBe(car0.z);
    expect(p.car.heading).toBe(car0.heading);
    expect(p.car.speed).toBe(0);
    const d = distanceToCar(p.car, p.foot!.x, p.foot!.z);
    expect(d).toBeGreaterThan(FOOT.radius);
    expect(d).toBeLessThan(1.5);
    expect(p.foot!.x).toBeLessThan(0); // driver's side (left of a north-facing car)
    expect(activeBody(p).mode).toBe("foot");
  });

  it("the parked car does not move while the player walks away, and F far from it does nothing", () => {
    let s = run(wall, createInitialState(wall, 1, ["p1"], { x: 0, z: 0, heading: 0 }), PRESS, 1);
    const parked = s.players.p1!.car;
    s = run(wall, s, F(1, 0, 1), 300);
    expect(s.players.p1!.car).toEqual(parked);
    const f = s.players.p1!.foot!;
    expect(distanceToCar(parked, f.x, f.z)).toBeGreaterThan(FOOT.enterRange);
    s = step(wall, s, PRESS);
    expect(s.players.p1!.mode).toBe("foot");
  });

  it("F within ~3 m of the parked car gets back in", () => {
    let s = run(wall, createInitialState(wall, 1, ["p1"], { x: 0, z: 0, heading: 0 }), PRESS, 1);
    s = run(wall, s, F(1), 60); // ~1.6 m north, still close
    const f = s.players.p1!.foot!;
    expect(distanceToCar(s.players.p1!.car, f.x, f.z)).toBeLessThanOrEqual(FOOT.enterRange);
    s = step(wall, s, PRESS);
    expect(s.players.p1!.mode).toBe("vehicle");
    expect(s.players.p1!.foot).toBeNull();
    expect(activeBody(s.players.p1!).mode).toBe("vehicle");
    // And the car drives off again.
    s = run(wall, s, F(1), 60);
    expect(s.players.p1!.car.z).toBeLessThan(-2);
  });

  it("walk away, turn round, walk back and get in", () => {
    let s = run(wall, createInitialState(wall, 1, ["p1"], { x: 0, z: 0, heading: 0 }), PRESS, 1);
    s = run(wall, s, F(1), 300); // 8 m away
    s = run(wall, s, F(0, 1), 63); // turn ~180 degrees at 3 rad/s
    expect(Math.abs(Math.abs(s.players.p1!.foot!.heading) - Math.PI)).toBeLessThan(0.15);
    for (let t = 0; t < 600 && distanceToCar(s.players.p1!.car, s.players.p1!.foot!.x, s.players.p1!.foot!.z) > 2; t++) s = step(wall, s, F(1));
    s = step(wall, s, PRESS);
    expect(s.players.p1!.mode).toBe("vehicle");
  });

  it("F while moving fast brakes the car to a stop, then the player gets out", () => {
    let s = run(wall, createInitialState(wall, 1, ["p1"], { x: 0, z: 100, heading: 0 }), F(1), 120);
    expect(s.players.p1!.car.speed).toBeGreaterThan(10);
    s = step(wall, s, PRESS);
    expect(s.players.p1!.mode).toBe("vehicle");
    expect(s.players.p1!.exitPending).toBe(true);
    let ticks = 0;
    // Throttle is ignored while the exit is pending.
    while (s.players.p1!.mode === "vehicle" && ticks < 300) {
      s = step(wall, s, F(1));
      ticks++;
    }
    const p = s.players.p1!;
    expect(p.mode).toBe("foot");
    expect(ticks).toBeLessThan(90);
    expect(p.car.speed).toBe(0);
    expect(p.exitPending).toBe(false);
    expect(distanceToCar(p.car, p.foot!.x, p.foot!.z)).toBeLessThan(1.5);
  });

  it("pressing F again while an exit is pending cancels it", () => {
    let s = run(wall, createInitialState(wall, 1, ["p1"], { x: 0, z: 100, heading: 0 }), F(1), 120);
    s = step(wall, s, PRESS);
    s = step(wall, s, PRESS);
    expect(s.players.p1!.exitPending).toBe(false);
    s = run(wall, s, F(1), 60);
    expect(s.players.p1!.mode).toBe("vehicle");
    expect(s.players.p1!.car.speed).toBeGreaterThan(10);
  });
});

describe("walking", () => {
  const start = (world: World): SimState => run(world, createInitialState(world, 1, ["p1"], { x: 0, z: 0, heading: 0 }), PRESS, 1);

  it("walks at ~1.6 m/s and sprints (brake held) much faster", () => {
    let s = run(wall, start(wall), F(1), 90);
    expect(s.players.p1!.foot!.speed).toBeCloseTo(FOOT.walk, 5);
    expect(s.players.p1!.foot!.sprint).toBe(false);
    s = run(wall, s, F(1, 0, 1), 90);
    expect(s.players.p1!.foot!.speed).toBeCloseTo(FOOT.sprint, 5);
    expect(s.players.p1!.foot!.sprint).toBe(true);
  });

  it("steps back slowly and turns with steer", () => {
    let s = run(wall, start(wall), F(-1), 90);
    expect(s.players.p1!.foot!.speed).toBeCloseTo(-FOOT.back, 5);
    s = run(wall, s, F(0, -1), 30);
    expect(s.players.p1!.foot!.heading).toBeCloseTo(-0.5 * FOOT.turnRate, 5);
  });

  it("never walks into a building, even sprinting at it", () => {
    let s = start(wall);
    s = run(wall, s, F(1, 0, 1), 60 * 20, (k) => {
      const f = k.players.p1!.foot!;
      expect(pointInPolygon(f.x, f.z, WALL)).toBe(false);
      expect(f.z).toBeGreaterThan(-50 + FOOT.radius - 1e-6);
    });
    expect(s.players.p1!.foot!.speed).toBeCloseTo(0, 5); // pressing into the wall reads as stopped
  });

  it("cannot walk through the parked car", () => {
    // Get out on the driver's side, turn to face the car (east) and push into it.
    let s = start(wall);
    s = run(wall, s, F(0, 1), 31); // ~+90 degrees: facing east
    s = run(wall, s, F(1), 240, (k) => {
      const f = k.players.p1!.foot!;
      const b = carBox(k.players.p1!.car);
      expect(distanceToCar(b, f.x, f.z)).toBeGreaterThan(FOOT.radius - 1e-6);
    });
  });

  it("follows the terrain and walks slower uphill", () => {
    const hill = terrainWorld((_x, z) => -0.2 * z); // rises to the north
    let s = start(hill);
    s = run(hill, s, F(1), 240, (k) => {
      const f = k.players.p1!.foot!;
      expect(f.y).toBeCloseTo(groundHeight(hill, f.x, f.z), 9);
    });
    const up = s.players.p1!.foot!.speed;
    s = run(hill, s, F(0, 1), 63); // turn round
    s = run(hill, s, F(1), 120);
    const down = s.players.p1!.foot!.speed;
    expect(up).toBeLessThan(FOOT.walk * 0.9);
    expect(down).toBeCloseTo(FOOT.walk, 5);
    expect(s.players.p1!.foot!.y).toBeGreaterThan(0);
  });

  it("step() never mutates a state with a walker in it", () => {
    let s = deepFreeze(start(wall));
    for (let t = 0; t < 120; t++) s = deepFreeze(step(wall, s, F(1, Math.sin(t / 10), t > 60 ? 1 : 0, t === 100 ? Action.enterExit : 0)));
    expect(s.tick).toBe(121);
  });

  it("the walker stays out of the car's way: robotaxis and other cars treat a walker as a person", () => {
    // Two players: p2 parks, gets out and stands in front of p1, who drives at them.
    const world = wall;
    let s = createInitialState(world, 1, ["p1", "p2"], { x: 0, z: 0, heading: 0 });
    s = step(world, s, { p2: { throttle: 0, steer: 0, brake: 0, actions: Action.enterExit } });
    const w = s.players.p2!.foot!;
    expect(s.players.p2!.mode).toBe("foot");
    // p1 starts 30 m west of the walker, heading east at them (p2's car is beyond the walker).
    s = { ...s, players: { ...s.players, p1: { ...s.players.p1!, car: { ...s.players.p1!.car, x: w.x - 30, z: w.z, heading: Math.PI / 2 } } } };
    s = run(world, s, { p1: { throttle: 0.5, steer: 0, brake: 0, actions: 0 } }, 300);
    const c = s.players.p1!.car;
    expect(c.personBumps).toBe(1);
    expect(c.hits).toBe(0);
    expect(c.x + CAR.halfLength).toBeLessThan(w.x - FOOT.radius + 0.05);
    // The walker was not moved by the car.
    expect(s.players.p2!.foot!.x).toBe(w.x);
  });
});

describe("walls between the car and the walker", () => {
  const box = (id: string, x0: number, z0: number, x1: number, z1: number): BuildingCollider => ({
    id,
    footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
    baseY: 0,
    topY: 10,
  });
  // A 0.35 m thick wall just left of a north-facing car at the origin: the driver's-side spot
  // (x = -1.75) is clear of it, but on its far side.
  const thin = buildWorld([{ tileId: "thin", buildings: [box("thin", -1.35, -6, -1.0, 6)], ground: null }]);
  const onFoot = (s: SimState, x: number, z: number): SimState => ({
    ...s,
    players: { p1: { ...s.players.p1!, mode: "foot", foot: { x, y: 0, z, heading: 0, speed: 0, sprint: false, vy: 0, grounded: true }, exitPending: false } },
  });

  it("F never puts the walker on the far side of a wall: it uses the next clear side", () => {
    let s = createInitialState(thin, 1, ["p1"], { x: 0, z: 0, heading: 0 });
    s = step(thin, s, PRESS);
    const p = s.players.p1!;
    expect(p.mode).toBe("foot");
    expect(p.foot!.x).toBeGreaterThan(0); // the passenger side
    expect(segmentBlocked(thin, p.car.x, p.car.z, p.foot!.x, p.foot!.z)).toBe(false);
  });

  it("boxed in on every side, F keeps the player in the car and clears the pending exit", () => {
    const slot = buildWorld([
      {
        tileId: "slot",
        buildings: [box("w", -1.35, -6, -1.0, 6), box("e", 1.0, -6, 1.35, 6), box("n", -1.0, -2.75, 1.0, -2.4), box("s", -1.0, 2.4, 1.0, 2.75)],
        ground: null,
      },
    ]);
    let s = createInitialState(slot, 1, ["p1"], { x: 0, z: 0, heading: 0 });
    s = step(slot, s, PRESS);
    expect(s.players.p1!.mode).toBe("vehicle");
    expect(s.players.p1!.foot).toBeNull();
    expect(s.players.p1!.exitPending).toBe(false);
    // And with a gap opened behind the car (no south wall) the player gets out there.
    const open = buildWorld([{ tileId: "open", buildings: [box("w", -1.35, -6, -1.0, 6), box("e", 1.0, -6, 1.35, 6), box("n", -1.0, -2.75, 1.0, -2.4)], ground: null }]);
    s = step(open, createInitialState(open, 1, ["p1"], { x: 0, z: 0, heading: 0 }), PRESS);
    expect(s.players.p1!.mode).toBe("foot");
    expect(s.players.p1!.foot!.z).toBeGreaterThan(CAR.halfLength);
  });

  it("a pending exit with no room to get out is dropped, and the car stays drivable", () => {
    // p1 sits between two walls with a wall right behind it and p2's car right in front.
    const pen = buildWorld([
      { tileId: "pen", buildings: [box("w", -1.35, -12, -1.0, 6), box("e", 1.0, -12, 1.35, 6), box("s", -1.0, 2.4, 1.0, 2.75)], ground: null },
    ]);
    let s = createInitialState(pen, 1, ["p1", "p2"], { x: 0, z: 0, heading: 0 });
    const p1 = s.players.p1!;
    const p2 = s.players.p2!;
    s = {
      ...s,
      players: {
        // Still rolling slowly, exit already pending (as after pressing F at speed).
        p1: { ...p1, car: { ...p1.car, x: 0, z: 0, speed: 1 }, exitPending: true },
        p2: { ...p2, car: { ...p2.car, x: 0, z: -2 * CAR.halfLength - 0.3 } },
      },
    };
    s = step(pen, s, F(1));
    expect(s.players.p1!.mode).toBe("vehicle");
    expect(s.players.p1!.exitPending).toBe(false);
    expect(s.players.p1!.car.speed).toBe(0);
    // p2 drives off, then p1 can drive after it: throttle is no longer overridden by a pending exit.
    s = run(pen, s, { p1: { throttle: 0, steer: 0, brake: 0, actions: 0 }, p2: { throttle: 1, steer: 0, brake: 0, actions: 0 } }, 60);
    s = run(pen, s, { p1: { throttle: 1, steer: 0, brake: 0, actions: 0 }, p2: { throttle: 1, steer: 0, brake: 0, actions: 0 } }, 60);
    expect(s.players.p1!.car.speed).toBeGreaterThan(5);
    expect(s.players.p1!.car.z).toBeLessThan(-3);
  });

  it("nobody gets back in through a wall", () => {
    const s0 = createInitialState(thin, 1, ["p1"], { x: 0, z: 0, heading: 0 });
    // 1.25 m from the car's side, but behind the wall.
    const behind = onFoot(s0, -2.2, 0);
    expect(distanceToCar(behind.players.p1!.car, -2.2, 0)).toBeLessThan(FOOT.enterRange);
    expect(canEnterCar(thin, behind.players.p1!.car, -2.2, 0)).toBe(false);
    expect(step(thin, behind, PRESS).players.p1!.mode).toBe("foot");
    // The same distance on the open side gets in.
    const open = onFoot(s0, 2.2, 0);
    expect(step(thin, open, PRESS).players.p1!.mode).toBe("vehicle");
    // A short wall beside the car's middle: from past its end, diagonally to the car's
    // corner, the way is clear and the player gets in.
    const short = buildWorld([{ tileId: "short", buildings: [box("short", -1.35, -1.5, -1.0, 1.5)], ground: null }]);
    const corner = onFoot(createInitialState(short, 1, ["p1"], { x: 0, z: 0, heading: 0 }), -2.2, 2.6);
    expect(distanceToCar(corner.players.p1!.car, -2.2, 2.6)).toBeLessThan(FOOT.enterRange);
    expect(step(short, corner, PRESS).players.p1!.mode).toBe("vehicle");
    expect(step(short, onFoot(corner, -2.2, 0), PRESS).players.p1!.mode).toBe("foot");
  });

  it("closestOnCar is the nearest point of the body rectangle", () => {
    const c = { x: 5, z: -3, heading: 0.7 };
    for (const [x, z] of [[9, -3], [5, 2], [0, 0], [5.1, -3.2], [-2, -9]] as Array<[number, number]>) {
      const p = closestOnCar(c, x, z);
      expect(Math.hypot(p.x - x, p.z - z)).toBeCloseTo(distanceToCar(c, x, z), 9);
      expect(distanceToCar(c, p.x, p.z)).toBeCloseTo(0, 9);
    }
  });
});
