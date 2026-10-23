// Online Bot Sweep end to end: the real relay (`node server/main.ts`, as `pnpm relay` runs it)
// started on loopback, and two independent browser contexts playing through the real lobby UI
// on the SF world. Covers create, invite, join, ready, start, both players' controls reaching
// the other browser, a reload that rejoins the same seat mid-match, the host ending the match,
// the payout landing in the city once, a reload in the results that does not pay again, and the
// return to the city. The relay's abuse limits are covered by tests/server/net/relay.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { worldExists, ROOT } from "../helpers.ts";
import { gateWorld, type FogWindow } from "./fixtures.ts";
import { PORT } from "../../playwright.config.ts";
import type { NetDebug } from "../../src/ui/multiplayer.ts";
import type { SimState } from "../../src/sim/index.ts";

const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? PORT + 1101);
const RELAY = `ws://127.0.0.1:${RELAY_PORT}/relay`;
type NetWindow = FogWindow & { __fogcityNet?: NetDebug };

let relay: ChildProcess | null = null;
let relayLog = "";

async function startRelay(): Promise<void> {
  relay = spawn(process.execPath, ["server/main.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(RELAY_PORT), HOST: "127.0.0.1", RELAY_WORLDS: "sf" }, stdio: ["ignore", "pipe", "pipe"] });
  relay.stdout!.on("data", (d: Buffer) => { relayLog += d.toString(); });
  relay.stderr!.on("data", (d: Buffer) => { relayLog += d.toString(); });
  const end = Date.now() + 120_000;
  for (;;) {
    if (relay.exitCode !== null) throw new Error(`relay exited: ${relayLog}`);
    try { const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`relay did not start: ${relayLog}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const health = async (): Promise<Record<string, number>> => (await (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).json()) as Record<string, number>;

async function open(context: BrowserContext, query = ""): Promise<Page> {
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  (page as Page & { problems?: string[] }).problems = problems;
  await page.goto(`/?world=sf&gfx=default&pr=0.5&radius=250&relay=${encodeURIComponent(RELAY)}${query}`);
  await page.waitForFunction(() => (window as unknown as NetWindow).__fogcity?.ready === true, null, { timeout: 150_000 });
  await page.waitForFunction(() => (window as unknown as NetWindow).__fogcityNet?.available === true, null, { timeout: 30_000 });
  return page;
}
const net = <T>(page: Page, fn: (n: NetDebug, city: SimState) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__fogcityNet, window.__fogcity.state())`) as Promise<T>;
const waitNet = (page: Page, fn: string, timeout = 90_000) =>
  page.waitForFunction(`(() => { const n = window.__fogcityNet, city = window.__fogcity.state(); return (${fn}); })()`, null, { timeout });
const cityXp = (page: Page) => net(page, (_n, city) => ((city.ext.progression as { players: Record<string, { xp: number }> } | undefined)?.players.p1?.xp ?? 0));

test.describe("online Bot Sweep", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(900_000);
  test.beforeAll(async () => { if (worldExists("sf")) await startRelay(); });
  test.afterAll(async () => { relay?.kill("SIGTERM"); relay = null; });

  test("two browsers: invite, join, play, reload to rejoin, finish, payout once, return to the city", async ({ browser }: { browser: Browser }) => {
    gateWorld("sf");
    const first = await browser.newContext(), second = await browser.newContext();
    try {
      // Host creates a private room through the lobby UI.
      const a = await open(first);
      await a.getByRole("button", { name: "Play with friends" }).click();
      await a.getByRole("button", { name: "Create room" }).click();
      await waitNet(a, `n.info()?.phase === "lobby"`);
      const code = await net(a, (n) => n.info()!.code);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      await expect(a.locator(".fc-mp-code")).toHaveText(code);

      // The invited player opens the invitation link: the code is already filled in.
      const b = await open(second, `&room=${code}`);
      await expect(b.getByRole("textbox", { name: "Room code" })).toHaveValue(code);
      await b.getByRole("button", { name: "Join", exact: true }).click();
      await waitNet(a, `n.info()?.members.length === 2`);
      await waitNet(b, `n.info()?.playerId === "p2"`);
      await expect(a.getByRole("list", { name: "Players" }).locator("li")).toHaveCount(2);

      // Start is the host's, once everyone is ready.
      await expect(b.getByRole("button", { name: "Start Bot Sweep" })).toHaveCount(0);
      await expect(a.getByRole("button", { name: "Start Bot Sweep" })).toBeDisabled();
      await a.getByRole("button", { name: "Ready", exact: true }).click();
      await b.getByRole("button", { name: "Ready", exact: true }).click();
      await expect(a.getByRole("button", { name: "Start Bot Sweep" })).toBeEnabled({ timeout: 30_000 });
      const xpBefore = await cityXp(a);
      await a.getByRole("button", { name: "Start Bot Sweep" }).click();
      for (const page of [a, b]) await waitNet(page, `n.info()?.phase === "match" && n.match() !== null`, 120_000);
      await expect(a.getByRole("status", { name: "Bot Sweep match" })).toContainText("Units left");
      // The free-roam city is not part of the match.
      const cityTick = await net(a, (_n, city) => city.tick);
      const matchPlayers = await net(a, (n) => Object.keys(n.match()!.players).sort());
      expect(matchPlayers).toEqual(["p1", "p2"]);

      // Player 1 drives; player 2's browser sees player 1's car move (inputs relayed by player id).
      const z0 = await net(b, (n) => n.match()!.players.p1!.car.z), x0 = await net(b, (n) => n.match()!.players.p1!.car.x);
      await a.locator("canvas").first().click({ position: { x: 300, y: 300 } });
      await a.keyboard.down("KeyW");
      await waitNet(b, `Math.hypot(n.match().players.p1.car.x - ${x0}, n.match().players.p1.car.z - ${z0}) > 3`, 120_000);
      await a.keyboard.up("KeyW");
      // And the other way round.
      const p2 = await net(a, (n) => ({ x: n.match()!.players.p2!.car.x, z: n.match()!.players.p2!.car.z }));
      await b.locator("canvas").first().click({ position: { x: 300, y: 300 } });
      await b.keyboard.down("KeyW");
      await waitNet(a, `Math.hypot(n.match().players.p2.car.x - ${p2.x}, n.match().players.p2.car.z - ${p2.z}) > 3`, 120_000);
      await b.keyboard.up("KeyW");
      expect(await net(a, (_n, city) => city.tick)).toBe(cityTick);

      // Player 2 reloads mid-match: same seat, same player id, back in the running match.
      await b.reload();
      await b.waitForFunction(() => (window as unknown as NetWindow).__fogcity?.ready === true, null, { timeout: 150_000 });
      await waitNet(b, `n.info()?.phase === "match" && n.info()?.playerId === "p2" && n.match() !== null`, 120_000);
      await waitNet(a, `n.info()?.members.every((m) => m.connected)`);
      // Both browsers agree with the relay: no hash mismatch was ever reported.
      for (const page of [a, b]) await waitNet(page, `n.stats() && n.stats().frames > 120`, 120_000);
      expect((await health()).mismatches).toBe(0);
      for (const page of [a, b]) expect(await net(page, (n) => n.stats()!.mismatches)).toBe(0);

      // The host ends the match: results and a once-only payout on both sides.
      await a.getByRole("button", { name: "End match" }).click();
      for (const page of [a, b]) await waitNet(page, `n.info()?.phase === "results" && n.settlements().some((s) => s.status === "paid")`, 120_000);
      await expect(a.getByText("The host ended the match.")).toBeVisible();
      await expect(a.getByText(/XP added to your city/)).toBeVisible();
      const settlement = (await net(a, (n) => n.settlements()))[0]!;
      expect(settlement.id).toMatch(/:p1$/);
      expect(await cityXp(a)).toBe(xpBefore + settlement.xp);
      expect(await net(a, (n) => n.settledIds())).toContain(settlement.id);

      // A reload in the results: the city comes back from its autosave and is not paid again.
      await a.reload();
      await a.waitForFunction(() => (window as unknown as NetWindow).__fogcity?.ready === true, null, { timeout: 150_000 });
      await waitNet(a, `n.info()?.phase === "results" && n.settlements().length > 0`, 120_000);
      expect((await net(a, (n) => n.settlements())).map((s) => s.status)).toEqual(["already"]);
      expect(await cityXp(a)).toBe(xpBefore + settlement.xp);
      await expect(a.getByText(/already in your city/)).toBeVisible();

      // Back to the city: the room is left and free roam steps again.
      await a.getByRole("button", { name: "Back to city" }).click();
      await waitNet(a, `n.info()?.phase === "none"`);
      const after = await net(a, (_n, city) => city.tick);
      await a.waitForFunction((t) => (window as unknown as NetWindow).__fogcity!.state().tick > t + 30, after, { timeout: 60_000 });
      expect(await cityXp(a)).toBe(xpBefore + settlement.xp);
      await b.getByRole("button", { name: "Back to city" }).click();
      await waitNet(b, `n.info()?.phase === "none"`);
      for (const page of [a, b]) expect((page as Page & { problems?: string[] }).problems).toEqual([]);
    } catch (error) {
      // What each browser and the relay saw, for the failure report.
      for (const context of [first, second]) for (const page of context.pages()) {
        console.log(await page.evaluate(() => { const n = (window as unknown as NetWindow).__fogcityNet; return JSON.stringify({ info: n?.info(), stats: n?.stats(), settlements: n?.settlements() }); }).catch(String));
      }
      console.log(relayLog.slice(-2000), JSON.stringify(await health().catch(() => null)));
      throw error;
    } finally {
      await first.close(); await second.close();
    }
  });

  test("without a relay the game boots single-player with no lobby", async ({ page }) => {
    gateWorld("sf");
    await page.goto(`/?world=sf&gfx=default&pr=0.5&radius=250`);
    await page.waitForFunction(() => (window as unknown as NetWindow).__fogcity?.ready === true, null, { timeout: 150_000 });
    expect(await page.evaluate(() => (window as unknown as NetWindow).__fogcityNet?.available)).toBe(false);
    await expect(page.getByRole("button", { name: "Play with friends" })).toHaveCount(0);
    const tick = await page.evaluate(() => (window as unknown as NetWindow).__fogcity!.state().tick);
    await page.waitForFunction((t) => (window as unknown as NetWindow).__fogcity!.state().tick > t + 30, tick, { timeout: 60_000 });
  });
});
