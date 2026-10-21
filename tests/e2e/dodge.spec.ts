// The dodge in the running game on the real city (?world=sf; the owner's Crazy Taxi rule): the
// player floors it along the Embarcadero from the spawn and, once past 20 m/s, steers straight
// at the first person ahead (within 70 m, inside 20 degrees of the nose) and keeps steering at
// them, never braking. They must dive (their agent in mode "dive" with a dodge state), the car
// must never touch them or anyone (ext.dodge.contacts and the car's personBumps stay 0) and keep
// at least 0.75 m from them, and the renderer must draw the dive (renderInfo().agentsDodging).
// The game is paused and stepped through stepFrames, so the run is the same sim run Node gets.
//
// DODGE_SHOTS=<dir> also saves a dive sequence there (six frames from a fly camera 12 m ahead of
// the person and 3.5 m up, between their line and the car's, looking back at them and the car
// coming: the gap between the two reads across the picture), at full size: what the owner looks at.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { worldExists } from "../helpers.ts";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, features, frames, gate, optionalAbsent, renderInfo, settle, type FogWindow } from "./fixtures.ts";

const SF = worldExists("sf");
const ABSENT = "public/tiles/sf/manifest.json is absent: the pipeline has not produced the SF world on this checkout";
const SHOTS = process.env.DODGE_SHOTS ?? "";

interface Drive {
  /** The person aimed at (agent id), -1 if none was found. */
  target: number;
  /** Tick their dive started, -1 if it did not; the car's speed then (m/s). */
  diveTick: number;
  diveSpeed: number;
  /** Least clearance between the car and them (m) while the car moved. */
  minClear: number;
  contacts: number;
  personBumps: number;
  dives: number;
  tick: number;
  /** Where they stood when they dived, the dive's landing, and the car's direction of travel then. */
  at: { x: number; z: number; tx: number; tz: number; ux: number; uz: number } | null;
}

/**
 * Step the paused game `ticks` ticks with the closed-loop driver (state kept on window between
 * calls), stopping early `stopAfterDive` ticks after the target's dive starts. In the page.
 */
async function drive(page: import("@playwright/test").Page, ticks: number, stopAfterDive: number): Promise<Drive> {
  return page.evaluate(
    ({ ticks, stopAfterDive }) => {
      type A = { id: number; kind: string; x: number; z: number; dodge: { tx: number; tz: number } | null };
      const w = window as unknown as FogWindow & { __dodgeRun?: Drive };
      const h = w.__fogcity!;
      const r: Drive = w.__dodgeRun ?? { target: -1, diveTick: -1, diveSpeed: 0, minClear: Infinity, contacts: 0, personBumps: 0, dives: 0, tick: 0, at: null };
      const agents = (): A[] => ((h.state().ext as { agents?: { list: A[] } }).agents?.list ?? []) as A[];
      for (let k = 0; k < ticks; k++) {
        const s = h.state();
        const c = s.players.p1!.car;
        if (r.target < 0 && c.speed > 20) {
          let best: { id: number; d: number } | null = null;
          for (const a of agents()) {
            if (a.kind !== "person" || a.dodge) continue;
            const dx = a.x - c.x;
            const dz = a.z - c.z;
            const d = Math.hypot(dx, dz);
            if (d < 25 || d > 70) continue;
            const ang = Math.atan2(dx, -dz) - c.heading;
            if (Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang))) > 0.35) continue;
            if (!best || d < best.d) best = { id: a.id, d };
          }
          if (best) r.target = best.id;
        }
        let steer = 0;
        const t = r.target >= 0 ? agents().find((a) => a.id === r.target) : undefined;
        if (t) {
          const e = Math.atan2(t.x - c.x, -(t.z - c.z)) - c.heading;
          steer = Math.max(-1, Math.min(1, Math.atan2(Math.sin(e), Math.cos(e)) * 3));
        }
        h.stepFrames!([{ p1: { throttle: 1, steer, brake: 0, actions: 0 } }]);
        const s2 = h.state();
        const c2 = s2.players.p1!.car;
        const d = (s2.ext as { dodge?: { contacts: number; dives: number } }).dodge;
        r.contacts = d?.contacts ?? 0;
        r.dives = d?.dives ?? 0;
        r.personBumps = c2.personBumps;
        r.tick = s2.tick;
        const t2 = r.target >= 0 ? agents().find((a) => a.id === r.target) : undefined;
        if (t2) {
          // Clearance: the person's body (0.3 m) from the car's box (2.2 x 0.95 m half extents).
          const fx = Math.sin(c2.heading);
          const fz = -Math.cos(c2.heading);
          const ox = t2.x - c2.x;
          const oz = t2.z - c2.z;
          const dl = Math.max(0, Math.abs(ox * -fz + oz * fx) - 0.95);
          const df = Math.max(0, Math.abs(ox * fx + oz * fz) - 2.2);
          if (Math.hypot(c2.speed, c2.lateral) > 1) r.minClear = Math.min(r.minClear, Math.hypot(dl, df) - 0.3);
          if (t2.dodge && r.diveTick < 0) {
            r.diveTick = s2.tick;
            r.diveSpeed = c2.speed;
            const v = Math.hypot(c2.speed, c2.lateral) || 1;
            r.at = { x: t2.x, z: t2.z, tx: t2.dodge.tx, tz: t2.dodge.tz, ux: (c2.speed * fx - c2.lateral * fz) / v, uz: (c2.speed * fz + c2.lateral * fx) / v };
          }
        }
        if (r.diveTick >= 0 && s2.tick >= r.diveTick + stopAfterDive) break;
      }
      w.__dodgeRun = r;
      return r;
    },
    { ticks, stopAfterDive },
  );
}

test.describe("the dodge on the real city", () => {
  test.skip(optionalAbsent("sf", SF), ABSENT);
  test.beforeEach(() => gate("sf", SF, ABSENT));
  if (!SHOTS) test.use({ viewport: FAST_VIEWPORT });

  test("a car flat out at a person: they dive clear, nobody is touched, and the dive is drawn", async ({ page }) => {
    test.setTimeout(300_000);
    const problems = await bootWorld(page, "sf", SHOTS ? "" : FAST_QUERY);
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
    // Up to 15 s of driving; stop as the target dives (and look at it), then carry on 2 s.
    let r = await drive(page, 900, 0);
    expect(r.target, "a person ahead of the car to aim at").toBeGreaterThanOrEqual(0);
    expect(r.diveTick, "the person dived").toBeGreaterThanOrEqual(0);
    expect(r.diveSpeed, "the car's speed when they dived, m/s").toBeGreaterThan(20);

    // The renderer draws someone dodging. Shots: a fly camera 12 m ahead of them along the car's
    // travel and 3.5 m up, halfway between where they stood and where they land, looking back at
    // them with the car coming: the dive goes across the picture, so the gap between them and
    // the car is plain to see.
    const f = await features(page);
    const at = r.at!;
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      const mx = (at.x + at.tx) / 2;
      const mz = (at.z + at.tz) / 2;
      const cx = mx + at.ux * 12;
      const cz = mz + at.uz * 12;
      const yaw = (Math.atan2(mx - cx, -(mz - cz)) * 180) / Math.PI;
      const y = await page.evaluate((id) => {
        const list = ((window as unknown as FogWindow).__fogcity!.state().ext as { agents?: { list: Array<{ id: number; y: number }> } }).agents?.list ?? [];
        return list.find((a) => a.id === id)?.y ?? 0;
      }, r.target);
      if (f.flyTo) await page.evaluate(({ cx, y, cz, yaw }) => (window as unknown as FogWindow).__fogcity!.flyTo!(cx, y + 3.5, cz, yaw, -14), { cx, y, cz, yaw });
      await settle(page, 60_000);
    }
    let drawnDodging = 0;
    const steps = [0, 7, 7, 8, 12, 16];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i]! > 0) r = await drive(page, steps[i]!, 1_000_000);
      await frames(page, 3);
      const info = await renderInfo(page);
      drawnDodging = Math.max(drawnDodging, info?.agentsDodging ?? 0);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `dive-${i + 1}-tick-${r.tick}.png`) });
    }
    if (f.renderInfo) expect(drawnDodging, "agents drawn in a dodge pose").toBeGreaterThan(0);

    // On for two more seconds (the car well past), then the verdict.
    r = await drive(page, 120, 1_000_000);
    expect(r.contacts, "people inside a vehicle (ext.dodge.contacts)").toBe(0);
    expect(r.personBumps, "the car's person contacts").toBe(0);
    expect(r.minClear, "the person's least clearance from the moving car, m").toBeGreaterThanOrEqual(0.75);
    expect(r.dives).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
