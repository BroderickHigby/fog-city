import { describe, expect, it } from "vitest";
import { buildTrafficSignals, signalAspect, signalPhase, SIGNAL_SLOT_S } from "../../src/sim/traffic-signals.ts";
import { buildWorld, type World } from "../../src/sim/world.ts";
import { createInitialState, upgradeState } from "../../src/sim/step.ts";
import { AGENT_SPEC, STOPLINE_M, stepAgents, type AgentState } from "../../src/sim/agents.ts";
import { lanePath, pathPoint, type RoadsFile } from "../../src/sim/roads.ts";
import { makeFoot } from "../../src/sim/foot.ts";
import type { SimState } from "../../src/sim/contract.ts";

function junction(angles = [0, 90, 180, 270]): World {
  const nodes = [{ id: "J", x: 0, z: 0 }, ...angles.map((a, i) => ({ id: `n${i}`, x: Math.sin(a * Math.PI / 180) * 150, z: -Math.cos(a * Math.PI / 180) * 150 }))];
  const edges: RoadsFile["edges"] = angles.map((_, i) => ({ id: `e${i}`, a: `n${i}`, b: "J", kind: "residential", lanes: 2, oneway: false, widthM: 12, points: [[nodes[i + 1]!.x, nodes[i + 1]!.z], [0, 0]] }));
  const world = buildWorld([], { version: 1, nodes, edges });
  world.signals = buildTrafficSignals(world.roads!, { signals: [{ node: "J", kind: "signal", ped: true }] });
  return world;
}

function car(world: World, id = 1, edgeId = "e0", distance = 25, speed = 8): AgentState {
  const edge = world.roads!.edges.find(edge => edge.id === edgeId)!, path = lanePath(edge, 1, 0), point = pathPoint(path, path.len - distance);
  return { id, kind: "robotaxi", x: point.x, y: 0, z: point.z, heading: Math.atan2(point.tx, -point.tz), pitch: 0,
    speed, vmax: 8, edge: edgeId, dir: 1, lane: 0, s: path.len - distance,
    next: edgeId === "short" ? "exit" : edgeId === "e0" ? "e2" : "e3", ndir: edgeId === "short" ? 1 : -1, nlane: 0,
    conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 123, dodge: null };
}

function state(world: World, cars: AgentState[], tick: number, version = 20): SimState {
  const initial = createInitialState(world, 42, ["p"], { x: 900, z: 900, heading: 0 });
  initial.players.p = { ...initial.players.p!, mode: "foot", foot: makeFoot(65, 0, 65, 0) };
  return { ...initial, version, tick, ext: { agents: { list: cars, nextId: 100 } } };
}

function advance(world: World, previous: SimState, fixed: ReadonlySet<number> = new Set()): SimState {
  const result = stepAgents(world, previous, previous.tick + 1, fixed)!;
  // No population admission is needed in this small traffic-control fixture.
  const existing = new Set(previous.ext.agents!.list.map(agent => agent.id));
  return { ...previous, tick: previous.tick + 1, rng: result.rng, ext: { agents: { ...result.ext, list: result.ext.list.filter(agent => existing.has(agent.id)) } } };
}

function atPhase(world: World, edge: string, aspect: "green" | "yellow" | "red", stableSeconds = 0, node = "J"): number {
  const count = world.signals!.get(node)!.groupCount;
  for (let tick = 0; tick < count * SIGNAL_SLOT_S * 60; tick++) {
    let matches = true;
    for (let second = 0; second <= stableSeconds; second++) if (signalAspect(world.signals, node, edge, tick + second * 60) !== aspect) { matches = false; break; }
    if (matches) return tick;
  }
  throw new Error(`No ${aspect} phase for ${edge}`);
}

describe("deterministic shared traffic signal policy", () => {
  it("pairs opposite approaches and never shows green to crossing axes", () => {
    const world = junction(), controller = world.signals!.get("J")!;
    expect(controller.groupCount).toBe(2);
    expect(controller.approaches.get("e0")).toBe(controller.approaches.get("e2"));
    expect(controller.approaches.get("e1")).toBe(controller.approaches.get("e3"));
    expect(controller.approaches.get("e0")).not.toBe(controller.approaches.get("e1"));
    let allRed = 0, amber = 0;
    for (let tick = 0; tick < 2 * SIGNAL_SLOT_S * 60; tick++) {
      const a = signalAspect(world.signals, "J", "e0", tick), b = signalAspect(world.signals, "J", "e1", tick);
      expect(a === "green" && b === "green").toBe(false);
      if (a === "red" && b === "red") allRed++;
      if (a === "yellow" || b === "yellow") amber++;
    }
    expect(allRed).toBe(4 * 60); expect(amber).toBe(6 * 60);
    expect(signalAspect(world.signals, "unknown", "e0", 0)).toBeNull();
    expect(signalPhase("J", 0, 0, 0)).toEqual({ aspect: "red", walk: false });
  });

  it("groups skew/near-parallel axes deterministically and handles three distinct axes", () => {
    const world = junction([0, 60, 120, 180, 240, 300]);
    expect(world.signals!.get("J")!.groupCount).toBe(3);
    const near = junction([2, 88, 177, 273]);
    expect(near.signals!.get("J")!.groupCount).toBe(2);
    const graph = near.roads!;
    const reversed = { ...graph, edges: [...graph.edges].reverse() };
    const again = buildTrafficSignals(reversed, { signals: [{ node: "J", kind: "signal" }] });
    expect([...again.get("J")!.approaches]).toEqual([...near.signals!.get("J")!.approaches]);
    const inOnly = buildWorld([], { version: 1, nodes: [{ id: "J", x: 0, z: 0 }, { id: "out", x: 100, z: 0 }], edges: [{ id: "exit", a: "J", b: "out", oneway: true, lanes: 1, kind: "residential", points: [[0, 0], [100, 0]] }] });
    expect(buildTrafficSignals(inOnly.roads!, { signals: [{ node: "J", kind: "signal" }] }).size).toBe(0);
  });
});

describe("v20 vehicles obey their approach signal", () => {
  it.each(["red", "yellow"] as const)("brakes for %s before entering", aspect => {
    const world = junction(), tick = atPhase(world, "e0", aspect, aspect === "red" ? 25 : 1);
    let current = state(world, [car(world, 1, "e0", 7)], tick);
    const previous = current;
    const original = JSON.stringify(current);
    current = advance(world, current);
    expect(JSON.stringify(previous)).toBe(original);
    expect(current.ext.agents!.list[0]!.speed).toBeLessThan(8);
    const steps = aspect === "red" ? 22 * 60 : 60;
    for (let i = 0; i < steps; i++) current = advance(world, current);
    const result = current.ext.agents!.list[0]!;
    expect(result.conn).toBeNull(); expect(result.edge).toBe("e0"); expect(result.node).toBe("");
    expect(result.s).toBeLessThanOrEqual(lanePath(world.roads!.edges[0]!, 1, 0).len - AGENT_SPEC.robotaxi.halfLength);
    if (aspect === "red") { expect(result.speed).toBeLessThan(.05); expect(result.ghost).toBe(0); }
  });

  it("releases a stopped car on green and keeps a committed holder moving through red", () => {
    const world = junction(), tick = atPhase(world, "e0", "green", 10);
    let current = state(world, [car(world, 1, "e0", AGENT_SPEC.robotaxi.halfLength + 1, 0)], tick);
    let holder: AgentState | undefined;
    for (let i = 0; i < 240 && !holder?.conn; i++) { current = advance(world, current); holder = current.ext.agents!.list[0]; }
    expect(holder?.conn).not.toBeNull(); expect(holder?.node).toBe("J");
    current = { ...current, tick: atPhase(world, "e0", "red", 5) };
    const initialS = holder!.s;
    for (let i = 0; i < 60; i++) current = advance(world, current);
    const progressed = current.ext.agents!.list[0]!;
    expect(progressed.speed).toBeGreaterThan(0);
    expect(progressed.edge !== holder!.edge || progressed.s > initialS).toBe(true);
  });

  it("keeps ghost recovery behind red and preserves v19 results bit for bit", () => {
    const world = junction(), tick = atPhase(world, "e0", "red", 8), vehicle = { ...car(world, 1, "e0", 4, 0), ghost: 300 };
    let current = state(world, [vehicle], tick);
    for (let i = 0; i < 120; i++) current = advance(world, current);
    expect(current.ext.agents!.list[0]!.conn).toBeNull(); expect(current.ext.agents!.list[0]!.node).toBe("");
    const prior = state(world, [car(world)], tick, 19), without = { ...world, signals: undefined };
    expect(stepAgents(world, prior, tick + 1)).toEqual(stepAgents(without, prior, tick + 1));
  });

  it("upgrades a v19 save by restamping without changing its cars or saved extensions", () => {
    const world = junction(), previous = state(world, [car(world)], 77, 19), saved = JSON.stringify(previous);
    const upgraded = upgradeState(previous);
    expect(upgraded).toEqual({ ...previous, version: 24 });
    expect(upgraded.ext).toBe(previous.ext); expect(upgraded.players).toBe(previous.players);
    expect(JSON.stringify(previous)).toBe(saved); expect(upgradeState(upgraded)).toBe(upgraded);
  });

  it("does not release a new green approach through a conflicting existing holder", () => {
    const world = junction(), tick = atPhase(world, "e0", "green", 6);
    const waiting = car(world, 1, "e0", AGENT_SPEC.robotaxi.halfLength + 1, 0);
    const blocking = { ...car(world, 2, "e1", .1, 0), node: "J" };
    let current = state(world, [waiting, blocking], tick);
    for (let i = 0; i < 60; i++) current = advance(world, current, new Set([2]));
    expect(current.ext.agents!.list.find(agent => agent.id === 1)!.conn).toBeNull();
    expect(current.ext.agents!.list.find(agent => agent.id === 1)!.node).toBe("");
  });

  it.each(["red", "yellow"] as const)("expires a green reservation still behind the stop line on %s", aspect => {
    const world = junction(), green = atPhase(world, "e0", "green", 5);
    const waiting = car(world, 1, "e0", AGENT_SPEC.robotaxi.halfLength + STOPLINE_M + .8, 0);
    const pedestrian: AgentState = { ...waiting, id: 2, kind: "person", z: waiting.z + 3, speed: 0, vmax: 0, node: "" };
    let current = state(world, [waiting, pedestrian], green);
    for (let i = 0; i < 30; i++) current = advance(world, current, new Set([2]));
    const reserved = current.ext.agents!.list.find(agent => agent.id === 1)!;
    const stopLine = lanePath(world.roads!.edges[0]!, 1, 0).len - AGENT_SPEC.robotaxi.halfLength - STOPLINE_M;
    expect(reserved.node).toBe("J"); expect(reserved.conn).toBeNull(); expect(reserved.s).toBeLessThanOrEqual(stopLine);
    current = { ...current, tick: atPhase(world, "e0", aspect, aspect === "red" ? 8 : 1), ext: { agents: { nextId: 100, list: [reserved] } } };
    const before = JSON.stringify(current);
    const previous = current;
    current = advance(world, current);
    expect(JSON.stringify(previous)).toBe(before);
    expect(current.ext.agents!.list[0]!.node).toBe("");
    for (let i = 0; i < 60; i++) current = advance(world, current);
    const stopped = current.ext.agents!.list[0]!;
    expect(stopped.conn).toBeNull(); expect(stopped.edge).toBe("e0"); expect(stopped.s).toBeLessThanOrEqual(stopLine + 1e-6);
  });

  it("lets an incoming holder whose front is already past the line clear the junction", () => {
    const world = junction(), tick = atPhase(world, "e0", "red", 5);
    const entered = { ...car(world, 1, "e0", AGENT_SPEC.robotaxi.halfLength + STOPLINE_M - .3, 2), node: "J" };
    let current = state(world, [entered], tick);
    for (let i = 0; i < 60; i++) current = advance(world, current);
    const result = current.ext.agents!.list[0]!;
    expect(result.speed).toBeGreaterThan(0); expect(result.conn !== null || result.edge !== entered.edge).toBe(true);
  });

  it("preserves a v19 pre-entry reservation exactly under its original rules", () => {
    const world = junction(), tick = atPhase(world, "e0", "red", 5);
    const reserved = { ...car(world, 1, "e0", AGENT_SPEC.robotaxi.halfLength + STOPLINE_M + .8, 0), node: "J" };
    const previous = state(world, [reserved], tick, 19);
    expect(stepAgents(world, previous, tick + 1)).toEqual(stepAgents({ ...world, signals: undefined }, previous, tick + 1));
    const result = advance(world, previous).ext.agents!.list[0]!;
    expect(result.node).toBe("J"); expect(result.speed).toBeGreaterThan(0);
  });

  it("claims a degree-two signal at the end of a derived short lane while clearing the previous junction", () => {
    const nodes = [{ id: "A", x: 0, z: 0 }, { id: "B", x: 0, z: 21.39 }, { id: "C", x: 100, z: 21.39 }, { id: "W", x: -100, z: 0 }, { id: "E", x: 100, z: 0 }, { id: "N", x: 0, z: -100 }];
    const edges: RoadsFile["edges"] = [["short", "A", "B"], ["exit", "B", "C"], ["west", "W", "A"], ["east", "A", "E"], ["north", "N", "A"]].map(([id, a, b]) => {
      const from = nodes.find(n => n.id === a)!, to = nodes.find(n => n.id === b)!;
      return { id: id!, a: a!, b: b!, kind: "residential", lanes: 2, oneway: false, widthM: 12, points: [[from.x, from.z], [to.x, to.z]] };
    });
    const world = buildWorld([], { version: 1, nodes, edges });
    world.signals = buildTrafficSignals(world.roads!, { signals: [{ node: "B", kind: "signal" }] });
    const lane = lanePath(world.roads!.edges.find(edge => edge.id === "short")!, 1, 0), stop = lane.len - AGENT_SPEC.robotaxi.halfLength - STOPLINE_M;
    expect(world.roads!.nodes.find(node => node.id === "B")!.degree).toBe(2);
    expect(stop).toBeLessThan(AGENT_SPEC.robotaxi.halfLength + 1); // Tail cannot clear A before the red line.
    const vehicle = { ...car(world, 1, "short", lane.len - .25, 0), node: "A" };
    let current = state(world, [vehicle], atPhase(world, "short", "red", 5, "B"));
    for (let i = 0; i < 180; i++) current = advance(world, current);
    expect(current.ext.agents!.list[0]!.node).toBe("A");
    expect(current.ext.agents!.list[0]!.s).toBeLessThanOrEqual(stop + 1e-6);
    current = { ...current, tick: atPhase(world, "short", "green", 8, "B") };
    let released = false;
    for (let i = 0; i < 240; i++) { current = advance(world, current); const moving = current.ext.agents!.list[0]!; released ||= moving.node === "B" || moving.conn !== null || moving.edge === "exit"; }
    expect(released).toBe(true);
  });

  it("keeps a distant queue through a complete five-axis red phase and resumes on first green", () => {
    const world = junction([0, 36, 72, 108, 144, 180, 216, 252, 288, 324]);
    expect(world.signals!.get("J")!.groupCount).toBe(5);
    const vehicle = car(world, 1, "e0", AGENT_SPEC.robotaxi.halfLength + STOPLINE_M, 0);
    let current = state(world, [vehicle], atPhase(world, "e0", "red", 100));
    expect(Math.hypot(vehicle.x - current.players.p!.foot!.x, vehicle.z - current.players.p!.foot!.z)).toBeGreaterThan(60);
    let waited = 0;
    while (signalAspect(world.signals, "J", "e0", current.tick + 1) !== "green" && waited < 160 * 60) {
      current = advance(world, current); waited++;
      expect(current.ext.agents!.list.map(agent => agent.id)).toContain(1);
    }
    expect(waited).toBeGreaterThan(30 * 60);
    expect(current.ext.agents!.list[0]!.ghost).toBe(0);
    for (let i = 0; i < 120; i++) current = advance(world, current);
    expect(current.ext.agents!.list[0]!.id).toBe(1);
    expect(current.ext.agents!.list[0]!.speed).toBeGreaterThan(0);
  });
});

describe("v21 amber dilemma zone", () => {
  /** The tick whose next tick turns this approach amber. */
  function lastGreen(world: World, edge: string): number {
    const count = world.signals!.get("J")!.groupCount;
    for (let tick = 0; tick < count * SIGNAL_SLOT_S * 60; tick++)
      if (signalAspect(world.signals, "J", edge, tick) === "green" && signalAspect(world.signals, "J", edge, tick + 1) === "yellow") return tick;
    throw new Error(`No amber onset for ${edge}`);
  }
  const nearLine = AGENT_SPEC.robotaxi.halfLength + STOPLINE_M + 0.6;

  it("a robotaxi that cannot stop behind the line goes on through amber", () => {
    const world = junction();
    let current = state(world, [car(world, 1, "e0", nearLine, 8)], lastGreen(world, "e0"), 21);
    let worst = 0, entered = false;
    for (let i = 0; i < 90 && !entered; i++) {
      const before = current.ext.agents!.list[0]!.speed;
      current = advance(world, current);
      const a = current.ext.agents!.list[0]!;
      worst = Math.max(worst, (before - a.speed) * 60);
      entered = a.conn !== null || a.edge !== "e0";
    }
    expect(entered).toBe(true);
    expect(worst).toBeLessThanOrEqual(AGENT_SPEC.robotaxi.decel + 1e-6);
  });

  it("a robotaxi with room to stop still stops behind the line", () => {
    const world = junction();
    let current = state(world, [car(world, 1, "e0", 25, 8)], lastGreen(world, "e0"), 21);
    for (let i = 0; i < 240; i++) current = advance(world, current);
    const a = current.ext.agents!.list[0]!;
    expect(a.conn).toBeNull(); expect(a.edge).toBe("e0"); expect(a.node).toBe("");
    expect(a.speed).toBeLessThan(.05);
    expect(a.s).toBeLessThanOrEqual(lanePath(world.roads!.edges[0]!, 1, 0).len - AGENT_SPEC.robotaxi.halfLength - STOPLINE_M + 1e-6);
  });

  it("no approach speed or distance stops dead: no tick drops more than 0.5 m/s (3 g)", () => {
    const world = junction(), onset = lastGreen(world, "e0"), len = lanePath(world.roads!.edges[0]!, 1, 0).len;
    const line = len - AGENT_SPEC.robotaxi.halfLength - STOPLINE_M, dead: string[] = [];
    for (const speed of [6, 8, 10, 12]) for (let distance = 6; distance <= 65; distance++) {
      let current = state(world, [{ ...car(world, 1, "e0", distance, speed), vmax: 13 }], onset, 21), worst = 0, entered = false;
      for (let i = 0; i < 400 && !entered; i++) {
        const before = current.ext.agents!.list[0]!.speed;
        current = advance(world, current);
        const a = current.ext.agents!.list[0]!;
        worst = Math.max(worst, before - a.speed);
        entered = a.conn !== null || a.edge !== "e0";
      }
      const a = current.ext.agents!.list[0]!;
      if (worst > .5 || (!entered && (a.speed > .05 || a.s > line + 1e-6))) dead.push(`${speed} m/s at ${distance} m: dropped ${worst.toFixed(2)} m/s in a tick`);
    }
    expect(dead).toEqual([]);
  });

  it("v20 replays keep the old hard stop at the line", () => {
    const world = junction();
    let current = state(world, [car(world, 1, "e0", nearLine, 8)], lastGreen(world, "e0"), 20);
    for (let i = 0; i < 6; i++) current = advance(world, current);
    const a = current.ext.agents!.list[0]!;
    expect(a.conn).toBeNull(); expect(a.edge).toBe("e0"); expect(a.speed).toBe(0);
    expect(upgradeState(current).version).toBe(24);
  });
});
