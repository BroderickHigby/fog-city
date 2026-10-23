// Vendor prices: two tank tiers, one flow tier and burritos for runway at the FiDi desk, in line
// with docs/design.md's economy, and the purchase rule the sim applies.
import { describe, expect, it } from "vitest";
import { VENDOR, buy, checkVendor, particlesPerSecond, vendorItem, type Loadout } from "../../src/content/vendor.ts";

const start: Loadout = { cashCents: VENDOR.base.startCashCents, runwayMonths: 18, tankL: VENDOR.base.tankL, flowLps: VENDOR.base.flowLps, owned: [] };

describe("content/vendor.json", () => {
  it("is consistent", () => expect(checkVendor()).toEqual([]));

  it("matches the design: 8 L and 0.8 L/s (10 particles/s) to start, $2,000 cash, 18 months of runway", () => {
    expect(VENDOR.base).toMatchObject({ tankL: 8, flowLps: 0.8, runwayMaxMonths: 18, startCashCents: 200000 });
    expect(particlesPerSecond(0.8)).toBeCloseTo(10, 9);
    expect(VENDOR.limits).toMatchObject({ tankMaxL: 16, flowMaxLps: 1.2 });
  });

  it("the wave-2 desk vendor sells 2 tank tiers, 1 flow tier and burritos", () => {
    const desk = VENDOR.vendors.find((v) => v.id === "fidi-desk")!;
    const w2 = desk.items.map((id) => vendorItem(id)).filter((i) => i.wave <= 2);
    expect(w2.filter((i) => i.kind === "tank").length).toBe(2);
    expect(w2.filter((i) => i.kind === "flow").length).toBe(1);
    expect(w2.map((i) => i.id)).toContain("burrito");
  });

  it("a burrito is $12 for +2 months, a pour-over $7.50 for +0.5 (wave 3)", () => {
    expect(vendorItem("burrito")).toMatchObject({ priceCents: 1200, effect: { runwayMonths: 2 } });
    expect(vendorItem("pour-over")).toMatchObject({ priceCents: 750, effect: { runwayMonths: 0.5 }, wave: 3 });
  });
});

describe("buying", () => {
  it("tank tier 1 changes the tank and costs the listed price (the wave-2 acceptance test)", () => {
    const after = buy(start, "tank-1", 2) as Loadout;
    expect(after.tankL).toBe(12);
    expect(after.cashCents).toBe(start.cashCents - vendorItem("tank-1").priceCents);
  });

  it("uses the same 12/16 L tank tiers and 1.2 L/s flow as combat", () => {
    expect(vendorItem("tank-1").effect.tankL).toBe(12);
    expect(vendorItem("tank-2").effect.tankL).toBe(16);
    expect(vendorItem("flow-1").effect.flowLps).toBe(1.2);
  });

  it("a burrito restores the listed runway, never above 18 months", () => {
    expect((buy({ ...start, runwayMonths: 10 }, "burrito", 2) as Loadout).runwayMonths).toBe(12);
    expect((buy({ ...start, runwayMonths: 17 }, "burrito", 2) as Loadout).runwayMonths).toBe(18);
  });

  it("refuses without the cash, out of order, twice, or before its wave", () => {
    expect(buy({ ...start, cashCents: 100 }, "tank-1", 2)).toEqual({ refused: "cash" });
    expect(buy(start, "tank-2", 2)).toEqual({ refused: "needs tank-1" });
    const t1 = buy(start, "tank-1", 2) as Loadout;
    expect(buy(t1, "tank-1", 2)).toEqual({ refused: "owned" });
    expect(buy(start, "pour-over", 2)).toEqual({ refused: "not yet" });
  });

  it("the starting cash buys the first tank, and two standard bounties more buy the second", () => {
    const t1 = buy(start, "tank-1", 2) as Loadout;
    const paid = { ...t1, cashCents: t1.cashCents + 2 * 15000 };
    expect("refused" in (buy(paid, "tank-2", 2) as object)).toBe(false);
  });
});
