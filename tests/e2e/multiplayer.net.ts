import { expect, test } from "@playwright/test";
import type {} from "../../src/debug.ts";
import type {} from "../../src/net/lobby.ts";

test("two browser contexts share a private room, see movement, leave and rejoin", async ({ browser, baseURL }) => {
  const world = process.env.MULTIPLAYER_WORLD ?? "dev";
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await first.newPage(), b = await second.newPage();
  const errors: string[] = [];
  a.on("pageerror", (error) => errors.push(error.message));
  b.on("pageerror", (error) => errors.push(error.message));
  try {
    for (const page of [a, b]) {
      await page.goto(`${baseURL}/?world=${world}&gfx=default&pr=0.5&radius=300`);
      await page.waitForFunction(() => window.__fogcity?.ready === true, null, { timeout: 120_000 });
      await page.getByText("Play with friends", { exact: true }).click();
    }
    await a.getByRole("button", { name: "Create room", exact: true }).click();
    await a.waitForFunction(() => window.__fogcityNet?.info()?.status === "connected", null, { timeout: 120_000 });
    const code = await a.evaluate(() => window.__fogcityNet!.info()!.code);
    await b.getByRole("textbox", { name: "Room code" }).fill(code);
    await b.getByRole("button", { name: "Join", exact: true }).click();
    for (const page of [a, b]) await page.waitForFunction(() => Object.keys(window.__fogcity!.state().players).length === 2);
    const id = await a.evaluate(() => window.__fogcityNet!.info()!.playerId);
    const z = await b.evaluate((id) => window.__fogcity!.state().players[id]!.car.z, id);
    await a.locator("canvas").click({ position: { x: 400, y: 350 } });
    await a.keyboard.down("KeyW");
    await b.waitForFunction(({ id, z }) => window.__fogcity!.state().players[id]!.car.z < z - 2, { id, z }, { timeout: 30_000 });
    await a.keyboard.up("KeyW");
    expect(await a.getByRole("list", { name: "Players" }).locator("li").count()).toBe(2);
    await b.getByRole("button", { name: "Leave room", exact: true }).click();
    await a.waitForFunction(() => Object.keys(window.__fogcity!.state().players).length === 1);
    await b.getByRole("textbox", { name: "Room code" }).fill(code);
    await b.getByRole("button", { name: "Join", exact: true }).click();
    await a.waitForFunction(() => Object.keys(window.__fogcity!.state().players).length === 2);
    await a.screenshot({ path: `test-results/multiplayer-${world}-two-players.png` });
    expect(errors).toEqual([]);
  } finally { await first.close(); await second.close(); }
});
