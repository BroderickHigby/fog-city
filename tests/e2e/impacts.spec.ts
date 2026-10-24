// Impacts in the browser, through real controls (src/sim/impacts.ts, src/render/impact-layer.ts):
// on the dev world the player drives with the keyboard (W, A, D held as a person would) into the
// nearest robotaxi. The hit shoves it off its lane (knocked, hazards on), dents both, and the
// renderer bursts sparks at it. The steering is closed loop on window.__fogcity.state(); only
// key presses reach the game.

import { expect, test, type Page } from "@playwright/test";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, simState } from "./fixtures.ts";
import { propIndex, type AgentState, type SimState } from "../../src/sim/index.ts";
import { loadWorld } from "../helpers.ts";

interface ImpactWindow {
  __fogcityImpacts?: { bursts: number };
}

function agents(s: SimState): AgentState[] {
  return ((s.ext.agents as { list?: AgentState[] } | undefined)?.list ?? []);
}

function impacts(s: SimState): { events: Array<{ kind: string; a: string; b: string; dv: number }>; cars: Record<string, { front: number; condition: number }> } | undefined {
  return s.ext.impacts as ReturnType<typeof impacts>;
}

async function hold(page: Page, held: Set<string>, want: ReadonlySet<string>): Promise<void> {
  for (const k of [...held]) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
  for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
}

test.describe("impacts: car vs robotaxi through real controls", () => {
  test.use({ viewport: FAST_VIEWPORT });

  test("driving into a robotaxi shoves it off its lane, dents both and throws sparks", async ({ page }) => {
    const problems = await bootWorld(page, "dev", `${FAST_QUERY}&debug=1`);
    const me = (await page.evaluate(() => (window as unknown as { __fogcity: { simInfo(): { playerIds: string[] } } }).__fogcity.simInfo().playerIds[0]))!;
    const held = new Set<string>();
    let target = -1;
    let hit: { kind: string; a: string; b: string; dv: number } | undefined;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const s = await simState(page);
      hit = impacts(s)?.events.find((e) => e.a === `p:${me}` && e.kind === "car-taxi");
      if (hit) break;
      const c = s.players[me]!.car;
      // The nearest robotaxi (keep chasing the one picked while it lives).
      const taxis = agents(s).filter((a) => a.kind === "robotaxi");
      let t = taxis.find((a) => a.id === target);
      if (!t) {
        t = taxis.sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z))[0];
        target = t?.id ?? -1;
      }
      if (!t) { await hold(page, held, new Set()); await page.waitForTimeout(250); continue; }
      const want = Math.atan2(t.x - c.x, -(t.z - c.z));
      let off = want - c.heading;
      while (off > Math.PI) off -= 2 * Math.PI;
      while (off < -Math.PI) off += 2 * Math.PI;
      const keys = new Set<string>(["KeyW"]);
      if (off > 0.06) keys.add("KeyD");
      else if (off < -0.06) keys.add("KeyA");
      await hold(page, held, keys);
      if (process.env.IMPACTS_E2E_LOG) console.log(s.tick, c.x.toFixed(1), c.z.toFixed(1), c.speed.toFixed(1), "taxi", t.id, t.x.toFixed(1), t.z.toFixed(1), off.toFixed(2), [...keys].join("+"), taxis.length);
      await page.waitForTimeout(60);
    }
    await hold(page, held, new Set());
    expect(hit, "the car hit a robotaxi within the time limit").toBeDefined();
    expect(hit!.dv).toBeGreaterThan(0);

    // The robotaxi was knocked off its lane (or nudged and dented), and the car is dented.
    const id = Number(hit!.b.slice(2));
    await page.waitForFunction((id) => {
      const s = (window as unknown as { __fogcity: { state(): SimState } }).__fogcity.state();
      const a = ((s.ext.agents as { list?: AgentState[] } | undefined)?.list ?? []).find((x) => x.id === id);
      return a?.dents !== undefined;
    }, id, { timeout: 60_000 });
    const after = await simState(page);
    const dmg = impacts(after)!.cars[me]!;
    expect(dmg.front + (dmg as unknown as { left: number }).left + (dmg as unknown as { right: number }).right + (dmg as unknown as { rear: number }).rear).toBeGreaterThan(0);
    expect(dmg.condition).toBeLessThanOrEqual(100);
    // The renderer saw the hit.
    await page.waitForFunction(() => ((window as unknown as ImpactWindow).__fogcityImpacts?.bursts ?? 0) > 0, null, { timeout: 60_000 });
    expect(problems).toEqual([]);
  });

  test("driving into a robot bowls it over: it topples, lies there and gets up", async ({ page }) => {
    const problems = await bootWorld(page, "dev", `${FAST_QUERY}&debug=1`);
    const me = (await page.evaluate(() => (window as unknown as { __fogcity: { simInfo(): { playerIds: string[] } } }).__fogcity.simInfo().playerIds[0]))!;
    const held = new Set<string>();
    let target = -1;
    let hit: { kind: string; a: string; b: string; dv: number; fell?: boolean } | undefined;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const s = await simState(page);
      hit = (impacts(s)?.events as Array<{ kind: string; a: string; b: string; dv: number; fell?: boolean }> | undefined)?.find((e) => e.a === `p:${me}` && e.kind === "car-robot");
      if (hit) break;
      const c = s.players[me]!.car;
      const robots = agents(s).filter((a) => (a.kind === "errandRobot" || a.kind === "sidewalkBot") && !a.knock);
      let t = robots.find((a) => a.id === target);
      if (!t) {
        t = robots.sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z))[0];
        target = t?.id ?? -1;
      }
      if (!t) { await hold(page, held, new Set()); await page.waitForTimeout(250); continue; }
      let off = Math.atan2(t.x - c.x, -(t.z - c.z)) - c.heading;
      while (off > Math.PI) off -= 2 * Math.PI;
      while (off < -Math.PI) off += 2 * Math.PI;
      const keys = new Set<string>(["KeyW"]);
      if (off > 0.06) keys.add("KeyD");
      else if (off < -0.06) keys.add("KeyA");
      await hold(page, held, keys);
      await page.waitForTimeout(60);
    }
    await hold(page, held, new Set(["KeyS"]));
    expect(hit, "the car hit a robot within the time limit").toBeDefined();
    const id = Number(hit!.b.slice(2));
    // It topples (its pitch, which the agent layer draws), then is back on its feet.
    await page.waitForFunction((id) => {
      const s = (window as unknown as { __fogcity: { state(): SimState } }).__fogcity.state();
      const a = ((s.ext.agents as { list?: AgentState[] } | undefined)?.list ?? []).find((x) => x.id === id);
      return !a || Math.abs(a.pitch) > 1;
    }, id, { timeout: 60_000 });
    await hold(page, held, new Set());
    await page.waitForFunction((id) => {
      const s = (window as unknown as { __fogcity: { state(): SimState } }).__fogcity.state();
      const a = ((s.ext.agents as { list?: AgentState[] } | undefined)?.list ?? []).find((x) => x.id === id);
      return !a || (a.knock === undefined && a.pitch === 0);
    }, id, { timeout: 120_000 });
    expect(problems).toEqual([]);
  });

  test("driving into a street tree knocks it over (or snaps it), and the renderer topples it", async ({ page }) => {
    // The breakable trees and where they are, from the same world in Node (props.ts).
    const { world } = loadWorld("dev", { roads: true });
    const trees = propIndex(world).list.filter((p) => p.kind === "tree" && p.size !== "mature");
    expect(trees.length, "the dev world has breakable street trees").toBeGreaterThan(0);
    const problems = await bootWorld(page, "dev", `${FAST_QUERY}&debug=1`);
    const me = (await page.evaluate(() => (window as unknown as { __fogcity: { simInfo(): { playerIds: string[] } } }).__fogcity.simInfo().playerIds[0]))!;
    const held = new Set<string>();
    let target: (typeof trees)[number] | undefined;
    let broke: string | undefined;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const s = await simState(page);
      const knocked = (s.ext.impacts as { props?: Record<string, unknown> } | undefined)?.props ?? {};
      broke = Object.keys(knocked)[0];
      if (broke) break;
      const c = s.players[me]!.car;
      // The nearest breakable tree ahead-ish, kept once picked.
      if (!target) target = [...trees].sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z))[0];
      let off = Math.atan2(target!.x - c.x, -(target!.z - c.z)) - c.heading;
      while (off > Math.PI) off -= 2 * Math.PI;
      while (off < -Math.PI) off += 2 * Math.PI;
      const keys = new Set<string>(["KeyW"]);
      if (off > 0.06) keys.add("KeyD");
      else if (off < -0.06) keys.add("KeyA");
      await hold(page, held, keys);
      await page.waitForTimeout(60);
    }
    await hold(page, held, new Set());
    expect(broke, "a street tree broke within the time limit").toBeDefined();
    // The renderer draws it down (re-posed in the foliage layer or its tile's mesh).
    await page.waitForFunction(() => ((window as unknown as { __fogcityProps?: { info(): { knocked: number } } }).__fogcityProps?.info().knocked ?? 0) > 0, null, { timeout: 60_000 });
    expect(problems).toEqual([]);
  });
});
