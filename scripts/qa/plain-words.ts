// Input-only SF acceptance, beginning with an explicitly seeded post-Spill progression save.
// node --max-old-space-size=2048 scripts/qa/plain-words.ts --out test-results/plain-words --max-frames 120000
// No browser, renderer, state replacement during play, actor injection or completion events.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { loadWorld } from "../../tests/helpers.ts";
import { PlainWordsDriver } from "../../tests/helpers/drivers/plain-words.ts";
import { restoredState, savedAfterSpill } from "../../tests/helpers/drivers/wave3-campaign.ts";
import { Action, createGameSystems, dodgeExtOf, hashState, type SimInput, type SimState } from "../../src/sim/index.ts";
import { playerPose } from "../../src/sim/ride.ts";
import { runtimeCombatActors } from "../../src/sim/agents/runtime.ts";
import { PLAIN_WORDS_BOARDS, PLAIN_WORDS_ID } from "../../src/sim/activities/plain-words.ts";
import { DEFAULT_CATALOG } from "../../src/sim/player/catalog.ts";
import { nextCampaignMission } from "../../src/ui/campaign.ts";
import type { GameplayCommandPayload, GameplayEvent } from "../../src/sim/gameplay-contract.ts";
import type { PlainWordsRun } from "../../src/sim/player/types.ts";
import type { CombatEvent } from "../../src/sim/combat-contract.ts";
import { MemorySaveBackend, SaveStore } from "../../src/save/store.ts";
import { validateSavedProgression } from "../../src/save/progression.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, "max-frames": { type: "string", default: "120000" }, "deadline-seconds": { type: "string", default: "600" }, help: { type: "boolean" } } });
if (values.help) {
  console.log("node --max-old-space-size=2048 scripts/qa/plain-words.ts --out <evidence-directory> [--max-frames 120000] [--deadline-seconds 600]\nInput-only SF activity acceptance from an explicitly seeded post-Spill save at the FiDi desk. Maximum120000 inputs; fixed wall-clock deadline up to1800s. Writes failures and exact replay inputs. Does not run a browser or certify a new-game campaign.");
  process.exit(0);
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
assert(values.out, "--out is required");
const maxFrames = Number(values["max-frames"]);
assert(Number.isSafeInteger(maxFrames) && maxFrames > 0 && maxFrames <= 120_000, "--max-frames must be an integer from1 to120000");
const deadlineSeconds = Number(values["deadline-seconds"]);
assert(Number.isSafeInteger(deadlineSeconds) && deadlineSeconds > 0 && deadlineSeconds <= 1800, "--deadline-seconds must be an integer from1 to1800");
const root = fileURLToPath(new URL("../../", import.meta.url)), out = resolve(values.out);
assert(out !== root && !root.startsWith(out + "/"), "Evidence must not overwrite or contain the checkout");
mkdirSync(out, { recursive: true });
const proofPath = join(out, "proof.json");
assert(!existsSync(proofPath), "Use a fresh --out directory to preserve earlier acceptance evidence");
const json = (name: string, value: unknown): void => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const digest = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
function source() {
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src/sim", "src/content", "src/save", "src/io", "src/geo", "src/ui/campaign.ts", "content", "schemas", "public/tiles/sf", "tests/helpers.ts", "tests/helpers/drivers", "tests/e2e/gameplay-driver.ts", "tests/e2e/campaign-driver.ts", "scripts/qa/plain-words.ts"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(path => path && /\.(ts|json|bin)$/.test(path) && path !== "src/save/graphics-checkpoint.ts");
  const hash = createHash("sha256");
  let files = 0;
  for (const path of [...new Set(paths)].sort()) {
    if (!existsSync(join(root, path))) continue;
    hash.update(path + "\0").update(readFileSync(join(root, path))).update("\0"); files++;
  }
  return { branch: git("branch", "--show-current"), revision: git("rev-parse", "HEAD"), main: git("rev-parse", "origin/main"),
    status: git("status", "--porcelain"), files, paths: [...new Set(paths)].sort(), sha256: hash.digest("hex") };
}

const began = performance.now(), deadlineMs = deadlineSeconds * 1000;
interface ControlProfile { frames: number; distanceM: number; forwardFrames: number; sprintFrames: number; fireFrames: number; turnOnlyFrames: number; idleFrames: number; firstTick: number; lastTick: number }
const report = {
  startedAt: new Date().toISOString(), completedAt: "", scope: "Bounded headless activity acceptance from a seeded post-Spill progression fixture; not a new-game/full-campaign playthrough, browser acceptance or performance clearance.",
  world: "sf", wave: 3, seed: 1, maxFrames, deadlineMs, phase: "initializing", passed: false,
  failure: null as string | null, boundFailure: null as string | null,
  sourceStart: null as ReturnType<typeof source> | null, sourceEnd: null as ReturnType<typeof source> | null,
  seededProgression: { fixture: "tests/helpers/drivers/wave3-campaign.ts:savedAfterSpill", restoredWith: "restoredState", priorCompletedMissions: ["hot-desk", "spill"],
    disclosure: "These two prior campaign completions and their wallet/reward progression are deliberately seeded fixture data. No Plain Words progress, actors or completion is seeded." },
  stateReplacementCallsDuringPlay: 0, teleportCalls: 0, actorInjectionCalls: 0, completionInjectionCalls: 0, rewindAttempts: 0,
  frameCount: 0, commandCount: 0, initialTick: null as number | null, finalTick: null as number | null,
  initialHash: null as string | null, finalHash: null as string | null,
  initialSpawn: null as unknown, activityStartTick: null as number | null,
  expectedSpinnerIds: [] as string[], boardWashes: [] as GameplayEvent[], spinnerRusts: [] as GameplayEvent[],
  combatHeaps: [] as CombatEvent[], settlements: [] as GameplayEvent[],
  uniqueBoardIds: [] as string[], uniqueSpinnerIds: [] as string[],
  walletAtActivityStart: null as number | null, walletAtEnd: null as number | null,
  finalActivity: null as unknown, clearance: null as ReturnType<typeof dodgeExtOf> | null,
  latestRun: null as PlainWordsRun | null, failureDiagnostics: null as unknown,
  trace: [] as string[], outputHashes: {} as Record<string, string>,
  controlProfile: {} as Record<string, ControlProfile>,
  replay: { status: "not independently replayed", initial: "initial.json", final: "final.json", frames: "frames.json", commands: "commands.json",
    format: "Apply frame[i] at initial.tick+i+1 using production createGameSystems({wave:3}); include only commands with that same tick. Compare final hash and complete state. Browser must use the same SF source/data fingerprint." },
};
const flush = (): void => json("proof.json", report);
flush();

class ObservedDriver extends PlainWordsDriver {
  private observedTick: number;
  private failure: Error | undefined;
  private nextSnapshot: number;
  private readonly scopes: string[] = [];
  private lastInput: SimInput | undefined;

  constructor(...args: ConstructorParameters<typeof PlainWordsDriver>) {
    super(...args); this.observedTick = this.state.tick; this.nextSnapshot = this.state.tick;
  }

  private guard(): void {
    if (this.failure) throw this.failure;
    const reason = this.frames.length >= maxFrames ? `Acceptance input limit reached: ${maxFrames}`
      : performance.now() - began > deadlineMs ? `Acceptance exceeded its fixed ${deadlineSeconds}s wall-clock deadline` : undefined;
    if (reason) { report.boundFailure = reason; this.failure = new Error(reason); throw this.failure; }
  }

  private observe(): void {
    if (this.observedTick === this.state.tick) return;
    this.observedTick = this.state.tick;
    const previous = this.previousState.players[this.playerId], current = this.state.players[this.playerId], input = this.lastInput;
    const distanceM = previous && current ? Math.hypot(playerPose(current).x - playerPose(previous).x, playerPose(current).z - playerPose(previous).z) : 0;
    for (const key of new Set(["overall", ...this.scopes])) {
      const profile = report.controlProfile[key] ??= { frames: 0, distanceM: 0, forwardFrames: 0, sprintFrames: 0, fireFrames: 0, turnOnlyFrames: 0, idleFrames: 0, firstTick: this.state.tick, lastTick: this.state.tick };
      profile.frames++; profile.distanceM += distanceM; profile.lastTick = this.state.tick;
      if (input) {
        if (input.throttle > 0) profile.forwardFrames++;
        if (input.throttle > 0 && (input.brake > .5 || (input.actions & Action.sprint) !== 0)) profile.sprintFrames++;
        if ((input.actions & Action.fire) !== 0) profile.fireFrames++;
        if (!input.throttle && Math.abs(input.steer) > .01) profile.turnOnlyFrames++;
        if (!input.throttle && Math.abs(input.steer) <= .01 && input.actions === 0) profile.idleFrames++;
      }
    }
    const own = this.state.ext.activities?.players[this.playerId];
    const run = own?.activeActivityId === PLAIN_WORDS_ID ? own.plainWords : undefined;
    if (run) {
      report.latestRun = run;
      if (!report.expectedSpinnerIds.length) report.expectedSpinnerIds = [...run.spinnerIds];
    }
    for (const event of this.state.ext.activities?.events ?? []) {
      if (event.playerId !== this.playerId) continue;
      if (event.kind === "board.washed") report.boardWashes.push({ ...event });
      if (event.kind === "plainWords.spinnerRusted") report.spinnerRusts.push({ ...event });
      if (event.targetId === PLAIN_WORDS_ID && ["activity.cash", "activity.xp", "activity.finished", "activity.failed"].includes(event.kind)) report.settlements.push({ ...event });
      if (event.targetId === PLAIN_WORDS_ID && event.kind === "activity.started") report.activityStartTick = event.tick;
    }
    for (const event of this.state.ext.combat?.events ?? []) {
      if (event.kind === "robot.heap" && event.sourceId === this.playerId && report.expectedSpinnerIds.includes(event.targetId)) report.combatHeaps.push({ ...event });
    }
    const clearance = dodgeExtOf(this.state);
    if (clearance.contacts || clearance.failures) this.failure = new Error(`Unsafe physical step at tick${this.state.tick}: ${JSON.stringify(clearance)}`);
    if (this.state.tick >= this.nextSnapshot) {
      this.nextSnapshot = this.state.tick + 1800;
      appendFileSync(join(out, "progress.jsonl"), JSON.stringify({ phase: report.phase, frame: this.frames.length, tick: this.state.tick,
        mode: this.state.players[this.playerId]!.mode, body: { x: this.body.x, y: this.body.y, z: this.body.z },
        active: own?.activeActivityId, washed: run?.washed, qualified: run?.boards.filter(board => board.qualified).map(board => board.id),
        rusted: run?.rusted, objectiveCount: own?.objectiveCount, clearance }) + "\n");
    }
  }

  override input(input: SimInput): void {
    this.guard();
    this.lastInput = input;
    try { super.input(input); } finally { this.observe(); }
  }

  override command(payload: Omit<GameplayCommandPayload, "sequence">, input?: SimInput): void {
    this.guard();
    this.lastInput = input ?? { throttle: 0, steer: 0, brake: 1, actions: 0 };
    assert(payload.kind === "activity-start" || payload.kind === "mission-start", `This acceptance cannot issue ${payload.kind}`);
    try { super.command(payload, input); } finally { this.observe(); }
  }

  override rewind(_mark: ReturnType<PlainWordsDriver["mark"]>): void {
    report.rewindAttempts++;
    throw new Error("Acceptance refuses planner rewinds; preserve every real physical input and failure");
  }

  private profiled<T>(scope: string, action: () => T): T {
    this.scopes.push(scope);
    try { return action(); } finally { this.scopes.pop(); }
  }
  override walkTo(...args: Parameters<PlainWordsDriver["walkTo"]>): void {
    this.profiled("walking", () => super.walkTo(...args));
  }
  override wash(board: Parameters<PlainWordsDriver["wash"]>[0]): void {
    this.profiled(`board:${board.id}`, () => super.wash(board));
  }
  override approachActor(id: string): void {
    this.profiled(`approach:${id}`, () => super.approachActor(id));
  }
  override meltActor(...args: Parameters<PlainWordsDriver["meltActor"]>): void {
    this.profiled(`fight:${args[0]}`, () => super.meltActor(...args));
  }
}

let driver: ObservedDriver | undefined, initial: SimState | undefined;
try {
  report.sourceStart = source();
  report.phase = "loading-real-sf"; flush();
  const { world, manifest } = loadWorld("sf", { roads: true });
  assert(performance.now() - began <= deadlineMs, "SF loading exceeded the acceptance deadline");
  const systems = createGameSystems({ wave: 3 });
  const seedSave = savedAfterSpill(world, systems, manifest.spawn);
  json("seeded-post-spill-progression.json", seedSave);
  const store = new SaveStore({ backends: [new MemorySaveBackend()], contentHash: "qa-plain-words-seeded-post-spill", now: () => 0, validate: validateSavedProgression });
  await store.save(1, seedSave);
  writeFileSync(join(out, "seeded-post-spill-import.json"), await store.export(1));
  initial = restoredState(world, systems, seedSave, manifest.spawn);
  assert(initial.ext.player?.players.p1?.safehouseId === "fidi-desk", "The seeded fixture did not restore at the FiDi safehouse");
  assert(!initial.ext.activities?.players.p1?.completedIds.includes(PLAIN_WORDS_ID), "Fixture unexpectedly includes Plain Words completion");
  assert(!initial.ext.activities?.players.p1?.plainWords, "Fixture unexpectedly includes an active Plain Words run");
  report.initialTick = initial.tick; report.initialHash = hashState(initial); report.initialSpawn = initial.players.p1!.car;
  json("initial.json", initial);
  driver = new ObservedDriver(world, initial, "p1", systems, { budget: maxFrames, sequence: 1 });
  // Match the page's ordinary post-load automatic campaign request; this is recorded for replay.
  const next = nextCampaignMission(initial.ext.missions?.players.p1?.completedIds ?? [], 3);
  if (next) driver.command({ kind: "mission-start", targetId: next.id });
  json("restore-command-applied.json", driver.state);
  report.phase = "walking-from-fidi-to-broadway"; flush();
  driver.toStart();
  report.phase = "playing-plain-words"; report.walletAtActivityStart = driver.state.ext.economy?.players.p1?.cashCents ?? null; flush();
  driver.play(() => driver!.command({ kind: "activity-start", targetId: PLAIN_WORDS_ID }));
  report.phase = "validating-actual-outcome";
  report.uniqueBoardIds = [...new Set(report.boardWashes.map(event => event.targetId))].sort();
  report.uniqueSpinnerIds = [...new Set(report.spinnerRusts.map(event => event.targetId))].sort();
  const authored = PLAIN_WORDS_BOARDS.map(board => board.id).sort();
  assert(JSON.stringify(report.uniqueBoardIds) === JSON.stringify(authored), `Expected all twenty distinct boards; saw ${JSON.stringify(report.uniqueBoardIds)}`);
  assert(report.boardWashes.length === authored.length, "A board emitted more than one qualification event");
  assert(report.expectedSpinnerIds.length === 4 && report.uniqueSpinnerIds.length === 4 && report.expectedSpinnerIds.every(id => report.uniqueSpinnerIds.includes(id)), "Not all four actual sign-spinners rusted");
  assert(report.expectedSpinnerIds.every(id => report.combatHeaps.some(event => event.targetId === id)), "Spinner credit lacks actual combat heap evidence");
  const own = driver.state.ext.activities!.players.p1!, activity = DEFAULT_CATALOG.activities.find(value => value.id === PLAIN_WORDS_ID)!;
  assert(own.activeActivityId === "" && own.completedIds.includes(PLAIN_WORDS_ID) && own.objectiveCount === 20, "Activity completion/counters do not match twenty distinct boards");
  const cash = report.settlements.filter(event => event.kind === "activity.cash"), xp = report.settlements.filter(event => event.kind === "activity.xp");
  assert(cash.length === 1 && cash[0]!.amount === activity.rewardCents, "Activity cash must settle exactly once for the authored amount");
  assert(xp.length === 1 && xp[0]!.amount === activity.rewardXp, "Activity XP must settle exactly once for the authored amount");
  assert(report.settlements.filter(event => event.kind === "activity.finished").length === 1 && !report.settlements.some(event => event.kind === "activity.failed"), "Activity did not finish exactly once without timeout");
  assert(driver.state.ext.dodge !== undefined, "Protected-body accounting is absent");
  const clearance = dodgeExtOf(driver.state);
  assert(clearance.contacts === 0 && clearance.failures === 0, "Protected-body contact or clearance failure occurred");
  assert(report.activityStartTick !== null && driver.state.tick - report.activityStartTick <= activity.timeLimitS! * 60, "Completion exceeded the authored five-minute simulation deadline");
  assert(report.rewindAttempts === 0 && driver.frames.length <= maxFrames, "Acceptance exceeded its input-only boundaries");
  assert(performance.now() - began <= deadlineMs, "Acceptance exceeded its wall-clock deadline");
  report.passed = true; report.phase = "complete";
} catch (error) {
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (driver) {
    report.frameCount = driver.frames.length; report.commandCount = driver.commands.length;
    report.finalTick = driver.state.tick; report.finalHash = hashState(driver.state);
    report.walletAtEnd = driver.state.ext.economy?.players.p1?.cashCents ?? null;
    report.finalActivity = driver.state.ext.activities?.players.p1 ?? null;
    report.clearance = dodgeExtOf(driver.state); report.trace = [...driver.trace];
    report.uniqueBoardIds = [...new Set(report.boardWashes.map(event => event.targetId))].sort();
    report.uniqueSpinnerIds = [...new Set(report.spinnerRusts.map(event => event.targetId))].sort();
    json("final.json", driver.state); json("previous.json", driver.previousState);
    json("frames.json", driver.frames); json("commands.json", driver.commands);
    const body = driver.body;
    const nearestBoards = PLAIN_WORDS_BOARDS.map(board => ({ ...board, distance: Math.hypot(board.x - body.x, board.z - body.z),
      progress: report.latestRun?.boards.find(value => value.id === board.id) })).sort((a, b) => a.distance - b.distance).slice(0, 4);
    report.failureDiagnostics = report.passed ? null : { phase: report.phase, body, nearestBoards,
      nearbyActors: runtimeCombatActors(driver.state).filter(actor => Math.hypot(actor.x - body.x, actor.z - body.z) <= 15)
        .map(actor => ({ ...actor, combat: driver!.state.ext.combat?.targets[actor.id] })),
      projectiles: driver.state.ext.combat?.projectiles.slice(0, 32), recentCombatEvents: driver.state.ext.combat?.events,
      lastFrame: driver.frames.at(-1), commandsAtLastTick: driver.commands.filter(command => command.tick === driver!.state.tick) };
  }
  try {
    report.sourceEnd = source();
    if (report.sourceStart?.sha256 !== report.sourceEnd.sha256) {
      report.passed = false; report.failure = [report.failure, "Source/data fingerprint changed during acceptance; rerun on a frozen candidate."].filter(Boolean).join("\n"); process.exitCode = 1;
    }
  } catch (error) {
    report.passed = false; report.failure = [report.failure, `Could not record final source: ${String(error)}`].filter(Boolean).join("\n"); process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  json("events.json", { boardWashes: report.boardWashes, spinnerRusts: report.spinnerRusts, combatHeaps: report.combatHeaps, settlements: report.settlements });
  json("control-profile.json", { note: "Profiles overlap: board scopes include their approach/walk/fight subscopes. Distances are sums of actual accepted body displacement, never planned route length.", profiles: report.controlProfile });
  for (const name of ["initial.json", "final.json", "previous.json", "frames.json", "commands.json", "events.json", "control-profile.json", "seeded-post-spill-import.json"]) {
    if (existsSync(join(out, name))) report.outputHashes[name] = digest(readFileSync(join(out, name)));
  }
  flush();
  console.log(JSON.stringify({ out, passed: report.passed, phase: report.phase, frames: report.frameCount, commands: report.commandCount,
    distinctBoards: report.uniqueBoardIds.length, spinners: report.uniqueSpinnerIds.length, finalHash: report.finalHash, failure: report.boundFailure ?? report.failure?.split("\n")[0] ?? null }));
}
