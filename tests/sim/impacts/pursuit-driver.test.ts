import { expect, it } from "vitest";
import { createInitialState, createGameSystems, step, impactsOf, type AgentsExt, propIndex } from "../../../src/sim/index.ts";
import { loadWorld } from "../../helpers.ts";
import { pursuitKeys } from "../../e2e/impact-driver.ts";

it("keyboard pursuit reaches a naturally spawned dev-world robot and it recovers", () => {
  const { world, manifest } = loadWorld("dev", { roads: true });
  let s = createInitialState(world, 1, ["p1"], manifest.spawn);
  const systems = createGameSystems({ wave: 3 });
  let target = -1, hitId = -1;
  let toppled = false, down = false, recovered = false;
  let keys = new Set<string>();
  for (let t = 0; t < 9000; t++) {
    const robots = (s.ext.agents as AgentsExt).list.filter(a => a.kind === "errandRobot" || a.kind === "sidewalkBot");
    const car = s.players.p1!.car;
    if (t % 6 === 0 && hitId < 0) {
      let robot = robots.find(a => a.id === target && !a.knock);
      if (!robot) robot = robots.filter(a => !a.knock).sort((a,b) => Math.hypot(a.x-car.x,a.z-car.z)-Math.hypot(b.x-car.x,b.z-car.z))[0];
      if (robot) { target = robot.id; keys = pursuitKeys(car, robot); }
    }
    s = step(world, s, { p1: { throttle: hitId >= 0 ? (car.speed > 0.1 ? -1 : 0) : keys.has("KeyS") ? -1 : 1, steer: hitId >= 0 ? 0 : keys.has("KeyD") ? 1 : keys.has("KeyA") ? -1 : 0, brake: 0, actions: 0 } }, [], systems);
    const hit = impactsOf(s)?.events.find(e => e.a === "p:p1" && e.kind === "car-robot");
    if (hit && hitId < 0) hitId = Number(hit.b.slice(2));
    if (hitId >= 0) {
      const robot = (s.ext.agents as AgentsExt).list.find(a => a.id === hitId);
      expect(robot, "the struck robot stays present").toBeDefined();
      toppled ||= Math.abs(robot!.pitch) > 1;
      down ||= robot!.knock?.phase === "down";
      if (down && robot!.knock === undefined && robot!.pitch === 0) { recovered = true; break; }
    }
  }
  expect(hitId).toBeGreaterThan(0);
  expect(toppled).toBe(true);
  expect(down).toBe(true);
  expect(recovered).toBe(true);
}, 60000);

it("keyboard pursuit hits a naturally placed dev-world breakable tree", () => {
  const { world, manifest } = loadWorld("dev", { roads: true });
  let s = createInitialState(world, 1, ["p1"], manifest.spawn);
  const systems = createGameSystems({ wave: 3 });
  const car = s.players.p1!.car;
  const tree = propIndex(world).list.filter(p => p.kind === "tree" && p.size !== "mature")
    .sort((a,b) => Math.hypot(a.x-car.x,a.z-car.z)-Math.hypot(b.x-car.x,b.z-car.z))[0]!;
  expect(tree).toBeDefined();
  let keys = new Set<string>();
  for (let t = 0; t < 9000; t++) {
    if (t % 6 === 0) keys = pursuitKeys(s.players.p1!.car, tree, 10);
    s = step(world, s, { p1: { throttle: keys.has("KeyS") ? -1 : 1, steer: keys.has("KeyD") ? 1 : keys.has("KeyA") ? -1 : 0, brake: 0, actions: 0 } }, [], systems);
    if (Object.keys(impactsOf(s)?.props ?? {}).length) return;
  }
  expect.fail("the controller did not reach a breakable tree");
}, 60000);
