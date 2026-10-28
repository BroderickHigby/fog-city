// v26 (UNSTICK_VERSION): a walker that turns round in the middle of a street crossing walks back to
// the kerb it came from. v25 and older aim the turn at the far kerb's sidewalk (the edge a crossing
// walker is already on), so it loops straight back into the robotaxi that stopped it, and the
// robotaxi (which waits for walkers) and the cars behind it wait for the deadlock breaker. Footmen
// (bigger and faster than the Trundles they replace) made this stand-off common: seed 11 of the
// grid-city long run (agents.test.ts "traffic keeps moving") hit the breaker at v26 until it was fixed.
import { describe, expect, it } from "vitest";
import {
  UNSTICK_VERSION, WALKER_TURN_TICKS, agentsOf, connector, createInitialState, pathPoint, stepAgents, walkPath,
  type AgentState, type SimState,
} from "../../src/sim/index.ts";
import { gridCity } from "./fixtures.ts";

function scene(version: number): { walker: AgentState[]; taxi: AgentState } {
  const world = gridCity(), g = world.roads!;
  const edge = (id: string) => g.edges[g.edgeIndex.get(id)!]!;
  let state: SimState = { ...createInitialState(world, 11, ["p1"], { x: -20, z: 150, heading: 0 }), version };
  const list = agentsOf(state);
  // A Footman crossing the street at g12 (h02's sidewalk end to h12's), 3 m out from the kerb.
  const inbound = pathPoint(walkPath(edge("h02"), 1, -1), Infinity), outbound = pathPoint(walkPath(edge("h12"), 1, -1), 0);
  const cross = connector(inbound.x, inbound.z, inbound.tx, inbound.tz, outbound.x, outbound.z, outbound.tx, outbound.tz, 0.9);
  const footman: AgentState = { ...list.find((a) => a.kind === "errandRobot")!, id: 9001, x: inbound.x + 3, z: inbound.z,
    heading: Math.atan2(inbound.tx, -inbound.tz), speed: 1.6, vmax: 1.6, edge: "h12", dir: 1, lane: -1, s: 3, next: "h22", ndir: 1, nlane: -1,
    conn: cross, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", dodge: null };
  // A robotaxi stopped on the crosswalk 2.4 m ahead of it, turning (frozen: it waits for the walker).
  const robotaxi: AgentState = { ...list.find((a) => a.kind === "robotaxi")!, id: 9002, x: inbound.x + 8.8, z: inbound.z - 0.3,
    heading: -2.72, speed: 0, edge: "h02", dir: -1, lane: 1, s: 2.1, next: "", conn: null, node: "", wait: 0, ghost: 0, mode: "wait", dodge: null };
  state = { ...state, ext: { ...state.ext, agents: { nextId: 9003, list: [footman, robotaxi] } } };
  const walker: AgentState[] = [];
  for (let i = 0; i < WALKER_TURN_TICKS + 600; i++) {
    const tick = state.tick + 1;
    const next = stepAgents(world, state, tick, new Set([robotaxi.id]))!;
    state = { ...state, tick, rng: next.rng, ext: { ...state.ext, agents: next.ext } };
    walker.push(next.ext.list.find((a) => a.id === footman.id)!);
  }
  return { walker, taxi: robotaxi };
}

describe("v26: a walker turning round mid-crossing goes back to its kerb", () => {
  it("walks back off the crossing and away from the robotaxi that stopped it", () => {
    const { walker, taxi } = scene(UNSTICK_VERSION);
    const start = walker[0]!;
    const last = walker.at(-1)!;
    // It stopped short of the robotaxi, then turned round and left: back on h02's sidewalk,
    // walking away from the junction, and never nearer the robotaxi than where it stopped.
    expect(walker.some((a) => a.mode === "wait")).toBe(true);
    expect(last.edge).not.toBe("h12");
    expect(last.conn === null || last.edge !== start.edge).toBe(true);
    const gap = (a: AgentState) => Math.hypot(a.x - taxi.x, a.z - taxi.z);
    const closest = Math.min(...walker.map(gap));
    expect(gap(last)).toBeGreaterThan(closest + 8);
    expect(last.wait).toBe(0);
  });

  it("v25 (before the fix): the turn loops back into the robotaxi, and the walker is still stuck beside it", () => {
    const { walker, taxi } = scene(UNSTICK_VERSION - 1);
    const last = walker.at(-1)!;
    expect(Math.hypot(last.x - taxi.x, last.z - taxi.z)).toBeLessThan(4);
  });
});
