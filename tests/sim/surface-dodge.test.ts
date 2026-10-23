// The two v4 branches changed the same tick: exercise their combined behavior, not just
// each branch's isolated fixtures. Cars keep their deck/bore, while a teammate dodges them.
import { describe, expect, it } from "vitest";
import { AGENTS_EXT_KEY, CAR, FOOT, agentsOf, boxDistance, createInitialState, dodgeExtOf, groundFor, makeCar, makeFoot, step, stepDodge, type AgentsExt } from "../../src/sim/index.ts";
import { surfaceWorld } from "./fixtures.ts";

describe("dodge with deck and tunnel surfaces", () => {
  for (const place of [
    { name: "deck", x: 30, z: 104, y: 6, heading: Math.PI, ahead: 26 },
    { name: "bore", x: 0, z: -65, y: 0, heading: 0, ahead: -25 },
  ]) {
    it(`keeps a driving car on the ${place.name} while never contacting a teammate`, () => {
      const world = surfaceWorld();
      let s = createInitialState(world, 4, ["driver", "walker"], { x: -200, z: 0, heading: 0 });
      s = { ...s, players: {
        driver: { ...s.players.driver!, car: { ...makeCar(place.x, place.z, place.heading, place.y), speed: 16 } },
        walker: { ...s.players.walker!, mode: "foot", car: makeCar(-220, 50, 0), foot: makeFoot(place.x, place.y, place.z + place.ahead, 0) },
      } };
      for (let i = 0; i < 180; i++) {
        s = step(world, s, { driver: { throttle: 0.4, steer: 0, brake: 0, actions: 0 } });
        const c = s.players.driver!.car;
        const f = s.players.walker!.foot!;
        expect(dodgeExtOf(s).contacts, `tick ${s.tick}`).toBe(0);
        expect(c.personBumps).toBe(0);
        if (place.name === "deck" && c.z <= 160) expect(c.y).toBeGreaterThan(5.9);
        if (place.name === "bore" && c.z > -145) expect(Math.abs(c.y)).toBeLessThan(0.05);
        if (f.y < c.y + CAR.bodyHeight && c.y < f.y + FOOT.height) {
          const clearance = boxDistance(f.x, f.z, c.x, c.z, Math.sin(c.heading), -Math.cos(c.heading), CAR.halfLength, CAR.halfWidth);
          expect(clearance, `tick ${s.tick}`).toBeGreaterThanOrEqual(FOOT.radius);
        }
      }
      expect(dodgeExtOf(s).dives).toBeGreaterThan(0);
    });
  }
});


describe("ambient dives keep their road surface", () => {
  for (const place of [
    { name: "deck", edge: "deck-st", x: 30, z: 130, y: 6, heading: Math.PI, behind: -10 },
    { name: "bore", edge: "bore-st", x: 0, z: -100, y: 0, heading: 0, behind: 10 },
  ]) {
    it(`plans and places the dodge on the ${place.name}, not the terrain underneath/above it`, () => {
      const world = surfaceWorld(true);
      let s = createInitialState(world, 42, ["driver"], { x: place.x, z: place.z + place.behind, heading: place.heading });
      const source = agentsOf(s).find((a) => a.kind === "person");
      expect(source).toBeDefined();
      const a = { ...source!, id: 1, edge: place.edge, x: place.x, z: place.z, y: place.y, dodge: null };
      s = { ...s, players: { driver: { ...s.players.driver!, car: { ...makeCar(place.x, place.z + place.behind, place.heading, place.y), speed: 16 } } }, ext: { [AGENTS_EXT_KEY]: { nextId: 2, list: [a] } } };
      const ground = groundFor(world, false, place.edge);
      expect(ground.height(place.x, place.z, place.y)).toBeCloseTo(place.y, 5);
      const next = stepDodge(world, s, s);
      const moved = (next.ext[AGENTS_EXT_KEY] as AgentsExt).list[0]!;
      expect(moved.dodge).not.toBeNull();
      expect(moved.y - (moved.dodge?.hop ?? 0)).toBeCloseTo(place.y, 5);
      expect(dodgeExtOf(next).contacts).toBe(0);
    });
  }
});
