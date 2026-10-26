import { test, expect, type Page, type TestInfo } from "@playwright/test";
import type { MountedGameUI, UiView } from "../../src/ui/types.ts";

interface Harness {
  ui: MountedGameUI;
  view: UiView;
  pauseEvents: boolean[];
  lightingEvents: string[];
  padHarness?: { connected: boolean; axes: number[]; buttons: { pressed: boolean; value: number }[] };
}

const missionTitle = "Coit Tower reconnaissance across the northern waterfront";
const missionDetail = "Follow the waterfront route and inspect the tower signal before returning to the team. ".repeat(9)
  + "Keep this complete mission note readable: " + "Waterfront".repeat(15);
const errors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on("pageerror", error => messages.push(error.message));
});
test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));

async function mount(page: Page, touch = false): Promise<void> {
  await page.goto(`/tests/ui/fixture.html?touch=${touch ? "1" : "0"}`);
  await expect(page.getByRole("button", { name: "Player status", exact: true })).toBeVisible();
}

async function update(page: Page, patch: Partial<UiView>): Promise<void> {
  await page.evaluate(patch => {
    const host = window as unknown as Harness;
    host.view = { ...host.view, ...patch };
    host.ui.update(host.view);
  }, patch);
}

async function readInput(page: Page) {
  return page.evaluate(() => (window as unknown as Harness).ui.sampleInput());
}

async function inspectBounds(page: Page, testInfo: TestInfo): Promise<void> {
  const geometry = await page.evaluate(() => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const visible = (element: Element) => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const buttons = [...document.querySelectorAll(".fc-hud button,.fc-hud select")].filter(visible).map(element => ({
      label: element.getAttribute("aria-label") ?? element.textContent,
      ...rect(element),
    }));
    const hud = document.querySelector(".fc-hud")!;
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth,
      hud: rect(hud), buttons, objective: rect(document.querySelector(".fc-objective")!),
      navigation: rect(document.querySelector(".fc-navigation")!),
      speed: rect(document.querySelector(".fc-speed")!),
      touchActions: document.querySelector(".fc-touch-actions") ? rect(document.querySelector(".fc-touch-actions")!) : null };
  });
  await testInfo.attach("HUD geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  expect(geometry.hud.y).toBeGreaterThanOrEqual(0);
  expect(geometry.hud.bottom).toBeLessThanOrEqual(120);
  for (const button of geometry.buttons) {
    expect(button.width, button.label ?? "unnamed HUD control").toBeGreaterThanOrEqual(44);
    expect(button.height, button.label ?? "unnamed HUD control").toBeGreaterThanOrEqual(44);
    expect(button.x).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeLessThanOrEqual(geometry.width + 1);
    expect(button.y).toBeGreaterThanOrEqual(0);
    expect(button.bottom).toBeLessThanOrEqual(geometry.height);
  }
  for (let i = 0; i < geometry.buttons.length; i++) for (let j = i + 1; j < geometry.buttons.length; j++) {
    const a = geometry.buttons[i]!, b = geometry.buttons[j]!;
    const overlapX = Math.min(a.right, b.right) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
    expect(overlapX > 1 && overlapY > 1, `${a.label} overlaps ${b.label}`).toBe(false);
  }
  expect(geometry.objective.height).toBeLessThanOrEqual(100);
  expect(geometry.objective.right).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.objective.bottom).toBeLessThanOrEqual(geometry.navigation.y);
  if (geometry.touchActions) {
    const a = geometry.speed, b = geometry.touchActions;
    expect(Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1
      && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1,
    "Speed display overlaps the touch action grid").toBe(false);
  }
}

for (const layout of [
  { name: "desktop", width: 1280, height: 800, touch: false },
  { name: "mobile", width: 390, height: 844, touch: true },
  { name: "320px narrow", width: 320, height: 740, touch: true },
  // 1280x800 at 200% zoom has this effective CSS viewport; avoid a CSS transform,
  // which leaves media queries unchanged and can conceal responsive failures.
  { name: "200% effective desktop zoom", width: 640, height: 400, touch: false },
]) {
  test(`${layout.name}: compact controls and long mission remain within the viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await mount(page, layout.touch);
    await update(page, { objective: { id: "long-mission", title: missionTitle, detail: missionDetail }, popups: [] });
    const mission = page.getByRole("button", { name: `Mission details: ${missionTitle}`, exact: true });
    await expect(mission).toBeVisible();
    await expect(page.getByText(missionDetail, { exact: true })).toBeHidden();
    await inspectBounds(page, testInfo);
    await mission.click();
    const dialog = page.getByRole("dialog", { name: "Current objective", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(missionDetail, { exact: true })).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(layout.width + 1);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(layout.height + 1);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(mission).toBeFocused();
  });
}

test("Player status explains all five stats and keeps the game inert until Escape", async ({ page }) => {
  await mount(page);
  const status = page.getByRole("button", { name: "Player status", exact: true });
  await expect(status).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await status.click();
  await expect(status).toHaveAttribute("aria-expanded", "true");
  const dialog = page.getByRole("dialog", { name: "Player status", exact: true });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  for (const label of ["Runway", "Cash", "Water", "Robot attention", "Reputation"]) {
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(dialog.getByText("$100", { exact: true })).toBeVisible();
  await expect(dialog.getByText("∞", { exact: true })).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await close.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.down("KeyW");
  expect(await readInput(page)).toEqual({ throttle: 0, steer: 0, brake: 0, actions: 0 });
  await page.keyboard.up("KeyW");
  await update(page, { cashCents: 32100 });
  await expect(dialog.getByText("$321", { exact: true })).toBeVisible();
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(status).toHaveAttribute("aria-expanded", "false");
  await expect(status).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as Harness).pauseEvents.slice(-2))).toEqual([true, false]);
});

test("mobile More actions retains Counter, Controls and Lighting with focus restoration", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, true);
  await expect(page.getByRole("button", { name: "Counter", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Controls", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Lighting", exact: true })).toBeHidden();
  const more = page.getByRole("button", { name: "More actions", exact: true });
  await more.click();
  const quick = page.getByRole("dialog", { name: "Quick actions", exact: true });
  await expect(quick).toBeVisible();
  await quick.getByRole("button", { name: "Lighting", exact: true }).click();
  await page.getByRole("dialog", { name: "Lighting", exact: true }).getByRole("button", { name: "Golden hour", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as Harness).lightingEvents)).toEqual(["golden"]);
  await expect(more).toBeFocused();
  await more.click();
  await quick.getByRole("button", { name: "Controls", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Controls", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole("dialog", { name: "Quick actions", exact: true }).getByRole("button", { name: "Counter", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Counter", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
});

test("narrow status prioritizes warnings without losing the complete values", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await mount(page, true);
  const status = page.getByRole("button", { name: "Player status", exact: true });
  await update(page, { threat: 3, runwayMonths: .5, cashCents: 987600, salt: true });
  await expect(status.locator('[data-icon="threat"]')).toBeVisible();
  await expect(status.locator('[data-icon="runway"]')).toBeVisible();
  await status.click();
  const dialog = page.getByRole("dialog", { name: "Player status", exact: true });
  await expect(dialog.getByText("$9,876", { exact: true })).toBeVisible();
  await expect(dialog.getByText("3", { exact: true })).toBeVisible();
  await expect(dialog.getByText("0.5 mo", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await update(page, { threat: 0, runwayMonths: 9, salt: false });
  await expect(status.locator('[data-icon="cash"]')).toBeVisible();
  await expect(status.locator('[data-icon="water"]')).toBeVisible();
  await inspectBounds(page, testInfo);
});

test("a collapsed mission keeps Continue reachable after its interaction is dismissed", async ({ page }) => {
  await mount(page);
  await update(page, { objective: { id: "signup-step", title: "Your desk", detail: missionDetail },
    interaction: { id: "signup-step", title: "Your desk", detail: "Choose a startup", startup: true, choices: [] }, popups: [] });
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(missionDetail, { exact: true })).toBeHidden();
  const objective = page.locator(".fc-objective");
  await expect(objective.getByRole("button", { name: "Mission details: Your desk", exact: true })).toBeVisible();
  const resume = objective.getByRole("button", { name: "Continue", exact: true });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(page.getByRole("textbox")).toBeVisible();
});

test("gamepad can close Player status without a held action leaking into gameplay", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const host = window as unknown as Harness;
    host.padHarness = { connected: true, axes: [0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) };
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [host.padHarness] });
  });
  const press = async (indices: number[]) => page.evaluate(async indices => {
    const pad = (window as unknown as Harness).padHarness!;
    pad.buttons.forEach((button, index) => { button.pressed = indices.includes(index); button.value = button.pressed ? 1 : 0; });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, indices);
  const status = page.getByRole("button", { name: "Player status", exact: true });
  await status.click();
  await press([13]);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await press([]); await press([0]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(status).toBeFocused();
  expect(await readInput(page)).toEqual({ throttle: 0, steer: 0, brake: 0, actions: 0 });
  await press([]);
});
