import { describe, expect, it } from "vitest";
import {
  buildWorld,
  groundWater,
  inCorridor,
  makeCar,
  onWater,
  stepCar,
  type CarState,
  type Heightfield,
  type SimInput,
  type TileCollider,
  type World,
} from "../../src/sim/index.ts";

const INPUT: SimInput = { throttle: 1, steer: 0, brake: 0, actions: 0 };

function tile(kind: "pack" | "json" | "dry" = "pack"): TileCollider {
  const n = 101;
  const ground: Heightfield = { x0: -500, z0: -500, cellSizeM: 10, nx: n, nz: n, heights: new Array<number>(n * n).fill(5.25) };
  if (kind === "pack") ground.lake = new Array<number>(n * n).fill(1);
  if (kind === "json") ground.cover = "0".repeat(n * n);
  return { tileId: "lake", ground, buildings: [] };
}

function drive(world: World, car: CarState, ticks: number): CarState {
  for (let t = 0; t < ticks; t++) car = stepCar(world, car, INPUT);
  return car;
}

describe("cars already in inland water", () => {
  it("does not turn a lake's flat surface into a road, with or without boundary lines", () => {
    for (const kind of ["pack", "json"] as const) {
      for (const boundary of [null, { version: 1, edges: [], shore: [] }]) {
        const world = buildWorld([tile(kind)], null, boundary);
        expect(groundWater(world, 0, 0)).toBe(true);
        if (world.walls) expect(onWater(world.walls.shore, 0, 0)).toBe(true);
        const start = makeCar(0, 0, Math.PI, 5.25);
        const end = drive(world, start, 600);
        expect(end.x).toBe(start.x);
        expect(end.z).toBe(start.z);
        expect(end.y).toBe(start.y);
        expect(end.speed).toBe(0);
      }
    }
  });

  it("brakes existing momentum without relocating the car to a bank", () => {
    const world = buildWorld([tile()]);
    let car = { ...makeCar(0, 0, Math.PI, 5.25), speed: 20 };
    for (let t = 0; t < 300; t++) {
      const next = stepCar(world, car, INPUT);
      expect(next.speed).toBeLessThanOrEqual(car.speed);
      expect(next.z - car.z).toBeGreaterThanOrEqual(0);
      expect(next.z - car.z).toBeLessThanOrEqual(car.speed / 60 + 0.000001);
      expect(next.x).toBeCloseTo(0, 10);
      expect(next.y).toBe(5.25);
      car = next;
    }
    expect(car.speed).toBe(0);
    expect(car.z).toBeGreaterThan(0);
    expect(car.z).toBeLessThan(10);
  });

  it("treats packed LAKE masks and JSON cover digits identically", () => {
    const a = buildWorld([tile("pack")]);
    const b = buildWorld([tile("json")]);
    const start = { ...makeCar(0, 0, 0.4, 5.25), speed: 12, lateral: 3 };
    expect(drive(a, start, 180)).toEqual(drive(b, start, 180));
  });

  it("reads inland water through the aligned tile lookup used by SF", () => {
    for (const kind of ["pack", "json"] as const) {
      const source = tile(kind);
      source.tileId = "t0_0";
      source.ground = { x0: 0, z0: 0, cellSizeM: 10, nx: 51, nz: 51, heights: new Array<number>(51 * 51).fill(5.25), ...(kind === "pack" ? { lake: new Array<number>(51 * 51).fill(1) } : { cover: "0".repeat(51 * 51) }) };
      const world = buildWorld([source]);
      expect(world.tileGround).not.toBeNull();
      expect(groundWater(world, 250, 250)).toBe(true);
      const end = drive(world, makeCar(250, 250, Math.PI, 5.25), 120);
      expect(end.z).toBe(250);
      expect(end.speed).toBe(0);
    }
  });

  it("allows dry ground at the same elevation and leaves airborne motion unchanged", () => {
    const dry = buildWorld([tile("dry")]);
    const wet = buildWorld([tile("pack")]);
    expect(groundWater(dry, 0, 0)).toBe(false);
    expect(drive(dry, makeCar(0, 0, Math.PI, 5.25), 120).z).toBeGreaterThan(10);
    const air = { ...makeCar(0, 0, Math.PI, 50), grounded: false, airTicks: 1, speed: 15 };
    expect(drive(wet, air, 60)).toEqual(drive(dry, air, 60));
  });

  it("keeps decks, tunnel floors and roofs above or below water driveable", () => {
    for (const kind of ["deck", "tunnel", "roof"] as const) {
      const source = tile();
      let y = 12;
      if (kind === "deck") source.decks = [{ id: "bridge", kind: "bridge", layer: 1, path: [[0, 12, -300, 12], [0, 12, 300, 12]] }];
      if (kind === "tunnel") {
        y = -2;
        source.tunnels = [{ id: "bore", kind: "tunnel", clearanceM: 4, path: [[0, -2, -300, 12], [0, -2, 300, 12]] }];
      }
      if (kind === "roof") source.buildings = [{ id: "pier-roof", footprint: [[-100, -300], [100, -300], [100, 300], [-100, 300]], baseY: 5.25, topY: 12 }];
      const end = drive(buildWorld([source]), makeCar(0, 0, Math.PI, y), 120);
      expect(end.z, kind).toBeGreaterThan(10);
      expect(end.y, kind).toBeCloseTo(y, 8);
    }
  });

  it("keeps a legacy ground-level bridge corridor driveable", () => {
    const source = tile();
    source.ground!.lake = source.ground!.lake!.map((_, i) => {
      const z = -500 + Math.floor(i / 101) * 10;
      return z > 0 && z < 40 ? 1 : 0;
    });
    const roads = { version: 1, nodes: [{ id: "a", x: 0, z: -100 }, { id: "b", x: 0, z: 100 }], edges: [{ id: "bridge", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, widthM: 10, speedLimitMps: 10, points: [[0, -100], [0, 100]] as Array<[number, number]> }] };
    const world = buildWorld([source], roads, { version: 1, edges: [], shore: [{ closed: false, points: [[-500, 0], [500, 0]] }, { closed: false, points: [[500, 40], [-500, 40]] }] });
    expect(onWater(world.walls!.shore, 0, 10)).toBe(true);
    expect(inCorridor(world.walls!, 0, 10)).toBe(true);
    expect(drive(world, makeCar(0, 10, Math.PI, 5.25), 120).z).toBeGreaterThan(20);
  });
});
