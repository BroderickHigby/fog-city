// Shared plumbing for the long real-SF playthroughs (tests/e2e/*.long.ts): the page's own save
// panel, feeding planned inputs, the page's dialogs, and one exact Node replay per page session.
import { expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { canonicalJson, hashState, type SimEvent, type SimState, type SimSystem, type World } from "../../src/sim/index.ts";
import { MemorySaveBackend, SaveStore, type ProgressionDocument } from "../../src/save/store.ts";
import { validateSavedProgression } from "../../src/save/progression.ts";
import { Wave3Driver } from "../helpers/drivers/wave3-campaign.ts";
import { simState, type FogWindow } from "./fixtures.ts";
import { p1Chunk, replay, withRecordedCommands, type Chunk } from "./replay.ts";

export const QUERY = "&radius=300&pr=0.75";

/** A save file exactly as the page's Export button writes it. */
export async function saveFile(data: ProgressionDocument): Promise<string> {
  const store = new SaveStore({ backends: [new MemorySaveBackend()], contentHash: "e2e", validate: validateSavedProgression });
  await store.save(0, data);
  return store.export(0);
}

async function openSaves(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open phone", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}
const slot = (page: Page, n: number) => page.locator(".fc-save-panel article").filter({ has: page.getByRole("heading", { name: `Save slot ${n}`, exact: true }) });
/**
 * A debug pause is authoritative (src/main.ts): closing a dialog leaves it in place, and a
 * command the UI queues waits for the next stepped tick. Hold it anyway after closing, so a
 * page that ever resumed on close could not run past the state Node plans from.
 */
export async function closeAndHold(page: Page): Promise<void> {
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
}
/** Apply what the UI just queued (a load's next mission, a dialog choice) with one neutral tick. */
export async function applyQueued(page: Page, kind: string): Promise<void> {
  await page.waitForFunction(kind => {
    const handle = (window as unknown as FogWindow).__fogcity!;
    return handle.commands!().some(event => event.tick === handle.state().tick + 1 && (event.payload as { kind?: string }).kind === kind);
  }, kind, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.stepN(1));
}
/** Import a save file into a slot with the page's Import button, then load it with Load. */
export async function importAndLoad(page: Page, text: string, n: number): Promise<void> {
  await openSaves(page);
  const chooser = page.waitForEvent("filechooser");
  await slot(page, n).getByRole("button", { name: "Import save", exact: true }).click();
  await (await chooser).setFiles({ name: `slot-${n}.json`, mimeType: "application/json", buffer: Buffer.from(text) });
  await page.locator(".fc-save-panel").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(slot(page, n).getByRole("button", { name: "Load progress", exact: true })).toBeEnabled();
  await loadSlot(page, n, false);
}
export async function loadSlot(page: Page, n: number, open = true): Promise<void> {
  if (open) await openSaves(page);
  await slot(page, n).getByRole("button", { name: "Load progress", exact: true }).click();
  await page.locator(".fc-save-panel").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator(".fc-save-panel [role=status]")).toHaveText("Done");
  await closeAndHold(page);
  // A load starts the next campaign mission with a queued command.
  await applyQueued(page, "mission-start");
}
export async function saveSlot(page: Page, n: number): Promise<void> {
  await openSaves(page);
  await slot(page, n).getByRole("button", { name: "Save progress", exact: true }).click();
  await expect(page.locator(".fc-save-panel [role=status]")).toHaveText("Progress saved");
  await closeAndHold(page);
}

/** Keep SwiftShader idle while Node plans; restore the real viewport even on failure. */
export async function quietly<T>(page: Page, run: () => T): Promise<T> {
  await page.setViewportSize({ width: 1, height: 1 });
  try { return run(); }
  finally { await page.setViewportSize({ width: 960, height: 540 }); }
}
/**
 * Feed planned inputs (and the commands another player's client would send, as events) to the
 * page in batches; the page must reach exactly the planned state.
 */
export async function feed(page: Page, driver: Wave3Driver, from = driver.state.tick - driver.frames.length): Promise<void> {
  let actual: SimState | undefined;
  for (let at = 0; at < driver.frames.length; at += 500) {
    const first = from + at + 1, last = from + Math.min(at + 500, driver.frames.length);
    const events = driver.commands.filter(event => event.playerId !== "p1" && event.tick >= first && event.tick <= last);
    actual = await page.evaluate(([batch, sent]) => {
      const handle = (window as unknown as FogWindow).__fogcity!;
      handle.stepFrames!(batch, sent);
      return handle.state();
    }, [driver.frames.slice(at, at + 500), events] as const);
  }
  expect(canonicalJson(actual ?? await simState(page))).toBe(canonicalJson(driver.state));
}
/** Click a dialog choice, step the tick that applies its queued command, and check it took (status:step or status). */
export async function choose(page: Page, dialog: string, label: string, applied: string): Promise<void> {
  await page.getByRole("dialog", { name: dialog, exact: true }).getByRole("button", { name: label, exact: true }).click();
  await page.waitForFunction(() => {
    const handle = (window as unknown as FogWindow).__fogcity!;
    return handle.commands!().some(event => event.tick === handle.state().tick + 1);
  }, undefined, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.stepN(1));
  await page.waitForFunction(check => {
    const progress = (window as unknown as FogWindow).__fogcity!.state().ext.missions?.players.p1;
    return `${progress?.status}:${progress?.stepId}` === check || progress?.status === check;
  }, applied);
}

/** Records every planned chunk, other players' commands and the idle ticks between, for one exact replay. */
export class Session {
  readonly chunks: Chunk[] = [];
  readonly initial: SimState;
  last: SimState;
  readonly world: World;
  readonly systems: readonly SimSystem[];
  constructor(world: World, systems: readonly SimSystem[], initial: SimState) { this.world = world; this.systems = systems; this.initial = initial; this.last = initial; }
  plan(state: SimState, name: string, run: (driver: Wave3Driver) => void, options: ConstructorParameters<typeof Wave3Driver>[4] & { playerId?: string } = {}): Wave3Driver {
    if (state.tick > this.last.tick) this.chunks.push(p1Chunk(state.tick - this.last.tick));
    const driver = new Wave3Driver(this.world, state, options.playerId ?? "p1", this.systems, options);
    try { run(driver); }
    catch (error) {
      writeFileSync(`test-results/${name}-repro.json`, JSON.stringify({ state: driver.state, previousState: driver.previousState, trace: driver.trace }));
      throw new Error(`${(error as Error).message}\n${driver.trace.slice(-12).join("\n")}`);
    }
    this.chunks.push({ frames: driver.frames, events: driver.commands.filter(event => event.playerId !== "p1") });
    this.last = driver.state;
    return driver;
  }
  /** Extra events this page session applied (a remote player's join), so the replay applies them too. */
  note(frames: Chunk["frames"], events: readonly SimEvent[], after: SimState): void {
    this.chunks.push({ frames, events });
    this.last = after;
  }
  async verify(page: Page, label: string): Promise<SimState> {
    const final = await simState(page);
    if (final.tick > this.last.tick) this.chunks.push(p1Chunk(final.tick - this.last.tick));
    this.last = final;
    const commands = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.commands!());
    // A command queued for a tick the page has not stepped yet (the next mission after a
    // completion) is not part of this session.
    const recorded = withRecordedCommands(this.chunks, this.initial.tick, commands.filter(command => command.tick > this.initial.tick && command.tick <= final.tick) as SimEvent[]);
    const actual = await quietly(page, () => hashState(replay(this.world, this.initial, recorded, this.systems).final));
    const expected = hashState(final);
    writeFileSync(`test-results/${label}-replay-proof.json`, JSON.stringify({
      initialTick: this.initial.tick, finalTick: final.tick, inputFrames: recorded.reduce((n, c) => n + c.frames.length, 0),
      commands: commands.length, actualHash: actual, expectedHash: expected, matches: actual === expected,
    }, null, 2));
    expect(actual, `${label}: Node replay of the browser session`).toBe(expected);
    expect(final.ext.dodge).toMatchObject({ contacts: 0, failures: 0 });
    return final;
  }
}
