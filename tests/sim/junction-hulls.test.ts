import { describe, expect, it } from "vitest";
import { junctionPathHitsHull, shortLinkSignalWindow, stepAgents, ROBOTAXI_BODY } from "../../src/sim/agents.ts";
import pendingYield from "./fixtures/pending-junction-yield-v21.json";
import separatingTurn from "./fixtures/separating-turn-v21.json";
import queueFixture from "./fixtures/junction-queue-v21.json";
import { makePath, type RoadGraph } from "../../src/sim/roads.ts";
import { createInitialState, makeFoot, type AgentState, type SimState } from "../../src/sim/index.ts";
import { agentVelocity, resolveVehicleContacts } from "../../src/sim/impacts.ts";
import { hullContact, sweepHulls, type VehicleHull } from "../../src/sim/vehicle-contacts.ts";
import { signalAspect, type TrafficSignalControls } from "../../src/sim/traffic-signals.ts";
import { emptyWorld } from "./fixtures.ts";

// Actual saved Marina queue, seed606/wave4/tick9000. The lead's straight exit
// proposal crossed the adjacent waiting nose despite positive starting clearance.
const lead: VehicleHull = { key: "a:1375", x: -3858.8589081995988, y: 3.4702656766799667,
  z: -1179.4273793379773, heading: -2.810496576887092, hl: 2.5, hw: 1, height: 1.6 };
const nose: VehicleHull = { key: "a:536", x: -3862.5471642867337, y: 3.4309316454436103,
  z: -1175.65447986874, heading: .5973477069949621, hl: 2.5, hw: 1, height: 1.6 };
const proposed = { ...lead, x: -3858.9175877920875, y: 3.4693374722169636, z: -1179.2566750689193 };
const path = makePath([lead.x, proposed.x], [lead.z, proposed.z]);
const taxi = (id: number, pose: VehicleHull): AgentState => ({ id, kind: "robotaxi", x: pose.x, y: pose.y, z: pose.z,
  heading: pose.heading, pitch: 0, speed: id === 1375 ? 10.830497282091528 : 0, vmax: 12,
  edge: id === 1375 ? "c5572101" : "c10969000", dir: 1, lane: id === 1375 ? 1 : 0,
  s: id === 1375 ? 2.76771715222674 : 107.59758291324269, next: "later", ndir: 1, nlane: 0,
  conn: null, node: id === 1375 ? "n26797000" : "", resume: 0, lat: 0, wait: 2913, dwell: 0,
  ghost: 0, mode: "yield", rng: 7, dodge: null });

describe("physical junction hull reservations", () => {
  it("catches the measured adjacent queued nose using the same full 5 m hull as contacts", () => {
    expect(ROBOTAXI_BODY.halfLength).toBe(2.5);
    expect(hullContact(lead, nose).gap).toBeCloseTo(.01898581173533387, 9);
    expect(hullContact(proposed, nose).gap).toBeCloseTo(-.15516207388791692, 9);
    expect(sweepHulls({ before: lead, after: proposed }, { before: nose, after: nose })!.t).toBeCloseTo(.10327895553233477, 8);
    expect(junctionPathHitsHull(path, nose, lead)).toBe(true);
    // The shorter historical planning body missed this exact physical conflict.
    expect(junctionPathHitsHull(path, { ...nose, hl: 2.3 }, { ...lead, hl: 2.3 })).toBe(false);
  });
  it("keeps a truly clear adjacent lane and vertically separate deck available", () => {
    expect(junctionPathHitsHull(path, { ...nose, x: nose.x - 5 }, lead)).toBe(false);
    expect(junctionPathHitsHull(path, { ...nose, y: lead.y + lead.height + .1 }, lead)).toBe(false);
  });
  it.each([20, 21])("rolls back the complete cursor and reports accepted velocity at version%d", version => {
    const world = emptyWorld(), base = createInitialState(world, 3, ["p1"], { x: 100, z: 100, heading: 0 });
    const actor = taxi(1375, lead), waiting = taxi(536, nose);
    const before: SimState = { ...base, version, tick: 9000, ext: { ...base.ext, agents: { nextId: 1376, list: [waiting, actor] } } };
    const attempted = { ...actor, x: proposed.x, y: proposed.y, z: proposed.z, s: 2.9482254402615986, wait: 0, mode: "go" as const };
    const after: SimState = { ...before, tick: 9001, ext: { ...before.ext, agents: { nextId: 1376, list: [waiting, attempted] } } };
    const frozen = JSON.stringify(after), result = resolveVehicleContacts(world, before, after);
    const accepted = result.ext.agents!.list.find(a => a.id === actor.id)!;
    expect(accepted.x).toBe(actor.x); expect(accepted.z).toBe(actor.z); expect(accepted.s).toBe(actor.s);
    expect(accepted.edge).toBe(actor.edge); expect(accepted.node).toBe(actor.node); expect(accepted.conn).toBe(actor.conn);
    expect(accepted.wait).toBe(actor.wait + 1);
    expect(accepted.speed).toBe(version >= 21 ? 0 : attempted.speed);
    expect(JSON.stringify(after)).toBe(frozen);
  });
});

describe("downstream signal ownership of a car-length junction box", () => {
  const controls: TrafficSignalControls = new Map([["far", { node: "far", groupCount: 2, approaches: new Map([["link", 1]]) }]]);
  const start = Array.from({ length: 3840 }, (_, tick) => tick).find(tick => signalAspect(controls, "far", "link", tick) === "green"
    && signalAspect(controls, "far", "link", tick - 1) !== "green")!;
  it("admits a full-body crossing that fits inside the downstream green", () => {
    expect(shortLinkSignalWindow(controls, "far", "link", start, 600)).toBe(true);
  });
  it("holds upstream through red, yellow, and a green too short to finish the crossing", () => {
    expect(shortLinkSignalWindow(controls, "far", "link", start + 1600, 60)).toBe(false);
    expect(shortLinkSignalWindow(controls, "far", "link", start + 1620, 0)).toBe(false);
    expect(shortLinkSignalWindow(controls, "far", "link", start + 1800, 0)).toBe(false);
  });
  it("cannot mistake a later-cycle green endpoint for continuous green ownership", () => {
    expect(shortLinkSignalWindow(controls, "far", "link", start, 3840)).toBe(false);
    expect(shortLinkSignalWindow(controls, "far", "link", start, NaN)).toBe(false);
  });
  it("does not skip a single-axis yellow/all-red gap when both endpoints are green", () => {
    const single: TrafficSignalControls = new Map([["one", { node: "one", groupCount: 1, approaches: new Map([["link", 0]]) }]]);
    const green = Array.from({ length: 1920 }, (_, tick) => tick).find(tick => signalAspect(single, "one", "link", tick) === "green"
      && signalAspect(single, "one", "link", tick - 1) !== "green")!;
    expect(signalAspect(single, "one", "link", green + 26 * 60)).toBe("green");
    expect(signalAspect(single, "one", "link", green + 36 * 60)).toBe("green");
    expect(shortLinkSignalWindow(single, "one", "link", green + 26 * 60, 10 * 60)).toBe(false);
  });
  it("leaves an unsignalled exit to the existing physical and right-of-way guards", () => {
    expect(shortLinkSignalWindow(controls, "uncontrolled", "link", start, 600)).toBe(true);
  });
});

describe("truthful guarded reverse velocity", () => {
  it.each([6, 5.01])("keeps the actual signed motion and refuses a rear obstruction at%dm", rearZ => {
    const world = emptyWorld(), base = createInitialState(world, 3, ["p1"], { x: 100, z: 100, heading: 0 });
    const pose: VehicleHull = { key: "a:10", x: 0, y: 0, z: 0, heading: 0, hl: 2.5, hw: 1, height: 1.6 };
    const reversing = { ...taxi(10, pose), s: 12, speed: -.8 }, rear = { ...taxi(20, { ...pose, key: "a:20", z: rearZ }), speed: 0 };
    const before: SimState = { ...base, version: 21, ext: { ...base.ext, agents: { nextId: 21, list: [reversing, rear] } } };
    const velocity = agentVelocity(reversing);
    expect(velocity.vx).toBeCloseTo(0, 12); expect(velocity.vz).toBeCloseTo(.8, 10);
    const attempted = { ...reversing, z: reversing.z + velocity.vz / 60, s: reversing.s - .8 / 60 };
    const after: SimState = { ...before, tick: 1, ext: { ...before.ext, agents: { nextId: 21, list: [attempted, rear] } } };
    const frozen = JSON.stringify(after), result = resolveVehicleContacts(world, before, after), accepted = result.ext.agents!.list[0]!;
    if (rearZ === 6) {
      expect(accepted.z).toBe(attempted.z); expect(accepted.s).toBe(attempted.s); expect(accepted.speed).toBe(-.8);
      // The same signed velocity used by reverse forecasts points toward the rear car.
      expect(accepted.z + agentVelocity(accepted).vz).toBeGreaterThan(accepted.z);
    } else {
      expect(accepted.z).toBe(reversing.z); expect(accepted.s).toBe(reversing.s); expect(accepted.speed).toBe(0);
    }
    expect(JSON.stringify(after)).toBe(frozen);
    expect(hullContact({ ...pose, z: accepted.z }, { ...pose, key: "rear", z: rearZ }).gap).toBeGreaterThanOrEqual(0);
  });
});

describe("the ordinary queue producer emits signed reverse motion", () => {
  it.each([20, 21])("keeps the measured two-road fixture coherent at SIM%d", version => {
    const world = emptyWorld(), nodes = queueFixture.nodes as unknown as RoadGraph["nodes"], edges = queueFixture.edges as unknown as RoadGraph["edges"];
    world.roads = { nodes, edges, nodeIndex: new Map(nodes.map((node, index) => [node.id, index])),
      edgeIndex: new Map(edges.map((edge, index) => [edge.id, index])), areas: [], areaIndex: new Map() };
    const base = createInitialState(world, 7, ["p1"], { x: -3850, z: -1170, heading: 0 });
    const list = structuredClone(queueFixture.actors) as AgentState[];
    const state: SimState = { ...base, version, ext: { ...base.ext, agents: { nextId: 1376, list } } };
    const frozen = JSON.stringify(state), before = list.find(actor => actor.id === 536)!;
    const result = stepAgents(world, state, 1)!;
    const after = result.ext.list.find(actor => actor.id === before.id)!;
    if (version >= 21) {
      expect(after.s).toBeLessThan(before.s); expect(after.speed).toBe(-.8);
      expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeCloseTo(.8 / 60, 9);
      const velocity = agentVelocity(after);
      expect(velocity.vx * (after.x - before.x) + velocity.vz * (after.z - before.z)).toBeGreaterThan(0);
      const physical = resolveVehicleContacts(world, state, { ...state, tick: 1, rng: result.rng, ext: { ...state.ext, agents: result.ext } });
      expect(physical.ext.agents!.list.find(actor => actor.id === before.id)!.speed).toBe(-.8);
    } else expect(after.speed).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(state)).toBe(frozen);
  });
});

describe("a tight separating turn keeps the physical sweep and legacy budget", () => {
  const a = separatingTurn.a, b = separatingTurn.b;
  it("spends bounded work to prove the captured positive-gap turn without changing the skin", () => {
    expect(hullContact(a.before, b.before).gap).toBeCloseTo(.0014635231770769863, 12);
    expect(hullContact(a.after, b.after).gap).toBeCloseTo(.0024918035457472953, 12);
    const legacy = sweepHulls(a, b)!;
    expect(legacy).not.toBeNull(); expect(legacy.gap).toBeGreaterThan(.001);
    expect(sweepHulls(a, b, 128)).toBeNull();
  });
  it.each([20, 21])("uses the proven motion only at SIM%d while preserving the complete cursor", version => {
    const world = emptyWorld(), base = createInitialState(world, 3, ["p1"], { x: 100, z: 100, heading: 0 });
    const beforeRows = structuredClone(separatingTurn.actors.map(row => row.before)) as AgentState[];
    const afterRows = structuredClone(separatingTurn.actors.map(row => row.after)) as AgentState[];
    const before: SimState = { ...base, version, tick: 9000, ext: { ...base.ext, agents: { nextId: 1360, list: beforeRows } } };
    const after: SimState = { ...before, tick: 9001, ext: { ...before.ext, agents: { nextId: 1360, list: afterRows } } };
    const frozen = JSON.stringify(after), result = resolveVehicleContacts(world, before, after);
    const accepted = result.ext.agents!.list.find(actor => actor.id === 1075)!;
    const expected = (version >= 21 ? afterRows : beforeRows).find(actor => actor.id === accepted.id)!;
    expect(accepted.x).toBe(expected.x); expect(accepted.z).toBe(expected.z); expect(accepted.heading).toBe(expected.heading);
    expect(accepted.s).toBe(expected.s); expect(accepted.conn).toEqual(expected.conn); expect(accepted.node).toBe(expected.node);
    expect(JSON.stringify(after)).toBe(frozen);
  });
});

describe("safe space is yielded before a blocked junction admission", () => {
  function setup(version = 21): { world: ReturnType<typeof emptyWorld>; state: SimState } {
    const world = emptyWorld(), nodes = pendingYield.nodes as unknown as RoadGraph["nodes"], edges = pendingYield.edges as unknown as RoadGraph["edges"];
    world.roads = { nodes, edges, nodeIndex: new Map(nodes.map((node, index) => [node.id, index])),
      edgeIndex: new Map(edges.map((edge, index) => [edge.id, index])), areas: [], areaIndex: new Map() };
    const control = pendingYield.control;
    world.signals = new Map([[control.node, { node: control.node, groupCount: control.groupCount,
      approaches: new Map(control.approaches as [string, number][]) }]]);
    const base = createInitialState(world, 7, ["p1"], { x: -3820, z: -1160, heading: 0 });
    return { world, state: { ...base, version, tick: pendingYield.tick,
      ext: { ...base.ext, agents: { nextId: 2001, list: structuredClone(pendingYield.actors) as AgentState[] } } } };
  }
  it("lets a lawful red queue make room while the contender remains unadmitted", () => {
    const { world, state } = setup(), frozen = JSON.stringify(state);
    const before = state.ext.agents!.list.find(actor => actor.id === 514)!;
    const waiting = state.ext.agents!.list.find(actor => actor.id === 1075)!;
    expect(before.wait).toBe(0);
    const result = stepAgents(world, state, state.tick + 1)!;
    const queue = result.ext.list.find(actor => actor.id === before.id)!;
    const contender = result.ext.list.find(actor => actor.id === waiting.id)!;
    expect(queue.s).toBeLessThan(before.s); expect(queue.speed).toBe(-.8);
    expect(contender.s).toBe(waiting.s); expect(contender.conn).toBeNull(); expect(contender.node).toBe(waiting.node);
    expect(JSON.stringify(state)).toBe(frozen);
  });
  it("retains pedestrian clearance when someone is behind the queued body", () => {
    const { world, state } = setup(), before = state.ext.agents!.list.find(actor => actor.id === 514)!;
    const velocity = agentVelocity({ ...before, speed: 1 });
    state.players.p1 = { ...state.players.p1!, mode: "foot", foot: makeFoot(before.x - velocity.vx * 4, 0, before.z - velocity.vz * 4, 0) };
    const result = stepAgents(world, state, state.tick + 1)!;
    const queue = result.ext.list.find(actor => actor.id === before.id)!;
    expect(queue.s).toBe(before.s); expect(queue.speed).toBe(0);
  });
  it("keeps the rear vehicle margin even when the following queue can also yield", () => {
    const { world, state } = setup(), before = state.ext.agents!.list.find(actor => actor.id === 514)!;
    const velocity = agentVelocity({ ...before, speed: 1 });
    state.ext.agents!.list.push({ ...before, id: 2000, x: before.x - velocity.vx * 5.8, z: before.z - velocity.vz * 5.8, s: before.s - 5.8 });
    const result = stepAgents(world, state, state.tick + 1)!;
    const queue = result.ext.list.find(actor => actor.id === before.id)!;
    expect(queue.s).toBe(before.s); expect(queue.speed).toBe(0);
  });
  it("does not add prospective reverse intent to the SIM20 path", () => {
    const { world, state } = setup(20), result = stepAgents(world, state, state.tick + 1)!;
    expect(result.ext.list.find(actor => actor.id === 514)!.speed).toBeGreaterThanOrEqual(0);
  });
});

