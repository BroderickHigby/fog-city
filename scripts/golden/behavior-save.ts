// Record the previous release's state and continuation log with that release's own code.
// node scripts/golden/behavior-save.ts /path/to/old-source <source-commit> > tests/golden/legacy-saves/v14-behavior.json
// The source can be a read-only `git archive` of the exact commit. Pass 15 as the final
// argument to record the pre-takeover release; omit it for the historical v14 recorder.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "."), sourceCommit = process.argv[3] ?? "";
const expectedVersion = Number(process.argv[4] ?? 14);
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("supply the exact source commit");
const S = await import(resolve(root, "src/sim/index.ts"));
const F = await import(resolve(root, "tests/sim/fixtures.ts"));
if (![14, 15].includes(expectedVersion) || S.SIM_VERSION !== expectedVersion) throw new Error(`record this historical fixture with v${expectedVersion} source only`);
const { world, spawn } = F.loadDevWorldWithRoads(), systems = S.createGameSystems({ wave: 3 });
let state = S.createInitialState(world, 7, ["p1", "p2"], spawn);
for (let tick = 1; tick <= 600; tick++) {
  const inputs = { p1: { throttle: tick < 240 ? .7 : tick > 300 ? 1 : 0, steer: tick < 240 ? .1 : 0,
    brake: tick >= 240 && tick < 300 ? 1 : 0, actions: tick === 300 ? S.Action.enterExit : 0 },
    p2: { throttle: .5, steer: .35, brake: 0, actions: 0 } };
  const events = tick === 1 ? [{ tick, kind: "gameplay.command", playerId: "p1", payload: { sequence: 1, kind: "mission-start", targetId: "hot-desk" } }] : [];
  state = S.step(world, state, inputs, events, systems);
}
// Unknown data belongs to the save too: an upgrader must not rebuild only known slots.
state = { ...state, ext: { ...state.ext, compatibilitySentinel: { nested: { keep: [37, true, `v${expectedVersion}`] } } } };
const initial = state, frames = [], hashes = [];
for (let i = 0; i < 120; i++) {
  const inputs = { p1: { throttle: 1, steer: .1, brake: 0, actions: i >= 60 ? S.Action.sprint : 0 },
    p2: { throttle: .4, steer: -.2, brake: 0, actions: 0 } };
  frames.push({ tick: state.tick + 1, inputs, events: [] });
  state = S.step(world, state, inputs, [], systems);
  if (i % 30 === 29) hashes.push(S.hashState(state));
}
const sha256 = (path: string) => createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
process.stdout.write(JSON.stringify({ sourceCommit, simVersion: S.SIM_VERSION, sourceFiles: {
  "src/sim/contract.ts": sha256("src/sim/contract.ts"), "src/sim/step.ts": sha256("src/sim/step.ts"),
}, world: "dev", seed: 7, wave: 3, recipe: "600 real composed ticks with mission-start, traffic, driving and on-foot controls; then an opaque extension sentinel and 120 recorded continuation frames",
  hash: S.hashState(initial), state: initial, frames, originalHashesEvery30: hashes }, null, 2) + "\n");
