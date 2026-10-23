// Record a composed gameplay save with another checkout's own code. This retains its
// real state and source revision so migration coverage does not invent a legacy shape.
// node scripts/golden/gameplay-save.ts /path/to/old-checkout > tests/golden/legacy-saves/v7-gameplay.json
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const sourceCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const S = await import(resolve(root, "src/sim/index.ts"));
const C = await import(resolve(root, "src/content/catalog.ts"));
const M = await import(resolve(root, "src/sim/missions/system.ts"));
const mission = C.MISSIONS.find((value: { id: string }) => value.id === "hot-desk");
const opening = mission.steps.find((value: { type: string }) => value.type === "trigger");
const at = M.missionPlace(opening.event.place);
const world = S.buildWorld([]), systems = S.createGameSystems({ wave: 2 });
let state = S.createInitialState(world, 71, ["p"], { x: at.x + 15, z: at.z, heading: 0 });
state = { ...state, players: { p: { ...state.players.p, mode: "foot", foot: S.makeFoot(at.x, 0, at.z, 0) } } };
for (let tick = 1; tick <= 120; tick++) {
  const input = { throttle: 0, steer: .2, brake: 0, actions: tick % 40 < 15 ? S.Action.fire : 0, aimYaw: tick * .0349066, aimPitch: 0 };
  // Use the persisted wire kind: older v7 checkouts predate the exported kind constant.
  const events = tick === 1 ? [{ tick, kind: "gameplay.command", playerId: "p", payload: { sequence: 1, kind: "mission-start", targetId: "hot-desk" } }] : [];
  state = S.step(world, state, { p: input }, events, systems);
}
process.stdout.write(JSON.stringify({ sourceCommit, simVersion: S.SIM_VERSION, hash: S.hashState(state), state }, null, 2) + "\n");
