// Record a save written by another checkout's own sim, for tests/sim/legacy-saves.test.ts.
// The recorded files are tests/golden/legacy-saves/*.json: the states the legacy branches the
// v7 contract absorbed would have saved (qa/sim v4, feature/dodge v4, their v5 combination).
//
//   git worktree add --detach /tmp/legacy origin/qa/sim
//   node scripts/golden/legacy-saves.ts /tmp/legacy qa/sim > tests/golden/legacy-saves/v4-qa-sim.json
//
// Two players on the checkout's own dev world, seed 42: p1 drives, brakes, gets out and walks
// (so the save has a walker), p2 circles in its car among the ambient traffic. 400 ticks.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const branch = process.argv[3] ?? "unknown";
const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const S = await import(resolve(root, "src/sim/index.ts"));
const H = await import(resolve(root, "tests/helpers.ts"));
const files = H.loadWorldFiles("dev");
const world = S.buildWorld(files.tiles, files.roads);
let s = S.createInitialState(world, 42, ["p1", "p2"], files.manifest.spawn);
const n = { throttle: 0, steer: 0, brake: 0, actions: 0 };
for (let t = 0; t < 400; t++) {
  const p1 = t < 90 ? { ...n, throttle: 1 } : t < 170 ? { ...n, brake: 1 } : t === 170 ? { ...n, actions: S.Action.enterExit }
    : t < 260 ? { ...n, throttle: 1, steer: 0.2 } : { ...n, throttle: 1, brake: 1 };
  s = S.step(world, s, { p1, p2: { ...n, throttle: t < 200 ? 0.6 : 0, steer: -0.3 } });
}
process.stdout.write(JSON.stringify({ sourceBranch: branch, sourceCommit: commit, simVersion: S.SIM_VERSION, hash: S.hashState(s), state: s }));
