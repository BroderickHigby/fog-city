// Full, input-only Coit acceptance from an explicitly seeded prior-campaign profile.
// Run only in the serialized CPU slot: node --max-old-space-size=2048 scripts/qa/coit-recon.ts --out test-results/coit-first
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { loadWorld } from "../../tests/helpers.ts";
import { CoitReconDriver } from "../../tests/helpers/drivers/coit-recon.ts";
import { savedAfterSpill, restoredState } from "../../tests/helpers/drivers/wave3-campaign.ts";
import { MISSIONS } from "../../src/content/catalog.ts";
import { DEFAULT_CATALOG } from "../../src/sim/player/catalog.ts";
import { createGameSystems, dodgeExtOf, hashState, type SimInput, type SimState } from "../../src/sim/index.ts";
import { agentsRuntimeOf } from "../../src/sim/agents/runtime.ts";
import { coitCameraPose, coitFidelityAnchors, coitGuideVoice, coitSessionActive, type CoitViewerSession } from "../../src/sim/activities/coit-viewer.ts";
import { coitLineOfSight, coitPlayerContext } from "../../src/sim/activities/coit-observation.ts";
import { nextCampaignMission } from "../../src/ui/campaign.ts";
import { MemorySaveBackend, SaveStore } from "../../src/save/store.ts";
import { validateSavedProgression } from "../../src/save/progression.ts";
import type { GameplayCommandPayload, GameplayEvent } from "../../src/sim/gameplay-contract.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, "max-frames": { type: "string", default: "120000" }, "deadline-seconds": { type: "string", default: "1800" } } });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
assert(values.out, "--out is required");
const maxFrames = Number(values["max-frames"]), deadlineMs = Number(values["deadline-seconds"]) * 1000;
assert(Number.isSafeInteger(maxFrames) && maxFrames > 0 && maxFrames <= 120000, "max-frames must be1..120000");
assert(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 1800000, "fixed deadline must be1..1800s");
const root = fileURLToPath(new URL("../../", import.meta.url)), out = resolve(values.out), began = performance.now();
assert(out !== root && !root.startsWith(out + "/"), "Output cannot contain the checkout");
mkdirSync(out, { recursive: true }); assert(!existsSync(join(out, "proof.json")), "Preserve earlier evidence; use a fresh output directory");
const json = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function source() {
  const selected = ["src/sim", "src/content", "src/save", "src/io", "src/geo", "src/ui/campaign.ts", "src/ui/coit-viewer.ts", "src/audio/index.ts", "content", "schemas", "public/tiles/sf", "public/audio/coit", "tests/helpers.ts", "tests/helpers/drivers", "tests/e2e/gameplay-driver.ts", "tests/e2e/campaign-driver.ts", "scripts/qa/coit-recon.ts"];
  // An isolated acceptance copy deliberately has no Git checkout. Resolve its
  // inputs from the sealed inventory instead of accidentally finding the live
  // ancestor repository and recording an empty input list.
  const sealPath = join(root, "immutable-source.json");
  if (existsSync(sealPath)) {
    const seal = JSON.parse(readFileSync(sealPath, "utf8")) as { branch: string; revision: string; main: string; status: string; files: { path: string; sha256: string }[] };
    assert(seal.files.length > 0, "Immutable source inventory is empty");
    for (const entry of seal.files) {
      assert(!entry.path.startsWith("/") && !entry.path.split("/").includes(".."), "Unsafe immutable source path");
      assert(digest(readFileSync(join(root, entry.path))) === entry.sha256, "Immutable source changed: " + entry.path);
    }
    const paths = seal.files.map(entry => entry.path).filter(path => selected.some(prefix => path === prefix || path.startsWith(prefix + "/")) && /\.(ts|json|bin|mp3)$/.test(path) && path !== "src/save/graphics-checkpoint.ts").sort();
    assert(paths.includes("scripts/qa/coit-recon.ts") && paths.some(path => path.startsWith("public/tiles/sf/")), "Immutable source omits harness or SF world");
    const hash = createHash("sha256");
    for (const path of paths) hash.update(path + "\0").update(readFileSync(join(root, path))).update("\0");
    return { branch: seal.branch, revision: seal.revision, main: seal.main, paths, sha256: hash.digest("hex"), status: seal.status };
  }
  const paths = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...selected], { cwd: root, encoding: "utf8" }).split("\0")
    .filter(path => path && /\.(ts|json|bin|mp3)$/.test(path) && path !== "src/save/graphics-checkpoint.ts"))].sort();
  const hash = createHash("sha256");
  for (const path of paths) if (existsSync(join(root, path))) hash.update(path + "\0").update(readFileSync(join(root, path))).update("\0");
  return { branch: git("branch", "--show-current"), revision: git("rev-parse", "HEAD"), main: git("rev-parse", "origin/main"), paths, sha256: hash.digest("hex"), status: git("status", "--porcelain") };
}
const report = { scope: "Full Coit Node activity acceptance from seeded prior-campaign completion IDs at the FiDi safehouse. Not a new-game/campaign playthrough, browser, audible playback or production acceptance.",
  startedAt: new Date().toISOString(), completedAt: "", world: "sf", wave: 4, seed: 1, maxFrames, deadlineMs, phase: "initializing", passed: false, failure: null as string | null,
  sourceStart: null as ReturnType<typeof source> | null, sourceEnd: null as ReturnType<typeof source> | null,
  seededBoundary: { priorCompletedIds: [] as string[], disclosure: "Prior campaign completion IDs are deliberately seeded so the ordinary page has no automatic campaign to interrupt Coit. Wallet/reward ledger remain the disclosed savedAfterSpill fixture values. No Coit progress, targets, behavior or completion is seeded." },
  stateReplacementCallsDuringPlay: 0, teleportCalls: 0, actorInjectionCalls: 0, evidenceInjectionCalls: 0, completionInjectionCalls: 0, rewindAttempts: 0,
  frames: 0, commands: 0, initialTick: 0, initialHash: "", completionTick: 0, completionHash: "", finalTick: 0, finalHash: "", walletBeforeViewings: 0, walletAfter: 0,
  activityEvents: [] as GameplayEvent[], actualBehavior: [] as unknown[], actualTagProofs: [] as unknown[],
  captions: [] as { tick: number; sessionId: number; id: string; text: string; file: string | null }[],
  captionScope: "Expected queue IDs/text derived from actual recorded viewer state and the same coitGuideVoice helper used by UI; actual browser voice queue/audio playback remains pending.",
  latestViewer: null as CoitViewerSession | null, clearance: null as ReturnType<typeof dodgeExtOf> | null, trace: [] as string[], diagnostics: null as unknown, outputHashes: {} as Record<string, string> };
const flush = () => json("proof.json", report); flush();
let manifest: { lines: { id: string; text: string; file: string; sha256: string }[] } = { lines: [] };
class RecordedCoitDriver extends CoitReconDriver {
  private observed = this.state.tick;
  private nextProgress = this.state.tick;
  private captionKey = "";
  private fatal: Error | undefined;
  private lastInput: SimInput | undefined;
  private guard(): void {
    if (this.fatal) throw this.fatal;
    const reason = this.frames.length >= maxFrames ? "Coit recorded input cap reached" : performance.now() - began > deadlineMs ? "Coit fixed wall-clock deadline reached" : "";
    if (reason) { this.fatal = new Error(reason); throw this.fatal; }
  }
  private observe(): void {
    if (this.observed === this.state.tick) return; this.observed = this.state.tick;
    const viewer = this.viewer;
    if (viewer) {
      report.latestViewer = viewer;
      if (coitSessionActive(viewer, this.state.tick)) {
        const line = coitGuideVoice(viewer), key = `${viewer.startedTick}:${viewer.guide?.id ?? "intro"}:${viewer.guide?.flagged ?? false}`;
        if (key !== this.captionKey) {
          this.captionKey = key; const clip = manifest.lines.find(clip => clip.id === line.id && clip.text === line.text);
          assert(clip && digest(readFileSync(join(root, "public", clip.file))) === clip.sha256, `Missing/stale generated guide asset for actual caption${line.id}`);
          report.captions.push({ tick: this.state.tick, sessionId: viewer.startedTick, ...line, file: clip.file });
        }
        if (viewer.evidenceTick === this.state.tick && viewer.observedBehavior) {
          const context = coitPlayerContext(this.state, this.world, this.playerId, this.lastInput), actor = agentsRuntimeOf(this.state)?.actors[viewer.observingId];
          report.actualBehavior.push({ tick: this.state.tick, id: viewer.observingId, behavior: viewer.observedBehavior, seen: context.actors.find(row => row.id === viewer.observingId),
            fidelity: actor?.fidelity, intent: actor?.intent?.action, anchor: coitFidelityAnchors(this.state, this.world), pose: coitCameraPose(this.world, viewer) });
        }
      }
    }
    for (const event of this.state.ext.activities?.events ?? []) if (event.playerId === this.playerId && (event.kind.startsWith("coit.") || event.kind.startsWith("recon.") || event.targetId === "coit-recon")) {
      report.activityEvents.push({ ...event });
      if (event.kind === "activity.finished" && event.targetId === "coit-recon") { report.completionTick = this.state.tick; report.completionHash = hashState(this.state); json("completion.json", this.state); }
      if (event.kind === "coit.robotTagged") {
        const actor = agentsRuntimeOf(this.state)?.actors[event.targetId], previousViewer = this.previousState.ext.activities?.players[this.playerId]?.recon?.viewer;
        assert(actor && viewer && previousViewer, "A tag lacks its actual runtime/session predecessor");
        const pose = coitCameraPose(this.world, viewer), distance = Math.hypot(actor.x - this.body.x, actor.z - this.body.z), clear = coitLineOfSight(this.world, pose, { ...actor, y: actor.y + actor.height * .6 });
        assert(actor.fidelity === "full" && distance >= 180 && clear && previousViewer.observedBehavior && previousViewer.observedTicks >= 60, "Tag lacks actual remote full-fidelity behavior/3D sight");
        report.actualTagProofs.push({ event, distance, actor, viewer, previousViewer, pose, lineOfSight: clear, observed: coitPlayerContext(this.state, this.world, this.playerId, this.lastInput).actors.find(row => row.id === event.targetId) });
      }
    }
    const clearance = dodgeExtOf(this.state); if (clearance.contacts || clearance.failures) { this.fatal = new Error(`Protected-body failure:${JSON.stringify(clearance)}`); throw this.fatal; }
    if (this.state.tick >= this.nextProgress) {
      this.nextProgress = this.state.tick + 1800;
      appendFileSync(join(out, "progress.jsonl"), JSON.stringify({ phase: report.phase, frame: this.frames.length, tick: this.state.tick, body: this.body,
        active: this.own.activeActivityId, session: viewer?.startedTick, remaining: viewer ? viewer.untilTick - this.state.tick : null, tagged: viewer?.taggedIds,
        guide: viewer?.guide, observing: viewer?.observingId, behavior: viewer?.observedBehavior, clearance }) + "\n");
    }
  }
  override input(input: SimInput): void { this.guard(); this.lastInput = input; try { super.input(input); } finally { this.observe(); } }
  override command(payload: Omit<GameplayCommandPayload, "sequence">, input?: SimInput): void {
    this.guard(); assert(payload.kind === "activity-start" || payload.kind === "coit-viewer", `Acceptance refuses command${payload.kind}`);
    this.lastInput = input; try { super.command(payload, input); } finally { this.observe(); }
  }
  override rewind(_mark: ReturnType<CoitReconDriver["mark"]>): void { report.rewindAttempts++; throw new Error("Recorded acceptance refuses rewind"); }
}
let driver: RecordedCoitDriver | undefined;
try {
  manifest = JSON.parse(readFileSync(join(root, "public/audio/coit/manifest.json"), "utf8")) as typeof manifest;
  report.sourceStart = source(); report.phase = "loading-real-sf"; flush();
  const { world, manifest: worldManifest } = loadWorld("sf", { roads: true }), systems = createGameSystems({ wave: 4 });
  const seed = savedAfterSpill(world, systems, worldManifest.spawn), baseMissions = seed.missions as { completedIds: string[]; rewardedIds: string[] };
  report.seededBoundary.priorCompletedIds = MISSIONS.filter(mission => mission.campaign !== undefined && (mission.wave ?? 2) <= 4).map(mission => mission.id);
  const progression = validateSavedProgression({ ...seed, missions: { ...baseMissions, completedIds: report.seededBoundary.priorCompletedIds } });
  assert(!nextCampaignMission(report.seededBoundary.priorCompletedIds, 4), "Seeded boundary still has a pending ordinary automatic campaign");
  json("seeded-prior-campaign-progression.json", progression);
  const store = new SaveStore({ backends: [new MemorySaveBackend()], contentHash: "qa-coit-seeded-prior-campaign", now: () => 0, validate: validateSavedProgression });
  await store.save(1, progression); writeFileSync(join(out, "seeded-prior-campaign-import.json"), await store.export(1));
  const initial = restoredState(world, systems, progression, worldManifest.spawn);
  assert(initial.ext.player?.players.p1?.safehouseId === "fidi-desk" && !initial.ext.activities?.players.p1?.recon, "Unexpected initial restore boundary");
  report.initialTick = initial.tick; report.initialHash = hashState(initial); json("initial.json", initial);
  driver = new RecordedCoitDriver(world, initial, "p1", systems, { sequence: 1, budget: maxFrames });
  report.phase = "walking-fidi-to-coit-path"; flush(); driver.reachStart();
  report.phase = "starting-and-walking-to-authored-viewer"; flush(); driver.startAndReachViewer(); json("at-viewer.json", driver.state);
  report.walletBeforeViewings = driver.state.ext.economy!.players.p1!.cashCents;
  report.phase = "actual-late-flag-failure-and-close"; flush(); driver.proveLateFlagAndRetry(); json("failed-first-viewing.json", driver.state);
  report.phase = "paid-retry-real-behavior-and-guide-flag"; flush(); driver.completePaidViewing();
  report.phase = "actual-return-and-cooldown-refusal"; flush(); driver.verifyRestartCooldown();
  const events = report.activityEvents, activity = DEFAULT_CATALOG.activities.find(activity => activity.id === "coit-recon")!;
  const fees = events.filter(event => event.kind === "activity.cash" && event.amount < 0), rewards = events.filter(event => event.kind === "activity.cash" && event.amount > 0);
  assert(fees.length === 2 && fees.every(event => event.amount === -25), "Expected exactly two real quarter purchases including the deliberate failed viewing");
  assert(rewards.length === 1 && rewards[0]!.amount === activity.rewardCents, "Authored activity payout did not settle exactly once");
  assert(events.filter(event => event.kind === "activity.xp").length === 1 && events.find(event => event.kind === "activity.xp")!.amount === activity.rewardXp, "XP did not settle exactly once");
  const opens = events.filter(event => event.kind === "coit.viewerOpened"), completion = events.filter(event => event.kind === "recon.viewerCompleted");
  assert(opens.length === 2 && completion.length === 1 && completion[0]!.tick - opens[1]!.tick === 1800, "Successful viewer did not run its paid thirty seconds");
  assert(events.filter(event => event.kind === "coit.hallucinationFlagged").length === 1 && events.filter(event => event.kind === "coit.robotTagged").length >= 1 && report.actualTagProofs.length >= 1, "Missing real behavioral tag or timely correction");
  assert(events.filter(event => event.kind === "activity.finished").length === 1 && !events.some(event => event.kind === "activity.failed"), "Activity failed or settled repeatedly");
  assert(driver.own.completedIds.filter(id => id === "coit-recon").length === 1 && driver.own.objectiveCount === 1, "Coit completion/counter is inconsistent");
  assert(driver.state.ext.economy!.players.p1!.cashCents - report.walletBeforeViewings === activity.rewardCents! - 50, "Actual wallet change does not equal one payout minus two quarters");
  assert(report.rewindAttempts === 0 && dodgeExtOf(driver.state).contacts === 0 && dodgeExtOf(driver.state).failures === 0, "Control/physical acceptance boundaries failed");
  report.passed = true; report.phase = "complete";
} catch (error) { report.failure = error instanceof Error ? error.stack ?? error.message : String(error); process.exitCode = 1; }
finally {
  if (driver) {
    report.frames = driver.frames.length; report.commands = driver.commands.length; report.finalTick = driver.state.tick; report.finalHash = hashState(driver.state);
    report.walletAfter = driver.state.ext.economy?.players.p1?.cashCents ?? 0; report.trace = [...driver.trace]; report.clearance = dodgeExtOf(driver.state);
    json("final.json", driver.state); json("previous.json", driver.previousState); json("frames.json", driver.frames); json("commands.json", driver.commands);
    json("events.json", report.activityEvents); json("expected-captions.json", { scope: report.captionScope, lines: report.captions });
    report.diagnostics = report.passed ? null : { body: driver.body, mission: driver.progress, own: driver.own, viewer: driver.viewer,
      visible: coitPlayerContext(driver.state, driver.world, "p1", driver.viewerInput()), anchors: coitFidelityAnchors(driver.state, driver.world),
      lastInput: driver.frames.at(-1), nearbyActors: Object.keys(agentsRuntimeOf(driver.state)?.actors ?? {}).sort().map(id => agentsRuntimeOf(driver!.state)!.actors[id]!).filter(actor => Math.hypot(actor.x - driver!.body.x, actor.z - driver!.body.z) <= 160) };
  }
  try { report.sourceEnd = source(); if (report.sourceStart?.sha256 !== report.sourceEnd.sha256) { report.passed = false; report.failure = [report.failure, "Source/data fingerprint changed during acceptance"].filter(Boolean).join("\n"); process.exitCode = 1; } }
  catch (error) { report.passed = false; report.failure = [report.failure, String(error)].filter(Boolean).join("\n"); process.exitCode = 1; }
  report.completedAt = new Date().toISOString();
  for (const name of ["initial.json", "at-viewer.json", "completion.json", "final.json", "previous.json", "frames.json", "commands.json", "events.json", "expected-captions.json", "seeded-prior-campaign-import.json"]) if (existsSync(join(out, name))) report.outputHashes[name] = digest(readFileSync(join(out, name)));
  flush(); console.log(JSON.stringify({ out, passed: report.passed, phase: report.phase, frames: report.frames, commands: report.commands, tags: report.actualTagProofs.length, finalHash: report.finalHash, failure: report.failure?.split("\n")[0] ?? null }));
}
