import { describe, expect, it } from "vitest";
import {
  agentsOf, createInitialState, lanePath, pathPoint, pointRectGap,
  rectAt, ROBOTAXI_BODY, stepAgents, TRUNDLE_FREE_VERSION, type AgentState,
} from "../../src/sim/index.ts";
import { gridCity, LONG_RUN_MS } from "./fixtures.ts";

/** Freeze only the obstruction, so an ordinary delivery dwell cannot hide a traffic deadlock. */
function scenario(kind: AgentState["kind"], flags: Partial<AgentState> = {}): { passed: boolean; planned: boolean } {
  const world = gridCity();
  let state = createInitialState(world, 7, ["p1"], { x: 80, z: 135, heading: 0 });
  // From v24 an ambient Trundle leaves the street on the first step: a stopped one is a v23 scene.
  if (kind === "sidewalkBot") state = { ...state, version: TRUNDLE_FREE_VERSION - 1 };
  const template = agentsOf(state).find(a => a.kind === "robotaxi")!;
  const edge = world.roads!.edges[world.roads!.edgeIndex.get("h11")!]!;
  const pose = pathPoint(lanePath(edge, 1, 0), 20);
  const taxi: AgentState = { ...template, id: 9001, x: pose.x, z: pose.z, heading: Math.atan2(pose.tx, -pose.tz), speed: 0,
    edge: "h11", dir: 1, lane: 0, s: 20, next: "", ndir: 1, nlane: 0, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", dodge: null };
  const obstacle: AgentState = { ...taxi, id: 9002, kind, x: 150, z: pose.z, s: 50, radius: .45, speed: 0, ...flags };
  state = { ...state, ext: { ...state.ext, agents: { nextId: 9003, list: [taxi, obstacle] } } };
  let planned = false;
  for (let i = 0; i < 1200; i++) {
    const tick = state.tick + 1;
    const next = stepAgents(world, state, tick, new Set([obstacle.id]))!;
    state = { ...state, tick, rng: next.rng, ext: { ...state.ext, agents: next.ext } };
    const drawn = next.ext.list.find(a => a.id === taxi.id);
    // Removing a stuck taxi is not recovery: it must actually drive beyond the obstruction.
    expect(drawn).toBeDefined();
    if (!drawn) return { passed: false, planned };
    planned ||= drawn.pass !== undefined;
    expect(drawn.ghost).toBe(0);
    // The full slow berth is kept at every tick, including during ease-out and rejoin.
    const berth = flags.child ? 1.25 : .75;
    expect(pointRectGap(obstacle.x, obstacle.z, rectAt(drawn.x, drawn.z, drawn.heading, ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth))).toBeGreaterThan(.45 + berth);
    if (drawn.x > obstacle.x + 8 && Math.abs(drawn.z - pose.z) < .2) return { passed: true, planned };
  }
  return { passed: false, planned };
}

describe("stationary delivery robot holding a lane", () => {
  it.each(["sidewalkBot", "errandRobot"] as const)("waits, passes the stopped %s and rejoins without contact or ghosting", kind => {
    expect(scenario(kind)).toEqual({ passed: true, planned: true });
  }, LONG_RUN_MS);
  it("keeps the full berth around a protected body", () => {
    expect(scenario("sidewalkBot", { protected: true, mobilityAid: true, posture: "seated" })).toEqual({ passed: true, planned: true });
  }, LONG_RUN_MS);
  it("keeps the wider child berth around a protected person", () => {
    expect(scenario("person", { protected: true, child: true })).toEqual({ passed: true, planned: true });
  }, LONG_RUN_MS);
});
