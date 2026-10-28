import { describe, expect, it } from "vitest";
import { areaBudget, MAX_AGENTS, MAX_AGENTS_TOTAL, populate } from "../../../src/sim/agents.ts";
import { areaOf } from "../../../src/sim/roads.ts";
import { seedRng } from "../../../src/sim/rng.ts";
import { gridCity } from "../fixtures.ts";
const world = gridCity(), bodies = [{ x: 1000, z: 1000 }];
const interest = { x: 150, z: 150, radiusM: 120, owner: 0 };
const empty = { nextId: 1, list: [] };
const run = (anchors: typeof interest[]) => populate(world, empty, seedRng(7), bodies, 17, true, [], [], anchors);
describe("Coit ambient population interest", () => {
  it("uses ordinary seeded population around the lens without inventing a player body", () => {
    expect(run([]).ext.list).toHaveLength(0);
    const before = JSON.stringify(bodies), result = run([interest]);
    expect(result.ext.list.length).toBeGreaterThan(0);
    expect(result.ext.list.every(a => Math.hypot(a.x - interest.x, a.z - interest.z) <= interest.radiusM)).toBe(true);
    expect(JSON.stringify(bodies)).toBe(before);
    expect(result).toEqual(run([interest]));
    expect(result.ext.list.length).toBeLessThanOrEqual(MAX_AGENTS);
    expect(result.ext.list.length).toBeLessThanOrEqual(MAX_AGENTS_TOTAL);
  });
  it("unions duplicate observation areas without multiplying per-area budgets", () => {
    const result = run([interest]);
    expect(run([interest, interest])).toEqual(result);
    const counts = new Map<string, number>();
    for (const actor of result.ext.list) {
      const area = areaOf(actor.x, actor.z).key, key = `${area}:${actor.kind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      expect(counts.get(key)).toBeLessThanOrEqual(areaBudget(world, 17, area)[actor.kind]);
    }
  });
});
