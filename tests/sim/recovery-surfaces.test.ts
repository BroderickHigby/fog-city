// Recovery and boarding on stacked structural surfaces: a car that joins, spawns or respawns on a
// deck, in a tunnel bore or anywhere with a height hint (Spawn.y) stays on that level instead of
// being snapped to the ground under the deck or the hill over the bore (clearCarSpot); a player
// gets out at the car's level (exitSpot) and gets in only at it (canEnterCar). Accepted body
// positions are asserted, not proposals.
import { describe, expect, it } from "vitest";
import { canEnterCar, clearCarSpot, createInitialState, exitSpot, makeCar, step, surfaceHeight, type SimEvent, type SimState } from "../../src/sim/index.ts";
import { overpassY, surfaceWorld } from "./fixtures.ts";

describe("recovery and boarding on decks and in bores", () => {
  const world = surfaceWorld(true);
  const join = (s: SimState, playerId: string, payload: Record<string, number>): SimState => {
    const e: SimEvent = { tick: s.tick + 1, kind: "player.join", playerId, payload };
    return step(world, s, {}, [e], []);
  };
  const base = (): SimState => createInitialState(world, 5, ["p1"], { x: 250, z: 250, heading: 0 });

  it("a join on the overpass deck with a height hint stands on the deck, not the street under it", () => {
    const deck = overpassY(130);
    const s = join(base(), "p2", { x: 30, z: 130, heading: Math.PI, y: deck });
    const car = s.players.p2!.car;
    expect(Math.abs(car.x - 30)).toBeLessThan(2);
    expect(car.y).toBeGreaterThan(deck - 0.5);
    // Without a hint the same request is a request for the ground: the street under the deck.
    const g = join(base(), "p3", { x: 30, z: 130, heading: Math.PI });
    expect(g.players.p3!.car.y).toBeLessThan(1);
  });

  it("a join in the tunnel bore with a height hint stands on the bore floor, not the ridge above", () => {
    const floor = surfaceHeight(world, 0, -100, 0);
    expect(surfaceHeight(world, 0, -100, 40)).toBeGreaterThan(floor + 15);
    const s = join(base(), "p2", { x: 0, z: -100, heading: 0, y: floor });
    const car = s.players.p2!.car;
    expect(car.y).toBeLessThan(floor + 0.5);
    expect(Math.abs(car.x)).toBeLessThan(3);
    // A few ticks later it is still in the bore (not pushed up onto, or out of, the hill).
    let t = s;
    for (let i = 0; i < 30; i++) t = step(world, t, { p2: { throttle: 0, steer: 0, brake: 1, actions: 0 } }, [], []);
    expect(t.players.p2!.car.y).toBeLessThan(floor + 0.5);
  });

  it("recovery from a crowded spot on a level stays on that level", () => {
    const deck = overpassY(130);
    const blockers = [{ x: 30, z: 130, heading: Math.PI, hl: 2.4, hw: 1 }];
    const spot = clearCarSpot(world, 30, 130, Math.PI, blockers, [], deck);
    expect(spot.x !== 30 || spot.z !== 130).toBe(true);
    expect(spot.y).toBeGreaterThan(deck - 1.5);
    expect(surfaceHeight(world, spot.x, spot.z, deck)).toBeCloseTo(spot.y, 1);
  });

  it("gets out of a car in the bore at the bore floor", () => {
    const floor = surfaceHeight(world, 0, -100, 0);
    const car = makeCar(0, -100, 0, floor);
    const foot = exitSpot(world, car, [], []);
    expect(foot, "room to get out inside the bore").not.toBeNull();
    expect(foot!.y).toBeLessThan(floor + 0.5);
  });

  it("gets into a car only on its own level", () => {
    const deck = overpassY(130);
    const below = makeCar(30, 130, Math.PI, surfaceHeight(world, 30, 130, 0));
    const onDeck = makeCar(30, 130, Math.PI, deck);
    // A walker beside the car at its level gets in; one on the other level does not.
    expect(canEnterCar(world, below, 31.6, 130, below.y)).toBe(true);
    expect(canEnterCar(world, below, 31.6, 130, deck)).toBe(false);
    expect(canEnterCar(world, onDeck, 31.6, 130, deck)).toBe(true);
    expect(canEnterCar(world, onDeck, 31.6, 130, below.y)).toBe(false);
  });
});
