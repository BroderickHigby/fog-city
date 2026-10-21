// World-continuity gate, nightly (docs/qa/world-continuity-gate.md, G; W-17): the streaming ring
// at radius 60, so near tiles end a few metres from the camera and the far layer carries on.
// At the three worst borders (the Presidio t-16_-1/t-15_-1, the Lakeshore bluffs t-20_17/t-20_18,
// west of Twin Peaks t-9_13/t-8_13), seen from each side in turn: the camera stands 75 m inside
// one tile, so that tile is streamed and its neighbour across the border is drawn by the far
// layer. Every 5 m along the border, wherever the sim's ground is land (above 0.5 m):
//   - straight-down probes 2 m into each side, which must find a drawn surface, not the sea;
//   - a ray from the streamed side, 20 degrees down, aimed 3 m past the border at the near
//     ground's height: where the far terrain stands above the near ground the ray passes under
//     its edge and finds the sea plane (or nothing), the crack a player sees at the ring.

import { test, type Page } from "@playwright/test";
import { groundHeight } from "../../src/sim/index.ts";
import { loadWorld, worldExists } from "../helpers.ts";
import { bootWorld, frames, gateWorld, newSharedPage, settle, type FogWindow } from "./fixtures.ts";
import { Measured, judgeMeasured } from "./world-gate.ts";
import { PROBE_QUERY, probeDown, probeRay } from "./world-probe.ts";

/** A border: the shared edge between two tiles (x = const when `vertical`), its span, and the two tiles (lower x or z first). */
const BORDERS: ReadonlyArray<{ name: string; vertical: boolean; at: number; from: number; to: number; tiles: [string, string] }> = [
  { name: "Presidio t-16_-1 / t-15_-1", vertical: true, at: -7500, from: -500, to: 0, tiles: ["t-16_-1", "t-15_-1"] },
  { name: "Lakeshore bluffs t-20_17 / t-20_18", vertical: false, at: 9000, from: -10000, to: -9500, tiles: ["t-20_17", "t-20_18"] },
  { name: "West of Twin Peaks t-9_13 / t-8_13", vertical: true, at: -4000, from: 6500, to: 7000, tiles: ["t-9_13", "t-8_13"] },
];
const INSIDE_M = 75;
const PAST_M = 3;
const RAY_BACK_M = 35;
const RAY_DOWN = (20 * Math.PI) / 180;

async function tilesInScene(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type O = { name: string; traverse(fn: (o: O) => void): void };
    const out: string[] = [];
    (window as unknown as { __fogcityView: { scene: O } }).__fogcityView.scene.traverse((o) => {
      if (o.name.startsWith("tile:")) out.push(o.name.slice(5));
    });
    return out;
  });
}

test.describe("world gate: the near/far ring at radius 60", () => {
  test.skip(!worldExists("sf"), "public/tiles/sf is absent");

  test("no probe or ray at the worst borders finds the sea plane", async ({ browser }, info) => {
    gateWorld("sf");
    test.setTimeout(1_800_000);
    const { world } = loadWorld("sf");
    const land = (x: number, z: number): boolean => groundHeight(world, x, z) > 0.5;
    const page = await newSharedPage(browser, info.project.use);
    await bootWorld(page, "sf", `${PROBE_QUERY}&radius=60`, 240_000);
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
    const fly = async (x: number, z: number, yawDeg: number): Promise<void> => {
      await page.evaluate(({ x, z, yawDeg }) => (window as unknown as FogWindow).__fogcity!.flyTo!(x, 330, z, yawDeg, -60), { x, z, yawDeg });
      await settle(page, 300_000);
      await frames(page, 3);
    };
    let sea = 0;
    let downProbes = 0;
    let rays = 0;
    const where: string[] = [];
    for (const b of BORDERS) {
      for (const side of [-1, 1] as const) {
        // The streamed tile is on `side` of the border; the far layer draws the other one.
        const near = b.tiles[side < 0 ? 0 : 1];
        const far = b.tiles[side < 0 ? 1 : 0];
        const mid = (b.from + b.to) / 2;
        // Away first (beyond the streamer's hysteresis), so the other side's tile is dropped.
        await fly(b.vertical ? b.at + 3000 : mid, b.vertical ? mid : b.at + 3000, 0);
        const cx = b.vertical ? b.at + side * INSIDE_M : mid;
        const cz = b.vertical ? mid : b.at + side * INSIDE_M;
        const out = side < 0 ? 1 : -1; // from the streamed side towards the border, along x or z
        await fly(cx, cz, b.vertical ? (out > 0 ? 90 : 270) : out > 0 ? 180 : 0);
        const inScene = await tilesInScene(page);
        if (!inScene.includes(near) || inScene.includes(far)) throw new Error(`${b.name}: expected ${near} streamed and ${far} not, got ${inScene.join(", ")}`);
        const pts: Array<[number, number]> = [];
        const rayList: Array<[number, number, number, number, number, number]> = [];
        for (let s = b.from + 2.5; s < b.to; s += 5) {
          const at = (d: number): [number, number] => (b.vertical ? [b.at + out * d, s] : [s, b.at + out * d]);
          for (const d of [-2, 2]) {
            const p = at(d);
            if (land(p[0], p[1])) pts.push(p);
          }
          const nearPt = at(-0.5);
          const target = at(PAST_M);
          if (!land(nearPt[0], nearPt[1]) || !land(target[0], target[1])) continue;
          const y = groundHeight(world, nearPt[0], nearPt[1]);
          const hx = b.vertical ? out : 0;
          const hz = b.vertical ? 0 : out;
          const dx = hx * Math.cos(RAY_DOWN);
          const dz = hz * Math.cos(RAY_DOWN);
          const dy = -Math.sin(RAY_DOWN);
          rayList.push([target[0] - dx * RAY_BACK_M, y - dy * RAY_BACK_M, target[1] - dz * RAY_BACK_M, dx, dy, dz]);
        }
        const only = ["tile:", "far:", "bay"];
        const downs = await probeDown(page, pts, only);
        const hits = await probeRay(page, rayList, only);
        const nDown = downs.filter((h) => !h || h.mesh === "bay").length;
        const nRay = hits.filter((h) => !h || h.mesh === "bay").length;
        downProbes += downs.length;
        rays += hits.length;
        sea += nDown + nRay;
        if (nDown || nRay) where.push(`${b.name}, streamed ${near}: ${nDown} of ${downs.length} straight down, ${nRay} of ${hits.length} rays`);
      }
    }
    const m = new Measured("far-ring", "e2e-nightly");
    m.metric(
      { id: "G.farRing.seaThroughProbes", target: 0, better: "lower", unit: "probes", defects: ["W-17"], desc: "at radius 60, at the three worst near/far borders seen from each side: straight-down probes 2 m either side and 20-degree rays from the streamed side, over sim land every 5 m, that find the sea plane or nothing" },
      sea,
      { downProbes, rays, where },
    );
    judgeMeasured(m);
    await page.context().close();
  });
});
