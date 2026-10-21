// World-continuity gate, per PR (docs/qa/world-continuity-gate.md, G): the player's car as drawn
// on three steep streets (Filbert at 31.5%, Twin Peaks Blvd, Kearny on Telegraph Hill). The
// model's pitch must match the sim's (W-19, fixed: a hard assertion) and every wheel's lowest
// point should sit on the drawn road (W-09: the ribbon and the sim's ground disagree; ratcheted).
// And the far skyline is drawn from Twin Peaks (W-20, fixed).
// Cars are placed with the sim's own player.join event (stepFrames), never by editing the state.

import { test } from "@playwright/test";
import { worldExists } from "../helpers.ts";
import { bootWorld, frames, gateWorld, newSharedPage, settle, type FogWindow } from "./fixtures.ts";
import { Measured, judgeMeasured, onStreet } from "./world-gate.ts";
import { PROBE_QUERY, carWheels, probeDown } from "./world-probe.ts";

const SITES: ReadonlyArray<{ name: string; lat: number; lon: number; street: RegExp }> = [
  { name: "Filbert St at 31.5% (Leavenworth-Hyde)", lat: 37.80027, lon: -122.41817, street: /^Filbert St$/ },
  { name: "Twin Peaks Blvd", lat: 37.75495, lon: -122.44774, street: /^Twin Peaks Blvd$/ },
  { name: "Kearny St, Telegraph Hill", lat: 37.80469, lon: -122.40622, street: /^Kearny St$/ },
];

test.describe("world gate: the car's pose on steep streets", () => {
  test.skip(!worldExists("sf"), "public/tiles/sf is absent");

  test("the car is drawn at the sim's pitch, with its wheels on the drawn road", async ({ browser }, info) => {
    gateWorld("sf");
    test.setTimeout(900_000);
    const page = await newSharedPage(browser, info.project.use);
    await bootWorld(page, "sf", PROBE_QUERY, 180_000);
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
    const m = new Measured("car-pose", "e2e");
    let pitchErr = 0;
    let gap = 0;
    const per: Record<string, unknown> = {};
    for (const [i, s] of SITES.entries()) {
      const p = onStreet(s.lat, s.lon, s.street);
      const id = `probe${i}`;
      const tick = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().tick);
      await page.evaluate(
        ({ id, x, z, heading, tick }) => {
          const h = (window as unknown as FogWindow).__fogcity!;
          h.stepFrames!([{}], [{ tick: tick + 1, kind: "player.join", playerId: id, payload: { x, z, heading } }]);
          h.stepFrames!(Array.from({ length: 30 }, () => ({})));
        },
        { id, x: p.x, z: p.z, heading: p.heading, tick },
      );
      const car = await page.evaluate((id) => (window as unknown as FogWindow).__fogcity!.state().players[id]!.car, id);
      // A camera behind and above the car, so its tile streams in, then settle and draw.
      const yawDeg = (car.heading * 180) / Math.PI;
      await page.evaluate(
        ({ x, y, z, yawDeg }) => (window as unknown as FogWindow).__fogcity!.flyTo!(x, y, z, yawDeg, -20),
        { x: car.x - Math.sin(car.heading) * 14, y: car.y + 7, z: car.z + Math.cos(car.heading) * 14, yawDeg },
      );
      await settle(page, 240_000);
      await frames(page, 4);
      const pose = await carWheels(page, id);
      if (!pose) throw new Error(`${s.name}: the renderer drew no car for ${id}`);
      const err = (Math.abs(pose.modelPitch - car.pitch) * 180) / Math.PI;
      const roads = await probeDown(page, pose.wheels.map((w) => [w.x, w.z] as [number, number]), "roads");
      const grounds = await probeDown(page, pose.wheels.map((w) => [w.x, w.z] as [number, number]), "ground");
      // A wheel over neither a road ribbon nor the ground (a tile missing under the car) is an
      // infinite gap: the metric then fails as not finite, never passes as 0.
      const gaps = pose.wheels.map((w, k) => {
        const top = roads[k]?.y ?? grounds[k]?.y;
        return top === undefined ? Infinity : Math.abs(w.bottom - top);
      });
      pitchErr = Math.max(pitchErr, err);
      gap = Math.max(gap, ...gaps);
      per[s.name] = { simPitchDeg: (car.pitch * 180) / Math.PI, pitchErrDeg: err, wheelGapsM: gaps.map((g) => (Number.isFinite(g) ? Math.round(g * 100) / 100 : "nothing drawn under the wheel")), onRoad: roads.map((r) => r !== null) };
    }
    // The far skyline (W-20, fixed): from Twin Peaks looking north-east, far cells are loaded and drawn.
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.flyTo!(-4672, 300, 4540, 45, -5));
    await settle(page, 240_000);
    await frames(page, 4);
    const far = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo!());
    m.metric({ id: "G.far.cellsDrawnFromTwinPeaks", target: 4, better: "higher", unit: "far cells", defects: ["W-20"], desc: "from Twin Peaks looking north-east: far-LOD cells drawn in the last frame (the skyline beyond the streamed tiles)" }, far.farCellsDrawn ?? 0, { loaded: far.farCells, total: far.farCellsTotal, cameraFar: far.cameraFar });
    m.metric({ id: "G.carPose.pitchErrorDeg", target: 1, better: "lower", unit: "deg", defects: ["W-19"], desc: "on Filbert, Twin Peaks Blvd and Kearny: the drawn car's pitch against the sim's" }, Math.round(pitchErr * 1000) / 1000, per);
    m.metric({ id: "G.carPose.wheelGapM", target: 0.1, better: "lower", unit: "m", defects: ["W-09"], desc: "on the same streets: the largest gap between a wheel's lowest point and the drawn road under it (the car sinks into the ribbon)" }, Math.round(gap * 100) / 100, per);
    judgeMeasured(m);
    await page.context().close();
  });
});
