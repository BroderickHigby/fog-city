import { test, expect, type Locator } from "@playwright/test";
async function phoneSettled(phone: Locator): Promise<void> {
  // Geometry describes the resting handset, after its real entrance animation.
  await phone.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
}
test.beforeEach(async ({ page }) => { await page.goto("/tests/ui/phone-shell.fixture.html"); });
test("phone home has consistent icons, honest unavailable apps and working Back/Home", async ({ page }) => {
  const opener = page.getByRole("button", { name: "Open phone", exact: true }); await opener.click();
  const phone = page.getByRole("dialog", { name: "Phone", exact: true });
  await phoneSettled(phone);
  const bounds = await phone.boundingBox(); expect(bounds!.width).toBeGreaterThanOrEqual(360); expect(bounds!.width).toBeLessThanOrEqual(400);
  await expect(page.locator(".fc-phone-status")).toHaveAttribute("data-tick", "17");
  await expect(page.locator(".fc-phone-status")).toHaveText("Fog CityEmbarcadero");
  const apps = page.getByRole("navigation", { name: "Phone apps", exact: true });
  for (const name of ["Map", "BotBounty", "Bot Check", "Bank", "Settings", "Office Hours"]) {
    const app = apps.getByRole("button", { name, exact: true }); await expect(app).toBeEnabled(); await expect(app.locator("svg path").first()).toHaveAttribute("d", /.+/);
  }
  for (const name of ["Ride", "Radio", "FogCast", "Messages", "Playlists"]) {
    const app = apps.getByRole("button", { name, exact: true }); await expect(app).toBeDisabled(); await expect(app).toHaveAccessibleDescription("Unavailable");
  }
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
  await apps.getByRole("button", { name: "Bank", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Bank", exact: true })).toBeVisible();
  await expect(page.getByText("$322", { exact: true })).toBeVisible();
  await expect(page.locator(".fc-phone-apps")).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(apps.getByRole("button", { name: "Bank", exact: true })).toBeFocused();
  await apps.getByRole("button", { name: "BotBounty", exact: true }).click();
  await expect(page.getByText("Confirmed rogue firmware", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Phone home", exact: true }).click();
  await expect(apps.getByRole("button", { name: "BotBounty", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { appEvents: string[] }).appEvents)).toEqual(["bank", "botBounty"]);
});
test("Office Hours shows the host's booking reason, routes to Ramen and books only when available", async ({ page }) => {
  await page.getByRole("button", { name: "Open phone", exact: true }).click(); await page.getByRole("button", { name: "Office Hours", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Office Hours", exact: true })).toBeVisible();
  await expect(page.getByText("Visit the Ramen door to book your interview.", { exact: true })).toBeVisible();
  await expect(page.getByText("2 bookings left today", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Book interview", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Route to Ramen", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { waypoints: unknown[] }).waypoints)).toEqual([{ x: 120, z: 200 }]);
  await page.evaluate(() => (window as unknown as { updatePhoneFixture(patch: unknown): void }).updatePhoneFixture({ officeHours: { available: true, detail: "You are at the Ramen door. Book an interview.", remaining: 1, destination: { x: 120, z: 200 } } }));
  await expect(page.getByText("1 booking left today", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Book interview", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { bookingRequests: unknown[] }).bookingRequests)).toEqual([17]);
});
test("map keyboard/pan controls and waypoint activation remain inside the handset", async ({ page }) => {
  await page.getByRole("button", { name: "Open map (M)", exact: true }).click();
  const map = page.getByRole("application", { name: "Map", exact: true }); await map.focus();
  await map.press("ArrowRight"); await map.press("+"); await map.press("Enter");
  expect(await page.evaluate(() => (window as unknown as { waypoints: unknown[] }).waypoints)).toEqual([{ x: 80, z: 0 }]);
  await page.getByRole("button", { name: "Phone apps", exact: true }).click();
  await expect(page.locator('[data-phone-app="map"]')).toBeFocused();
  await page.locator('[data-phone-app="map"]').click();
  await expect(page.getByRole("button", { name: "Zoom map in", exact: true })).toBeVisible();
  await page.keyboard.down("KeyW");
  expect(await page.evaluate(() => (window as unknown as { ui: { sampleInput(): unknown } }).ui.sampleInput())).toEqual({ throttle: 0, steer: 0, brake: 0, actions: 0 });
  await page.keyboard.up("KeyW");
});
test("Settings keeps its own scroll, fixed navigation and focused controls across view updates", async ({ page }) => {
  await page.getByRole("button", { name: "Open phone", exact: true }).click(); await page.getByRole("button", { name: "Settings", exact: true }).click();
  const phone = page.getByRole("dialog", { name: "Settings", exact: true }), body = page.locator(".fc-phone-body"), footer = page.getByRole("navigation", { name: "Phone navigation", exact: true });
  await expect(page.getByRole("region", { name: "Graphics settings", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audio", exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Saved progress", exact: true })).toHaveCount(1);
  const radio = page.getByRole("radio", { name: "Standard", exact: true }); await radio.focus();
  await page.evaluate(() => (window as unknown as { updatePhoneFixture(patch: unknown): void }).updatePhoneFixture({ tick: 18, cashCents: 99900, streetName: "Market Street" }));
  await expect(radio).toBeFocused();
  await expect(page.locator(".fc-phone-status")).toHaveAttribute("data-tick", "18");
  await phoneSettled(phone);
  const before = await footer.boundingBox();
  await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await phone.evaluate(element => element.scrollTop)).toBe(0);
  expect(await footer.boundingBox()).toEqual(before);
  await expect(page.getByRole("button", { name: "Phone home", exact: true })).toBeVisible();
});
for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }, { width: 844, height: 390 }, { width: 640, height: 400 }]) {
  test(`phone fits ${viewport.width} × ${viewport.height} without hiding its chrome or dimming the city`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.goto("/tests/ui/phone-shell.fixture.html?touch=1");
    await page.getByRole("button", { name: "Open phone", exact: true }).click();
    const phone = page.getByRole("dialog", { name: "Phone", exact: true });
    await phoneSettled(phone);
    const bounds = (await phone.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.locator(".fc-phone-body").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const backdrop = await page.locator(".fc-modal-layer").evaluate(element => ({ background: getComputedStyle(element).backgroundColor, blur: getComputedStyle(element).backdropFilter }));
    expect(backdrop).toEqual({ background: "rgba(0, 0, 0, 0)", blur: "none" });
    for (const name of ["Close", "Phone home"]) {
      const button = page.getByRole("button", { name, exact: true }); await expect(button).toBeVisible();
      const box = (await button.boundingBox())!; expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });
}
