import { test, expect, type Page } from "@playwright/test";
async function openSettings(page: Page, query = "") {
  await page.goto(`/tests/ui/graphics-settings.fixture.html${query}`);
  await page.getByRole("button", { name: "Open phone", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}
test.beforeEach(async ({ page }) => { await page.goto("/tests/ui/graphics-settings.fixture.html"); await page.evaluate(() => localStorage.clear()); });
test("four labelled choices fit the phone, persist and retain modal input/focus behavior", async ({ page }) => {
  await openSettings(page);
  const graphics = page.getByRole("region", { name: "Graphics settings", exact: true });
  await expect(graphics.getByRole("group", { name: "Rendering quality" })).toBeVisible();
  for (const name of ["Auto", "Low", "Standard", "High"]) await expect(graphics.getByRole("radio", { name, exact: true })).toBeVisible();
  await graphics.getByRole("radio", { name: "High", exact: true }).click();
  await expect(graphics.getByRole("radio", { name: "High", exact: true })).toBeChecked();
  await expect(graphics.getByRole("status")).toHaveText("Graphics changed. Saved for this browser.");
  await page.keyboard.down("KeyW");
  expect(await page.evaluate(() => (window as unknown as { ui: { sampleInput(): unknown } }).ui.sampleInput())).toEqual({ throttle: 0, steer: 0, brake: 0, actions: 0 });
  await page.keyboard.up("KeyW");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Open phone", exact: true })).toBeFocused();
  await page.reload(); await page.getByRole("button", { name: "Open phone", exact: true }).click(); await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("radio", { name: "High", exact: true })).toBeChecked();
});
test("a pending change cannot be submitted twice and announces completion", async ({ page }) => {
  await openSettings(page, "?apply=delayed&gfx=high");
  await page.getByRole("radio", { name: "Low", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Applying Low…");
  for (const radio of await page.getByRole("radio").all()) await expect(radio).toBeDisabled();
  await page.evaluate(() => (window as unknown as { finishGraphics(): void }).finishGraphics());
  await expect(page.getByRole("radio", { name: "Low", exact: true })).toBeChecked();
  await expect(page.getByRole("status")).toContainText("Graphics changed.");
  expect(await page.evaluate(() => (window as unknown as { requests: string[] }).requests)).toEqual(["low"]);
});
test("a failed change keeps the old selection and offers a working retry", async ({ page }) => {
  await openSettings(page, "?apply=fail&gfx=high");
  await page.getByRole("radio", { name: "Low", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your previous setting is still selected");
  await expect(page.getByRole("radio", { name: "High", exact: true })).toBeChecked();
  await page.evaluate(() => (window as unknown as { setApplyMode(value: string): void }).setApplyMode("immediate"));
  await page.getByRole("button", { name: "Try graphics change again", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Low", exact: true })).toBeChecked();
  await expect(page.getByRole("alert")).toBeHidden();
});
test("GPU fallback reports actual Low without changing the manual request", async ({ page }) => {
  await openSettings(page, "?gfx=high");
  await page.evaluate(() => (window as unknown as { controller: import("../../src/render/gfx-preference.ts").GfxPreferenceController }).controller.reportApplied({ tier: "low", reason: "GPU recovery", safetyFallback: true }));
  await expect(page.getByRole("radio", { name: "High", exact: true })).toBeChecked();
  await expect(page.locator(".fc-graphics-current")).toHaveText("Using Low. High is selected.");
  await expect(page.getByRole("status")).toContainText("Graphics recovery is using Low");
});
