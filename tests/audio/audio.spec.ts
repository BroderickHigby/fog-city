// The game's audio in a real browser, driven by real keyboard and pointer input: subtitles show
// the opening mission lines; the first key unlocks audio; music follows the context (menu, the
// car radio with M / Shift+M tuning, combat on foot) and streams; H sounds the horn; the settings panel changes and persists the mix; driving into
// the Ferry Building plaza advances Hot Desk, and its next lines play as voice (ducking the music)
// or, when the file is missing, retry and fall back to subtitles that show even with subtitles
// turned off. Voice files are not generated yet (ElevenLabs is held on a free tier), so the
// manifest is patched to point two lines at a test tone and a missing file.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {} from "../../src/debug.ts";
import type {} from "../../src/audio/index.ts";
import type { VoiceManifest } from "../../src/audio/voice-lines.ts";
import { toLocal } from "../../src/geo/project.ts";
import { MAX_ROBOT_VOICES, ROBOT_HEAR_M, ROBOT_VOICES } from "../../src/audio/robot-sound.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const TONE = readFileSync(join(import.meta.dirname, "fixtures", "tone-6s.ogg"));
const PLAZA = toLocal(37.7954, -122.394);
const VOICED = "hot-desk.snatch.line0";
const BROKEN = "hot-desk.watch.line0";

const audio = (page: Page) => page.evaluate(() => window.__fogcityAudio!.info());
const mission = (page: Page) => page.evaluate(() => {
  const p = window.__fogcity!.state().ext.missions?.players.p1 as { missionId?: string; stepId?: string } | undefined;
  return `${p?.missionId ?? ""}:${p?.stepId ?? ""}`;
});

async function bootGame(page: Page, errors: string[]): Promise<void> {
  await page.goto("/?world=sf&gfx=default&radius=300&pr=0.75");
  await page.waitForFunction(() => window.__fogcity?.ready && window.__fogcityAudio, {}, { timeout: 150_000 });
  expect(errors).toEqual([]);
}

/** Steer the car with held keys until it is within `radius` m of `to`, then brake. */
async function driveTo(page: Page, to: { x: number; z: number }, radius: number): Promise<void> {
  const held = new Set<string>();
  const hold = async (key: string, on: boolean): Promise<void> => {
    if (on && !held.has(key)) { await page.keyboard.down(key); held.add(key); }
    if (!on && held.has(key)) { await page.keyboard.up(key); held.delete(key); }
  };
  const deadline = Date.now() + 150_000;
  try {
    for (;;) {
      const car = await page.evaluate(() => window.__fogcity!.state().players.p1!.car);
      const dx = to.x - car.x, dz = to.z - car.z, d = Math.hypot(dx, dz);
      if (d < radius) break;
      if (Date.now() > deadline) throw new Error(`still ${d.toFixed(1)} m from the plaza`);
      const bearing = Math.atan2(dx, -dz);
      const off = Math.atan2(Math.sin(bearing - car.heading), Math.cos(bearing - car.heading));
      await hold("KeyW", true);
      await hold("KeyD", off > 0.15);
      await hold("KeyA", off < -0.15);
      await page.waitForTimeout(150);
    }
  } finally {
    for (const key of [...held]) await hold(key, false);
  }
  await page.keyboard.down("Space");
  await expect.poll(async () => page.evaluate(() => Math.abs(window.__fogcity!.state().players.p1!.car.speed)), { timeout: 30_000 }).toBeLessThan(1);
  await page.keyboard.up("Space");
}

test.use({ viewport: { width: 960, height: 540 } });

test("real controls play Hot Desk with subtitles, contextual music, the car radio, the horn, mixing and the voice fallback", async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Patch the shipped manifest: one line voiced by a test tone, the next pointing at a missing file.
  const manifest = JSON.parse(readFileSync(join(ROOT, "public/audio/voice/manifest.json"), "utf8")) as VoiceManifest;
  for (const line of manifest.lines) {
    if (line.id === VOICED) Object.assign(line, { file: "audio/voice/test-tone.ogg", durationS: 6, measured: true, cues: [{ startS: 0, endS: 6, text: line.text }] });
    if (line.id === BROKEN) line.file = "audio/voice/missing-line.ogg";
  }
  await page.route("**/audio/voice/manifest.json", (route) => route.fulfill({ json: manifest }));
  await page.route("**/audio/voice/test-tone.ogg", (route) => route.fulfill({ body: TONE, contentType: "audio/ogg" }));
  await page.route("**/audio/voice/missing-line.ogg", (route) => route.fulfill({ status: 404, body: "" }));

  await bootGame(page, errors);
  // Nothing sounds before a gesture; the opening lines show as subtitles anyway.
  expect((await audio(page)).unlocked).toBe(false);
  const subtitles = page.locator(".fc-subtitles");
  await expect(subtitles).toBeVisible({ timeout: 120_000 });
  await expect(subtitles).toContainText("Your cofounder:");
  await expect(subtitles).toContainText(/welcome to sf!!|bad robots look exactly/);
  expect((await audio(page)).subtitle?.mode).toBe("text");
  await page.screenshot({ path: "test-results/audio-subtitles.png" });

  // A real key: Escape opens the pause screen and unlocks audio. The radio (in the car at the
  // start) keeps playing under the menu, ducked: menus never switch the track.
  await page.keyboard.press("Escape");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await audio(page)).unlocked, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await audio(page)).music?.trackId, { timeout: 30_000 }).toBe("drive");
  await expect.poll(async () => (await audio(page)).music?.paused, { timeout: 30_000 }).toBe(false);
  expect((await audio(page)).music?.src).toMatch(/audio\/music\/drive\.(ogg|mp3)$/);
  const switchesAtPause = (await audio(page)).musicSwitches;
  await expect.poll(async () => (await audio(page)).effectsLoaded, { timeout: 30_000 }).toBe(14);
  // The paused game holds the line, and the dialog covers the subtitles.
  const held = (await audio(page)).voice.current;
  // Settings: the music slider by keyboard, subtitles off by click; both apply at once.
  const music = dialog.getByRole("slider", { name: "Music volume" });
  await music.focus();
  await music.press("Home");
  for (let i = 0; i < 40; i++) await music.press("ArrowRight");
  await expect.poll(async () => (await audio(page)).prefs.music).toBeCloseTo(0.4, 5);
  expect((await audio(page)).gains.music).toBeCloseTo(0.16, 5);
  await dialog.getByRole("checkbox", { name: "Show subtitles" }).uncheck();
  expect((await audio(page)).prefs.subtitles).toBe(false);
  await dialog.getByRole("checkbox", { name: "Mute effects" }).check();
  expect((await audio(page)).gains.effects).toBe(0);
  await dialog.getByRole("checkbox", { name: "Mute effects" }).uncheck();
  // Muted music stops streaming; unmuted, the same track resumes.
  await dialog.getByRole("checkbox", { name: "Mute music" }).check();
  await expect.poll(async () => (await audio(page)).music?.paused, { timeout: 30_000 }).toBe(true);
  await dialog.getByRole("checkbox", { name: "Mute music" }).uncheck();
  await expect.poll(async () => (await audio(page)).music?.paused, { timeout: 30_000 }).toBe(false);
  expect((await audio(page)).music?.trackId).toBe("drive");
  await expect(dialog.getByText(/Now playing: "Midnight Cruiser" by Zane Little Music \(CC0 1\.0\)/)).toBeVisible();
  // The whole pause screen visit, mutes included, switched nothing.
  expect((await audio(page)).musicSwitches).toBe(switchesAtPause);
  await page.screenshot({ path: "test-results/audio-settings.png" });
  expect((await audio(page)).voice.current).toBe(held);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Drive into the Ferry Building plaza with held keys: driving music, then the mission moves on.
  await page.keyboard.down("KeyW");
  await expect.poll(async () => (await audio(page)).musicContext, { timeout: 60_000 }).toBe("driving");
  // The car's live engine and road sound runs while driving.
  await expect.poll(async () => (await audio(page)).engine, { timeout: 30_000 }).toBe(true);
  await page.keyboard.up("KeyW");
  // In the car the radio plays: the station card shows; M and Shift+M tune.
  const radio = page.locator(".fc-radio");
  await expect.poll(async () => (await audio(page)).musicTrack, { timeout: 30_000 }).toBe("drive");
  await page.keyboard.press("KeyM");
  await expect(radio).toContainText("Series A 101.3", { timeout: 30_000 });
  await expect.poll(async () => (await audio(page)).music?.trackId, { timeout: 30_000 }).toBe("menu");
  expect((await audio(page)).station).toBe("series-a");
  await page.keyboard.press("Shift+KeyM");
  await expect(radio).toContainText("Runway FM 88.5", { timeout: 30_000 });
  await expect.poll(async () => (await audio(page)).music?.trackId, { timeout: 30_000 }).toBe("drive");
  await page.screenshot({ path: "test-results/audio-radio.png" });
  // H sounds one horn blast through the effects bus (src/audio/horn.ts reads the stepped input).
  const hornsBefore = (await audio(page)).effectsPlayed.horn ?? 0;
  await page.keyboard.press("KeyH");
  await expect.poll(async () => (await audio(page)).effectsPlayed.horn ?? 0, { timeout: 30_000 }).toBe(hornsBefore + 1);
  await driveTo(page, PLAZA, 30);
  await expect.poll(async () => mission(page), { timeout: 120_000 }).not.toBe("hot-desk:arrive");

  // The voiced line plays as voice: no subtitle (they are off), and the music ducks under it.
  await expect.poll(async () => (await audio(page)).voiceEvents.some((e) => e.kind === "start" && e.id === VOICED), { timeout: 120_000 }).toBe(true);
  await expect.poll(async () => { const a = await audio(page); return a.voice.current === VOICED && a.ducked && a.subtitle?.mode === "voice"; }, { timeout: 60_000 }).toBe(true);
  expect((await audio(page)).subtitleShown).toBe(false);
  await expect.poll(async () => (await audio(page)).voiceEvents.some((e) => e.kind === "end" && e.id === VOICED && e.mode === "voice"), { timeout: 60_000 }).toBe(true);
  // The missing file is retried, then its text shows even with subtitles off.
  await expect.poll(async () => (await audio(page)).voiceEvents.filter((e) => e.id === BROKEN).map((e) => e.kind), { timeout: 60_000 }).toEqual(expect.arrayContaining(["retry", "fallback"]));
  await expect.poll(async () => { const a = await audio(page); return a.voice.current === BROKEN && a.subtitleShown; }, { timeout: 30_000 }).toBe(true);
  await expect(subtitles).toContainText("hold your aim on it without spraying");
  expect((await audio(page)).ducked).toBe(false);
  await page.screenshot({ path: "test-results/audio-fallback.png" });

  // Out of the car: the door opens and shuts, the engine stops, and walking makes footsteps.
  await page.keyboard.press("KeyF");
  await expect.poll(async () => page.evaluate(() => window.__fogcity!.state().players.p1!.mode), { timeout: 30_000 }).toBe("foot");
  await expect.poll(async () => (await audio(page)).effectsPlayed["door-open"] ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await audio(page)).effectsPlayed["door-close"] ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await audio(page)).engine, { timeout: 30_000 }).toBe(false);
  await page.keyboard.down("KeyW");
  await expect.poll(async () => { const p = (await audio(page)).effectsPlayed; return (p["step-1"] ?? 0) + (p["step-2"] ?? 0) + (p["step-3"] ?? 0) + (p["step-4"] ?? 0); }, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  await page.keyboard.up("KeyW");
  // Robot servos: exactly the nearest active robots within earshot are voiced (up to three).
  await expect.poll(async () => {
    const [voices, inRange] = await page.evaluate(({ range, max, models }) => {
      const s = window.__fogcity!.state(), p = s.players.p1!, b = p.mode === "foot" && p.foot ? p.foot : p.car;
      const ext = s.ext as { robots?: { actors: Record<string, { id: string; model: string; x: number; z: number; retired: boolean }> }; combat?: { targets: Record<string, { phase: string }> } };
      const n = Object.values(ext.robots?.actors ?? {}).filter((a) => !a.retired && models.includes(a.model) && (ext.combat?.targets[a.id]?.phase ?? "active") === "active" && Math.hypot(a.x - b.x, a.z - b.z) <= range).length;
      return [window.__fogcityAudio!.info().robotVoices, Math.min(max, n)];
    }, { range: ROBOT_HEAR_M, max: MAX_ROBOT_VOICES, models: Object.keys(ROBOT_VOICES) });
    return voices === inRange;
  }, { timeout: 60_000 }).toBe(true);
  // The phone chimes open, and its buttons click.
  await page.keyboard.press("KeyP");
  await expect.poll(async () => (await audio(page)).effectsPlayed.phone ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect.poll(async () => (await audio(page)).effectsPlayed.click ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  // On foot, spraying: the spray loop plays and the music cuts to combat.
  await page.keyboard.down("KeyE");
  await expect.poll(async () => (await audio(page)).effectsPlayed.spray ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await audio(page)).musicContext, { timeout: 60_000 }).toBe("combat");
  await page.keyboard.up("KeyE");

  // A reload keeps the mix and starts the mission's lines afresh.
  await page.reload();
  await bootGame(page, errors);
  const after = await audio(page);
  expect(after.prefs).toMatchObject({ music: 0.4, subtitles: false, effectsMuted: false, station: "runway" });
  await expect.poll(async () => (await audio(page)).voiceEvents.some((e) => e.kind === "start" && e.id.startsWith("hot-desk.")), { timeout: 120_000 }).toBe(true);
  // Lines without audio (locked: no gesture yet) still show, subtitles off or not.
  await expect(subtitles).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});
