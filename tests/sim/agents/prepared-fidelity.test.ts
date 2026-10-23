import { describe, expect, it } from "vitest";
import { activeSpawnSquares, planFidelity, prepareFidelityAnchors, type FidelityAnchor } from "../../../src/sim/agents/fidelity.ts";

describe("prepared fidelity anchors", () => {
  it("matches ordinary validation and every decision across positions, phases and anchor order", () => {
    const anchors: FidelityAnchor[] = Array.from({ length: 24 }, (_, i) => ({ id: `p${23 - i}`, x: (i % 6) * 200 - 500,
      z: Math.floor(i / 6) * 200 - 300, ...(i % 3 === 0 ? { radiusM: 40 + i } : {}) }));
    const prepared = prepareFidelityAnchors(anchors);
    for (const tick of [0, 1, 3, 59, 60, 4096]) for (const x of [-1000, -500, 0, 500, 1000]) {
      for (const significant of [false, true]) {
        const actor = { id: `actor:${x}`, x, z: x / 2, significant, phaseTicks: 17 };
        expect(planFidelity(actor, prepared, tick)).toEqual(planFidelity(actor, anchors, tick));
      }
    }
    expect(activeSpawnSquares(prepared)).toEqual(activeSpawnSquares(anchors));
    expect(prepareFidelityAnchors(prepared)).toBe(prepared);
  });

  it("owns an immutable snapshot and never caches mutable caller arrays", () => {
    const source = [{ id: "p", x: 0, z: 0 }];
    const prepared = prepareFidelityAnchors(source);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared[0])).toBe(true);
    expect(prepared[0]).not.toBe(source[0]);
    source[0]!.x = 1000;
    const actor = { id: "a", x: 0, z: 0, significant: false };
    expect(planFidelity(actor, prepared, 0).tier).toBe("full");
    expect(planFidelity(actor, source, 0).tier).toBe("despawn");
    source[0]!.x = NaN;
    expect(() => planFidelity(actor, source, 0)).toThrow("anchor");
    expect(() => prepareFidelityAnchors(source)).toThrow("anchor");
  });

  it("retains duplicate, capacity, finite-coordinate and per-agent validation", () => {
    const anchor = { id: "p", x: 0, z: 0 };
    expect(() => prepareFidelityAnchors([anchor, anchor])).toThrow("anchor");
    expect(() => prepareFidelityAnchors(Array.from({ length: 25 }, (_, i) => ({ ...anchor, id: String(i) })))).toThrow("capacity");
    expect(() => prepareFidelityAnchors([{ ...anchor, radiusM: Infinity }])).toThrow("anchor");
    const prepared = prepareFidelityAnchors([anchor]);
    expect(() => planFidelity({ id: "a", x: NaN, z: 0, significant: false }, prepared, 0)).toThrow("position");
    expect(() => planFidelity({ id: "a", x: 0, z: 0, significant: false }, prepared, -1)).toThrow("tick");
  });
});
