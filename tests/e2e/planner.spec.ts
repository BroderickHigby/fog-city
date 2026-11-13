// Fog City Planner (?mode=planner, docs/planner.md): the US-101 / Lombard St demo boots over the
// real city without the game's simulation, runs its traffic, switches signal plans and fills
// its scorecard.
import { expect, test } from "@playwright/test";
import { FAST_VIEWPORT, gateWorld, watchProblems } from "./fixtures.ts";

test.use({ viewport: FAST_VIEWPORT });
test.describe.configure({ timeout: 300_000 });

interface PlannerWindow {
  __fogcityPlanner?: {
    ready: boolean;
    corridor: { signals: unknown[]; length: number };
    state(): { plan: string; demand: string; period: string; cars: number; simTime: number; camera: string };
    select(change: Record<string, unknown>): void;
    scores(): { plan: string; co2KgPerHour: number; lostHours: number; travelTimeS: [number, number] }[];
  };
  __fogcity?: unknown;
}

test("the Lombard St planner runs traffic, switches plans and scores them", async ({ page }) => {
  gateWorld("sf");
  const problems = watchProblems(page);
  await page.goto("/?world=sf&mode=planner&gfx=low&radius=300&pr=0.5&camera=overview&speed=10");
  await page.waitForFunction(() => (window as unknown as PlannerWindow).__fogcityPlanner?.ready === true
    || (document.getElementById("hud")?.textContent ?? "").startsWith("Failed"), null, { timeout: 240_000 });
  const boot = await page.evaluate(() => {
    const p = (window as unknown as PlannerWindow).__fogcityPlanner;
    return p ? { signals: p.corridor.signals.length, length: p.corridor.length, game: "__fogcity" in window } : document.getElementById("hud")?.textContent;
  });
  expect(boot).toMatchObject({ signals: 13, game: false });
  await expect(page.getByRole("complementary", { name: "Fog City Planner controls" })).toBeVisible();

  // Traffic moves: the model clock advances and cars are on the street.
  const t0 = await page.evaluate(() => (window as unknown as PlannerWindow).__fogcityPlanner!.state().simTime);
  await page.waitForFunction((t) => (window as unknown as PlannerWindow).__fogcityPlanner!.state().simTime > t + 20, t0, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as unknown as PlannerWindow).__fogcityPlanner!.state().cars)).toBeGreaterThan(20);

  // The panel's buttons switch the plan; the scorecard lists all four plans.
  await page.getByRole("button", { name: "Optimized timing" }).click();
  expect(await page.evaluate(() => (window as unknown as PlannerWindow).__fogcityPlanner!.state().plan)).toBe("optimized");
  await expect(page.getByRole("button", { name: "Optimized timing" })).toHaveAttribute("aria-pressed", "true");
  const scores = await page.evaluate(() => (window as unknown as PlannerWindow).__fogcityPlanner!.scores());
  expect(scores.map((r) => r.plan)).toEqual(["today", "greenwave", "optimized", "adaptive"]);
  const by = Object.fromEntries(scores.map((r) => [r.plan, r]));
  expect(by.optimized!.co2KgPerHour).toBeLessThan(by.today!.co2KgPerHour);
  await expect(page.locator(".fcp tbody tr")).toHaveCount(4, { timeout: 30_000 });

  // The traffic level and the camera change too.
  await page.getByRole("combobox", { name: "Traffic level" }).selectOption("grow2031");
  await page.getByRole("button", { name: "Ride along" }).click();
  expect(await page.evaluate(() => (window as unknown as PlannerWindow).__fogcityPlanner!.state())).toMatchObject({ demand: "grow2031", camera: "follow" });
  expect(problems).toEqual([]);
});
