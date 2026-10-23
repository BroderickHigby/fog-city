import { describe, expect, it } from "vitest";
import { buildSidewalkGraph, shortestSidewalkRoute } from "../../../src/sim/agents/navigation.ts";
import {
  activeSpawnSquares, advanceAbstractAgent, handoffFidelityPopulation, MAX_SIGNIFICANT_AGENTS,
  planFidelity, promoteAmbientAgent, seedAmbientAgent,
} from "../../../src/sim/agents/fidelity.ts";
import type { AmbientPlacement, FidelityAgent, FidelityPopulation } from "../../../src/sim/agents/fidelity.ts";

const graph = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 5 }, { id: "b", x: 100, z: 5 }, { id: "c", x: 100, z: 105 }],
  edges: [{ id: "ab", a: "a", b: "b", kind: "sidewalk", points: [[0, 5], [100, 5]] },
    { id: "bc", a: "b", b: "c", kind: "sidewalk", points: [[100, 5], [100, 105]] }] });
const route = shortestSidewalkRoute(graph, "a", "c")!;
const placement: AmbientPlacement = { squareKey: "0,0", slot: 0, x: 10, z: 5,
  route, cursor: { stepIndex: 0, distanceM: 10 }, speedMps: 2 };
const square = { key: "0,0", sx: 0, sz: 0, timeBucket: 0 };
const anchor = { id: "player", x: 0, z: 0 };
const empty: FidelityPopulation = { agents: [], squares: [] };
const agent = (): FidelityAgent => seedAmbientAgent(square, placement, 42, 0);

describe("fidelity policy", () => {
  it("uses inclusive sim anchor distances and a deterministic reduced cadence", () => {
    const a = { ...agent(), x: 150, z: 0 };
    expect(planFidelity(a, [anchor], 0)).toMatchObject({ tier: "full", run: true, cadenceTicks: 1 });
    expect(planFidelity({ ...a, x: 150.001 }, [anchor], 0).tier).toBe("active");
    const distant = { ...a, x: 300 };
    expect(planFidelity(distant, [anchor], 0).tier).toBe("active");
    expect([0, 1, 2, 3].filter((tick) => planFidelity(distant, [anchor], tick).run)).toHaveLength(1);
    expect(planFidelity({ ...a, x: 300.001 }, [anchor], 0).tier).toBe("despawn");
    expect(planFidelity({ ...a, significant: true, x: 300.001 }, [anchor], 0))
      .toMatchObject({ tier: "abstract", cadenceTicks: 60, allowCombat: false, allowConversion: false });
  });

  it("honors a temporary sim anchor radius and has no rendering input", () => {
    const a = { ...agent(), x: 120, z: 0 };
    const viewer = { id: "viewer", x: 0, z: 0, radiusM: 120 };
    expect(planFidelity(a, [viewer], 4).tier).toBe("full");
    expect(planFidelity({ ...a, x: 120.001 }, [viewer], 4).tier).toBe("despawn");
    const withRendererData = Object.assign({}, anchor, { cameraX: 50000, cameraZ: 50000 });
    expect(planFidelity(a, [withRendererData], 4)).toEqual(planFidelity(a, [anchor], 4));
  });

  it("unions overlapping anchor squares deterministically including negative-coordinate seams", () => {
    const anchors = [anchor, { id: "bot", x: -1, z: -1 }];
    const squares = activeSpawnSquares(anchors);
    expect(activeSpawnSquares([...anchors].reverse())).toEqual(squares);
    expect(squares.filter((value) => value.key === "-1,-1")).toHaveLength(1);
    expect(squares.filter((value) => value.key === "0,0")).toHaveLength(1);
    expect(activeSpawnSquares([])).toEqual([]);
  });

  it("seeds identities, RNG and phase from square, world seed, time bucket and slot", () => {
    expect(agent()).toEqual(agent());
    const original = agent();
    expect(seedAmbientAgent({ ...square, timeBucket: 1 }, placement, 42, 0).id).not.toBe(original.id);
    expect(seedAmbientAgent(square, placement, 43, 0).rng).not.toEqual(original.rng);
    expect(seedAmbientAgent(square, { ...placement, slot: 1 }, 42, 0).id).not.toBe(original.id);
    expect(original.phaseTicks).toBeGreaterThanOrEqual(0);
    expect(original.phaseTicks).toBeLessThan(60);
  });

  it("keeps identity and route state at anchor seams and time bucket boundaries", () => {
    const first = handoffFidelityPopulation(empty, [anchor], 1799, 42, [placement]);
    const movedAgent = { ...first.population.agents[0]!, x: 12, cursor: { stepIndex: 0, distanceM: 12 } };
    const previous = { ...first.population, agents: [movedAgent] };
    const next = handoffFidelityPopulation(previous, [{ ...anchor, x: 101 }], 1801, 42, [placement]);
    expect(next.population.agents).toEqual([movedAgent]);
    expect(next.spawnedIds).toEqual([]);
    expect(next.despawnedIds).toEqual([]);
    expect(next.population.squares.find((value) => value.key === "0,0")!.timeBucket).toBe(0);
    expect(previous.agents[0]!.cursor.distanceM).toBe(12);
  });

  it("promotes without changing route, RNG or identity and survives leaving all anchors", () => {
    const original = agent();
    const before = JSON.stringify(original);
    const promoted = promoteAmbientAgent({ agents: [original], squares: [square] }, original.id, "scanned");
    expect(promoted.status).toBe("promoted");
    expect(promoted.population.agents[0]).toEqual({ ...original, significant: true, promotionReason: "scanned" });
    const outside = handoffFidelityPopulation(promoted.population, [], 9000, 42, []);
    expect(outside.population.agents).toEqual(promoted.population.agents);
    expect(outside.population.squares).toEqual([]);
    expect(JSON.stringify(original)).toBe(before);
    expect(handoffFidelityPopulation({ agents: [original], squares: [square] }, [], 9000, 42, [])
      .despawnedIds).toEqual([original.id]);
  });

  it("retains an ambient agent inside an anchor after its birth square leaves all radii", () => {
    const longGraph = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 5 }, { id: "b", x: 600, z: 5 }],
      edges: [{ id: "long", a: "a", b: "b", kind: "sidewalk", points: [[0, 5], [600, 5]] }] });
    const longRoute = shortestSidewalkRoute(longGraph, "a", "b")!;
    const arrived = { ...agent(), x: 510, route: longRoute, cursor: { stepIndex: 0, distanceM: 510 } };
    const next = handoffFidelityPopulation({ agents: [arrived], squares: [square] }, [{ ...anchor, x: 510 }], 3600, 42, []);
    expect(next.population.agents).toEqual([arrived]);
    expect(next.population.squares.some((value) => value.key === "0,0")).toBe(false);
    expect(next.despawnedIds).toEqual([]);
  });

  it("follows graph corners abstractly and catches up identically after different update cadences", () => {
    const promoted = { ...agent(), significant: true };
    const once = advanceAbstractAgent(graph, promoted, 3600);
    const twice = advanceAbstractAgent(graph, advanceAbstractAgent(graph, promoted, 600), 3600);
    expect(once).toEqual(twice);
    expect(once).toMatchObject({ x: 100, z: 35, cursor: { stepIndex: 1, distanceM: 30 } });
    expect(once.rng).toEqual(promoted.rng);
    expect(planFidelity(once, [], 3600)).toMatchObject({ allowCombat: false, allowConversion: false });
    expect(() => advanceAbstractAgent(graph, agent(), 1)).toThrow("Invalid abstract advance");
  });

  it("applies stable per-anchor population caps regardless of input order", () => {
    const placements = Array.from({ length: 100 }, (_, slot) => ({ ...placement, slot }));
    const anchors = [anchor, { id: "other", x: 1, z: 0 }];
    const a = handoffFidelityPopulation(empty, anchors, 0, 42, placements);
    const b = handoffFidelityPopulation(empty, [...anchors].reverse(), 0, 42, [...placements].reverse());
    expect(a).toEqual(b);
    expect(a.population.agents).toHaveLength(60);
    expect(new Set(a.population.agents.map((value) => value.id)).size).toBe(60);
  });

  it("caps total ambient population across 24 separate anchors", () => {
    const farGraph = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 5 }, { id: "b", x: 24000, z: 5 }],
      edges: [{ id: "long", a: "a", b: "b", kind: "sidewalk", points: [[0, 5], [24000, 5]] }] });
    const farRoute = shortestSidewalkRoute(farGraph, "a", "b")!;
    const anchors = Array.from({ length: 24 }, (_, i) => ({ id: `anchor:${i}`, x: i * 1000, z: 0 }));
    const placements = anchors.flatMap((value) => Array.from({ length: 60 }, (_, slot) => ({
      ...placement, squareKey: `${Math.floor(value.x / 100)},0`, slot, x: value.x + 10,
      route: farRoute, cursor: { stepIndex: 0, distanceM: value.x + 10 },
    })));
    const result = handoffFidelityPopulation(empty, anchors, 0, 42, placements);
    expect(result.population.agents).toHaveLength(800);
    for (const value of anchors) {
      expect(result.population.agents.filter((actor) => Math.abs(actor.x - value.x) <= 300).length).toBeLessThanOrEqual(60);
    }
  });

  it("bounds persistent significance without silently dropping existing actors", () => {
    const target = agent();
    const significant = Array.from({ length: MAX_SIGNIFICANT_AGENTS }, (_, id) => ({ ...target, id: `persistent:${id}`, significant: true }));
    const population = { agents: [...significant, target], squares: [square] };
    expect(promoteAmbientAgent(population, target.id, "wet")).toEqual({ population, status: "capacity" });
    expect(handoffFidelityPopulation(population, [], 10, 42, []).population.agents).toHaveLength(MAX_SIGNIFICANT_AGENTS);
    expect(() => activeSpawnSquares(Array.from({ length: 25 }, (_, id) => ({ ...anchor, id: String(id) })))).toThrow("capacity");
  });

  it("rejects non-finite or fractional time and seed inputs at public boundaries", () => {
    for (const tick of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => seedAmbientAgent(square, placement, 42, tick)).toThrow("tick");
      expect(() => planFidelity(agent(), [anchor], tick)).toThrow("tick");
      expect(() => handoffFidelityPopulation(empty, [anchor], tick, 42, [])).toThrow("tick");
    }
    for (const worldSeed of [NaN, Infinity, 0.5, 4294967296]) {
      expect(() => seedAmbientAgent(square, placement, worldSeed, 0)).toThrow("seed");
      expect(() => handoffFidelityPopulation(empty, [anchor], 0, worldSeed, [])).toThrow("seed");
    }
    expect(seedAmbientAgent(square, placement, -1, 0).id).toContain("-1");
    for (const timeBucket of [NaN, Infinity, -1, 0.5]) {
      expect(() => seedAmbientAgent({ ...square, timeBucket }, placement, 42, 0)).toThrow("epoch");
      expect(() => handoffFidelityPopulation({ agents: [], squares: [{ ...square, timeBucket }] }, [anchor], 0, 42, []))
        .toThrow("epoch");
    }
  });

  it("rejects invalid positions including persisted significant actors", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() => planFidelity({ ...agent(), x: invalid }, [anchor], 0)).toThrow("position");
      expect(() => handoffFidelityPopulation({ agents: [{ ...agent(), significant: true, z: invalid }], squares: [] }, [], 0, 42, []))
        .toThrow("position");
      expect(() => activeSpawnSquares([{ ...anchor, x: invalid }])).toThrow("anchor");
    }
    expect(() => activeSpawnSquares([{ ...anchor, x: Number.MAX_VALUE }])).toThrow("square range");
  });
});
