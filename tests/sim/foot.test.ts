// On foot: getting out (F), walking, sprinting, collisions, terrain, getting back in.
import { describe, expect, it } from "vitest";
import {
  Action,
  CAR,
  FOOT,
  activeBody,
  carBox,
  createInitialState,
  distanceToCar,
  groundHeight,
  pointInPolygon,
  step,
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
