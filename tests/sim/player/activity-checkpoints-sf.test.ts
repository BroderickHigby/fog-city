import { expect, it } from "vitest";
import { sfWorld, CITY_MS } from "../world/load.ts";
import { circleBlocked } from "../../../src/sim/world.ts";
import { nearestDrivableLane } from "../../../src/sim/vehicles/follower.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { PLAIN_WORDS_BOARDS } from "../../../src/sim/activities/plain-words.ts";
import { pointInPolygon } from "../../../src/sim/world.ts";
import { protectedAreaAt } from "../../../src/content/places.ts";
import { toLatLon, toLocal } from "../../../src/geo/project.ts";
import { ACTIVITY_RULES } from "../../../src/content/gameplay.ts";
import { readJson } from "../../helpers.ts";

/**
 * Every checkpoint of an activity the game offers must be a place a player can stand in the real
 * city: open ground at its centre, and a street within reach. Hand-placed points once sat inside
 * blocks or in China Basin, which made those routes impossible to finish.
 */
it("puts every offered activity checkpoint on reachable open ground in SF", () => {
  const { world } = sfWorld();
  const offered = DEFAULT_CATALOG.activities.filter(activity => activity.checkpoints?.length);
  expect(offered.length).toBeGreaterThan(0);
  for (const activity of offered) for (const point of activity.checkpoints!) {
    const where = `${activity.id}:${point.id}`;
    expect(circleBlocked(world, point.x, point.z, .5), `${where} centre is inside a building or water`).toBe(false);
    expect(nearestDrivableLane(world.roads!, point)!.distance, `${where} is far from any street`).toBeLessThan(25);
  }
}, CITY_MS);

/** docs/design.md, Plain Words: Columbus Ave north of Broadway only; never Chinatown, Stockton or Grant. */
it("stands every Plain Words board on open Columbus Ave sidewalk, outside Chinatown and protected areas", () => {
  const { world } = sfWorld();
  const neighbourhoods = readJson<{ districts: { id: string; polygons: [number, number][][][] }[] }>("public/tiles/sf/districts.json").districts;
  const chinatown = neighbourhoods.find(value => value.id === "chinatown")!;
  const south = toLocal(ACTIVITY_RULES.plainWords.southLat, 0).z, north = toLocal(ACTIVITY_RULES.plainWords.northLat, 0).z;
  expect(PLAIN_WORDS_BOARDS).toHaveLength(20);
  for (const board of PLAIN_WORDS_BOARDS) {
    expect(circleBlocked(world, board.x, board.z, .5), `${board.id} is inside a building`).toBe(false);
    expect(chinatown.polygons.some(polygon => pointInPolygon(board.x, board.z, polygon[0]!)), `${board.id} is in Chinatown`).toBe(false);
    const { lat, lon } = toLatLon(board.x, board.z);
    expect(protectedAreaAt([lat, lon]), `${board.id} is in a protected area`).toBeUndefined();
    expect(board.z).toBeLessThanOrEqual(south + 1);
    expect(board.z).toBeGreaterThanOrEqual(north - 1);
    const lane = nearestDrivableLane(world.roads!, board)!;
    expect(world.roads!.edges[lane.edge]!.name, `${board.id} is not beside Columbus Ave`).toBe("Columbus Ave");
  }
}, CITY_MS);
