// World-continuity gate, nightly (docs/qa/world-continuity-gate.md, G; W-17): the streaming ring
// at radius 60, so near tiles end a few metres from the camera and the far layer carries on.
// Beside the three worst borders (the Presidio t-16_-1/t-15_-1, the Lakeshore bluffs
// t-20_17/t-20_18, west of Twin Peaks t-9_13/t-8_13), straight-down probes every 5 m along the
// border, 2 m into each side: none may find the sea plane through a crack between the layers.

import { test } from "@playwright/test";
import { worldExists } from "../helpers.ts";
import { bootWorld, frames, gateWorld, newSharedPage, settle, type FogWindow } from "./fixtures.ts";
import { Measured, judgeMeasured } from "./world-gate.ts";
import { PROBE_QUERY, probeDown } from "./world-probe.ts";

/** A border: the shared edge between two tiles (x = const when `vertical`), its span, and the camera point. */
const BORDERS: ReadonlyArray<{ name: string; vertical: boolean; at: number; from: number; to: number }> = [
  { name: "Presidio t-16_-1 / t-15_-1", vertical: true, at: -7500, from: -500, to: 0 },
  { name: "Lakeshore bluffs t-20_17 / t-20_18", vertical: false, at: 9000, from: -10000, to: -9500 },
  { name: "West of Twin Peaks t-9_13 / t-8_13", vertical: true, at: -4000, from: 6500, to: 7000 },
];

test.describe("world gate: the near/far ring at radius 60", () => {
  test.skip(!worldExists("sf"), "public/tiles/sf is absent");

  test("no probe beside the worst borders reaches the sea plane", async ({ browser }, info) => {
    gateWorld("sf");
    test.setTimeout(1_800_000);
    const page = await newSharedPage(browser, info.project.use);
    await bootWorld(page, "sf", `${PROBE_QUERY}&radius=60`, 240_000);
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
    let sea = 0;
    let probes = 0;
    const where: string[] = [];
    for (const b of BORDERS) {
      const mid = (b.from + b.to) / 2;
      const cx = b.vertical ? b.at - 30 : mid;
      const cz = b.vertical ? mid : b.at - 30;
      await page.evaluate(({ x, z }) => (window as unknown as FogWindow).__fogcity!.flyTo!(x, 330, z, 90, -60), { x: cx, z: cz });
      await settle(page, 300_000);
      await frames(page, 3);
      const pts: Array<[number, number]> = [];
      for (let s = b.from + 2.5; s < b.to; s += 5) {
        for (const side of [-2, 2]) pts.push(b.vertical ? [b.at + side, s] : [s, b.at + side]);
      }
      const hits = await probeDown(page, pts, ["tile:", "far:", "bay"]);
      probes += hits.length;
      const n = hits.filter((h) => !h || h.mesh === "bay").length;
      sea += n;
      if (n) where.push(`${b.name}: ${n} of ${hits.length}`);
    }
    const m = new Measured("far-ring", "e2e-nightly");
    m.metric({ id: "G.farRing.seaThroughProbes", target: 0, better: "lower", unit: "probes", defects: ["W-17"], desc: "at radius 60 beside the three worst near/far borders, straight-down probes (every 5 m, 2 m either side) that find the sea plane or nothing" }, sea, { probes, where });
    judgeMeasured(m);
    await page.context().close();
  });
});
