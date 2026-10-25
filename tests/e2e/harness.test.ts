// Unit tests (Vitest) for the harness's own helpers: the PNG decoder behind blank-frame
// checks, the geometry used by the SF road check, and the determinism scenario's coverage.
// Playwright ignores this file (it only runs *.spec.ts).

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonicalJson, createGameSystems, createInitialState, hashState, step, type GameplayWorldData } from "../../src/sim/index.ts";
import type { PipelineSidewalks } from "../../src/sim/agents/pipeline-navigation.ts";
import type { TransitLayer } from "../../src/sim/agents/transit-runtime.ts";
import { ROOT, buildWorldWithRoads, loadWorldFiles, readJson } from "../helpers.ts";
import { dmathDigest, makeWorld, recordSession, runScenario } from "./determinism-scenario.ts";
import { distanceToPolyline, headingDelta } from "./fixtures.ts";
import { decodePng, imageStats, looksDrawn } from "./png.ts";
import { PREREQUISITES, parseRequire } from "./prereq.ts";
import { COLLIDERS_ONLY, WITH_ROADS, matchGame, p1Chunk, replay, withRecordedCommands } from "./replay.ts";
import { GameplayDriver } from "./gameplay-driver.ts";

function chunk(type: string, body: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(body)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb) >>> 0);
  return Buffer.concat([len, tb, crc]);
}

/** Encode with the given filter on each row (cycling), so the decoder sees every filter type. */
function encodePng(width: number, height: number, channels: number, data: Uint8Array, filters: number[]): Buffer {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels]!;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length]!;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = data[y * stride + i]!;
      const a = i >= channels ? data[y * stride + i - channels]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + i]! : 0;
      const c = i >= channels && y > 0 ? data[(y - 1) * stride + i - channels]! : 0;
      const p = a + b - c;
      const pred =
        f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1
        : Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe("png decoder", () => {
  for (const channels of [1, 2, 3, 4]) {
    it(`round-trips ${channels}-channel images through all five filter types`, () => {
      const [w, h] = [37, 23];
      const data = noise(w * h * channels, channels * 7919);
      const img = decodePng(encodePng(w, h, channels, data, [0, 1, 2, 3, 4]));
      expect([img.width, img.height, img.channels]).toEqual([w, h, channels]);
      expect(Buffer.from(img.data).equals(Buffer.from(data))).toBe(true);
    });
  }

  it("rejects what it cannot decode", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/not a PNG/);
    const png = encodePng(2, 2, 3, new Uint8Array(12), [0]);
    png[8 + 8 + 8] = 16; // IHDR bit depth
    expect(() => decodePng(png)).toThrow(/unsupported/);
  });

  it("tells a flat frame from a drawn one", () => {
    const flat = decodePng(encodePng(64, 64, 4, new Uint8Array(64 * 64 * 4).fill(200), [0]));
    expect(looksDrawn(imageStats(flat))).toBe(false);
    const drawn = decodePng(encodePng(64, 64, 3, noise(64 * 64 * 3, 1), [4]));
    expect(looksDrawn(imageStats(drawn))).toBe(true);
    expect(imageStats(flat).std).toBeLessThan(1e-6);
  });
});

describe("geometry helpers", () => {
  it("distanceToPolyline measures to the nearest segment, including its ends", () => {
    const line: Array<[number, number]> = [[0, 0], [10, 0], [10, 10]];
    expect(distanceToPolyline(5, 3, line)).toBeCloseTo(3, 12);
    expect(distanceToPolyline(13, 5, line)).toBeCloseTo(3, 12);
    expect(distanceToPolyline(-4, -3, line)).toBeCloseTo(5, 12);
  });

  it("headingDelta is the short way round", () => {
    expect(headingDelta(0.1, 6.2)).toBeCloseTo(6.2 - 0.1 - 2 * Math.PI, 12);
    expect(headingDelta(6.2, 0.1)).toBeCloseTo(0.1 + 2 * Math.PI - 6.2, 12);
    expect(headingDelta(1, 1.5)).toBeCloseTo(0.5, 12);
  });
});

describe("determinism scenario", () => {
  const dev = loadWorldFiles("dev");
  const opts = { ticks: 3600, checkpointEvery: 15, seed: 20261020, spawn: dev.manifest.spawn };

  it("is a strong test: several players, joins and leaves, steering and collisions", () => {
    const r = runScenario(makeWorld(dev.tiles, dev.roads), opts);
    expect(r.checkpoints).toHaveLength(opts.ticks / opts.checkpointEvery);
    expect(r.stats.playersSeen).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(r.stats.hits).toBeGreaterThan(0);
    expect(r.stats.turned).toBeGreaterThan(5);
    expect(r.stats.maxSpeed).toBeGreaterThan(15);
  });

  it("repeats exactly in one engine (the cross-engine test compares against this)", () => {
    const a = runScenario(makeWorld(dev.tiles, dev.roads), { ...opts, ticks: 900 });
    const b = runScenario(makeWorld(dev.tiles, dev.roads), { ...opts, ticks: 900 });
    expect(b.checkpoints).toEqual(a.checkpoints);
    expect(b.finalJson).toBe(a.finalJson);
  });

  it("dmath digest is stable within an engine and covers every function", () => {
    const d = dmathDigest(2000);
    expect(Object.keys(d).sort()).toEqual(["datan", "datan2", "dcos", "dsin", "dtan", "hashState", "sqrt", "wrapAngle"]);
    expect(dmathDigest(2000)).toEqual(d);
  });
});

describe("the running-game replay (replay.ts, recordSession)", () => {
  const dev = loadWorldFiles("dev");
  const world = makeWorld(dev.tiles, null);
  // A "game" that booted and ran 25 neutral ticks with only p1, like the real one.
  let s0 = createInitialState(world, 1, ["p1"], dev.manifest.spawn);
  for (let i = 0; i < 25; i++) s0 = step(world, s0, {});

  it("replays the explicit game registry and detects a registry accidentally omitted by the harness", () => {
    const gameWorld = makeWorld(dev.tiles, dev.roads);
    const gameSystems = createGameSystems();
    const initial = createInitialState(gameWorld, 1, ["p1"], dev.manifest.spawn);
    const chunks = [p1Chunk(3), p1Chunk(4)];
    const game = replay(gameWorld, initial, chunks, gameSystems);
    const matched = matchGame("dev", initial, chunks, game.hashes, game.final, createGameSystems());
    expect(matched.match?.label).toBe(WITH_ROADS);
    expect(matched.match?.final).toEqual(game.final);
    expect(matchGame("dev", initial, chunks, game.hashes, game.final).match).toBeUndefined();
    expect(game.final.ext.clock).toBeDefined();
    expect(initial.ext.clock).toBeUndefined();
  });

  it("places delayed UI commands in their correct replay chunk without duplicating explicit events", () => {
    const gameWorld = makeWorld(dev.tiles, dev.roads);
    const initial = createInitialState(gameWorld, 1, ["p1"], dev.manifest.spawn);
    const command = { tick: 3, kind: "gameplay.command", playerId: "p1", payload: { sequence: 1, kind: "buy", itemId: "tank-1", targetId: "fidi-desk" } } as const;
    const chunks = [p1Chunk(2), p1Chunk(2)];
    const recorded = withRecordedCommands(chunks, 0, [command]);
    expect(recorded[0]!.events).toEqual([]);
    expect(recorded[1]!.events).toEqual([command]);
    expect(withRecordedCommands(recorded, 0, [command])).toEqual(recorded);
    const game = replay(gameWorld, initial, recorded, createGameSystems());
    expect(game.final.ext.economy?.players.p1?.commandSequence).toBe(1);
    expect(replay(gameWorld, initial, chunks, createGameSystems()).final.ext.economy?.players.p1?.commandSequence).toBe(0);
    expect(matchGame("dev", initial, recorded, game.hashes, game.final, createGameSystems()).match).toBeDefined();
  });

  it("recordSession joins p2 and p3 on its first tick and stamps every event with its absolute tick", () => {
    const chunks = recordSession(["p1"], s0.tick, { ticks: 1800, seed: 20261020, spawn: dev.manifest.spawn }, 60);
    expect(chunks).toHaveLength(30);
    expect(chunks.reduce((n, c) => n + c.frames.length, 0)).toBe(1800);
    const events = chunks.flatMap((c) => c.events);
    expect(events.slice(0, 2).map((e) => [e.tick, e.kind, e.playerId])).toEqual([
      [26, "player.join", "p3"],
      [26, "player.join", "p2"],
    ]);
    expect(events.map((e) => e.tick)).toEqual([26, 26, 25 + 120, 25 + 1500]);
    // step() throws on an event for the wrong tick, so this also proves the stamping.
    const r = replay(world, s0, chunks);
    expect(r.hashes).toHaveLength(30);
    expect(r.final.tick).toBe(25 + 1800);
    expect(Object.keys(r.final.players).sort()).toEqual(["p1", "p3", "p4"]);
    expect(r.final.players.p1!.car.hits, "p1's script rams the dev wall").toBeGreaterThan(0);
  });

  it("matchGame finds the game's world, and reports where a different game parts from Node", () => {
    // A game built as the manifest says (with the road graph: traffic on sim v2).
    const roadsWorld = makeWorld(dev.tiles, dev.roads);
    let g0 = createInitialState(roadsWorld, 1, ["p1"], dev.manifest.spawn);
    for (let i = 0; i < 25; i++) g0 = step(roadsWorld, g0, {});
    const chunks = [p1Chunk(60, { throttle: 1, steer: 0.3, brake: 0, actions: 0 }), p1Chunk(30)];
    const game = replay(roadsWorld, g0, chunks);
    const ok = matchGame("dev", g0, chunks, game.hashes, game.final);
    expect(ok.expected).toBe(WITH_ROADS);
    expect(ok.match?.label).toBe(WITH_ROADS);

    // The same run, but the game's car ended 1 mm further east: no construction matches.
    const moved = structuredClone(game.final);
    moved.players.p1!.car.x += 0.001;
    const bad = matchGame("dev", g0, chunks, [game.hashes[0]!, hashState(moved)], moved);
    expect(bad.match).toBeUndefined();
    expect(bad.tried).toHaveLength(2);
    expect(bad.tried.join("\n")).toMatch(/first divergence after chunk 1 .*final states differ at offset/);
  });

  it("matchGame names a game that dropped the road graph, when the sim can tell", () => {
    // `world` is colliders only, as the game's main.ts built it before it passed the road graph.
    const chunks = [p1Chunk(90, { throttle: 1, steer: -0.2, brake: 0, actions: 0 })];
    const game = replay(world, s0, chunks);
    const m = matchGame("dev", s0, chunks, game.hashes, game.final);
    expect(m.match).toBeDefined();
    // A sim without traffic (v1) cannot tell the two worlds apart; with traffic (v2) it must.
    const roadsWorld = makeWorld(dev.tiles, dev.roads);
    const tellApart =
      canonicalJson(createInitialState(roadsWorld, 1, ["p1"], dev.manifest.spawn)) !==
      canonicalJson(createInitialState(world, 1, ["p1"], dev.manifest.spawn));
    expect(m.match!.label).toBe(tellApart ? COLLIDERS_ONLY : WITH_ROADS);
  });
});

describe("E2E_REQUIRE (prereq.ts)", () => {
  it("parses names separated by commas or spaces, and 'all'", () => {
    expect([...parseRequire(undefined)]).toEqual([]);
    expect([...parseRequire(" ")]).toEqual([]);
    expect([...parseRequire("sf, foot  render-debug")].sort()).toEqual(["foot", "render-debug", "sf"]);
    expect([...parseRequire("all")].sort()).toEqual(Object.keys(PREREQUISITES).sort());
  });

  it("rejects an unknown name, so a typo cannot require nothing", () => {
    expect(() => parseRequire("sf,sff")).toThrow(/unknown prerequisite "sff"/);
  });
});

describe("helpers", () => {
  it("the route driver moves and enters through replayable inputs alone", () => {
    const world = makeWorld([], null);
    const initial = createInitialState(world, 1, ["p1"], { x: 0, z: 0, heading: 0 });
    const driver = new GameplayDriver(world, initial);
    driver.walkTo({ x: 8, z: 0 }, 2, 600);
    expect(driver.state.players.p1!.mode).toBe("foot");
    expect(Math.hypot(driver.body.x - 8, driver.body.z)).toBeLessThanOrEqual(2);
    driver.inCar();
    expect(driver.state.players.p1!.mode).toBe("vehicle");
    const replayed = replay(world, initial, [{ frames: driver.frames }], createGameSystems());
    expect(hashState(replayed.final)).toBe(hashState(driver.state));
    expect(initial.tick).toBe(0);
    expect(initial.players.p1!.car.x).toBe(0);
  });

  it("builds the same authored world layers in browser scenarios and Node replays, retaining curved sidewalks", () => {
    const gameplay: GameplayWorldData = {
      version: 1, world: "fixture", sourceSnapshot: "committed",
      refills: [{ id: "fixture-hydrant", kind: "hydrant", x: 4, y: 0, z: 3, radius: 4, salt: false }],
      anchors: [], tiles: [], territories: [],
    };
    const sidewalks: PipelineSidewalks = {
      version: 1,
      nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 20, y: 0, z: 0 }],
      edges: [{ id: "bend", a: "a", b: "b", kind: "sidewalk", points: [[10, 5]] }],
    };
    const transit: TransitLayer = { version: 1, routes: [], stops: [{ id: "stop", x: 4, y: 0, z: 3, routes: [] }] };
    const layers = { gameplay, sidewalks, transit };
    const browserWorld = makeWorld([], null, null, layers);
    const nodeWorld = buildWorldWithRoads([], null, null, layers);
    expect(nodeWorld.gameplay).toEqual(gameplay);
    expect(browserWorld.gameplay).toEqual(nodeWorld.gameplay);
    expect(browserWorld.sidewalks).toEqual(nodeWorld.sidewalks);
    expect(browserWorld.sidewalks?.edges[0]?.path.xs).toEqual([0, 10, 20]);
    expect(browserWorld.sidewalks?.edges[0]?.path.zs).toEqual([0, 5, 0]);
    expect(browserWorld.transit).toEqual(nodeWorld.transit);
    expect(nodeWorld.transit?.stops[0]?.id).toBe("stop");
  });

  it("readJson names a Git LFS pointer instead of failing to parse it", () => {
    const dir = "test-results/harness-unit";
    mkdirSync(join(ROOT, dir), { recursive: true });
    try {
      writeFileSync(
        join(ROOT, dir, "pointer.json"),
        "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n",
      );
      expect(() => readJson(`${dir}/pointer.json`)).toThrow(/Git LFS pointer.*git lfs pull/);
    } finally {
      rmSync(join(ROOT, dir), { recursive: true, force: true });
    }
  });
});

describe("harness wiring", () => {
  it("docs/testing.md describes every e2e spec", () => {
    const doc = readFileSync(join(ROOT, "docs/testing.md"), "utf8");
    const specs = readdirSync(join(ROOT, "tests/e2e")).filter((f) => f.endsWith(".spec.ts"));
    expect(specs.length).toBeGreaterThan(0);
    for (const f of specs) expect(doc, `docs/testing.md does not mention ${f}`).toContain(f);
  });

  it("the long-playthrough workflow and docs/testing.md cover every *.long.ts", () => {
    const doc = readFileSync(join(ROOT, "docs/testing.md"), "utf8");
    const workflow = readFileSync(join(ROOT, ".github/workflows/campaign-long.yml"), "utf8");
    const long = readdirSync(join(ROOT, "tests/e2e")).filter((f) => f.endsWith(".long.ts"));
    expect(long.length).toBeGreaterThan(0);
    for (const f of long) {
      expect(doc, `docs/testing.md does not mention ${f}`).toContain(f);
      expect(workflow, `campaign-long.yml does not run ${f}`).toContain(`- ${f}`);
    }
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("--config tests/e2e/campaign-long.config.ts");
    expect(workflow).toContain("actions/upload-artifact");
    // Playwright must stop a stuck playthrough before the job limit, so its results upload.
    const jobMinutes = Number(/\n\s+timeout-minutes: (\d+)\n/.exec(workflow)?.[1]);
    const globalMs = Number(/--global-timeout=(\d+)/.exec(workflow)?.[1]);
    expect(globalMs).toBeGreaterThan(0);
    expect(globalMs).toBeLessThanOrEqual((jobMinutes - 5) * 60_000);
  });

  it("CI installs from the lockfile and runs typecheck, unit tests and e2e", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    for (const cmd of ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm test", "pnpm e2e", "actions/upload-artifact"]) {
      expect(ci, `ci.yml no longer runs ${cmd}`).toContain(cmd);
    }
    // Every pull request runs CI; a push runs it again only on main.
    expect(ci).toMatch(/on:\s*\n(?:\s*#[^\n]*\n)*\s+push:\s*\n\s+branches: \[main\]\s*\n\s+pull_request:/);
    // Failures retain their traces and reach artifact upload without spending time on later
    // browser tests or informational screenshots. A successful run still exercises every spec.
    expect(ci).toMatch(/\n\s+run: pnpm e2e --max-failures=1\n/);
    // The informational screenshots can never fail or cancel the job. A step that reaches its
    // timeout-minutes fails the job even under continue-on-error, so Playwright's global timeout
    // must end the captures a minute or more before that backstop, and the exit status is ignored.
    const start = ci.indexOf("- name: Screenshots");
    expect(start, "ci.yml has no Screenshots step").toBeGreaterThan(-1);
    const end = ci.indexOf("\n      - ", start);
    const shots = ci.slice(start, end < 0 ? undefined : end);
    expect(shots).toContain("steps.e2e.outcome == 'success'");
    expect(shots).toMatch(/\n\s+continue-on-error: true\n/);
    const stepMinutes = Number(/\n\s+timeout-minutes: (\d+)\n/.exec(shots)?.[1]);
    const run = /\n\s+run: ([^\n]*)/.exec(shots)?.[1] ?? "";
    const globalMs = Number(/^pnpm shots --global-timeout=(\d+) \|\| /.exec(run)?.[1]);
    expect(globalMs, `the Screenshots step must run "pnpm shots --global-timeout=<ms> || ...", not "${run}"`).toBeGreaterThan(0);
    expect(globalMs).toBeLessThanOrEqual((stepMinutes - 1) * 60_000);
    // Tiles live in plain git (decided 2026-10-20): no LFS fetch. The static web build runs,
    // and the repository variable can turn skips into failures.
    expect(ci).not.toMatch(/lfs:/);
    expect(ci).toContain("pnpm build");
    expect(ci).toContain("E2E_REQUIRE: ${{ vars.E2E_REQUIRE }}");
  });

  it("docs/testing.md documents every E2E_REQUIRE prerequisite", () => {
    const doc = readFileSync(join(ROOT, "docs/testing.md"), "utf8");
    for (const name of Object.keys(PREREQUISITES)) expect(doc, `docs/testing.md does not mention \`${name}\``).toContain(`\`${name}\``);
  });
});
