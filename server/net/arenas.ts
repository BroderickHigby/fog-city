import instances from "../../content/modes/instances.json" with { type: "json" };
import { toLocal } from "../../src/geo/project.ts";
import { createInitialState, step, type Spawn } from "../../src/sim/index.ts";
import { arenaWorld } from "../../src/sim/modes/arena.ts";
import { BOT_SWEEP_ARENA_RADIUS, BOT_SWEEP_MAX_PLAYERS, createBotSweep } from "../../src/sim/modes/botsweep.ts";
import { groundHeight, type World } from "../../src/sim/world.ts";

interface Instance { id: string; modes: string[]; polygon: number[][] }

/** Bot Sweep arena centres: the approved district instances (content/modes/instances.json). */
export function botSweepCandidates(): Array<{ id: string; spawn: Spawn }> {
  return (instances.instances as Instance[]).filter((i) => i.modes.includes("botSweep")).map((i) => {
    const lat = i.polygon.reduce((s, p) => s + p[0]!, 0) / i.polygon.length, lon = i.polygon.reduce((s, p) => s + p[1]!, 0) / i.polygon.length;
    const at = toLocal(lat, lon);
    return { id: i.id, spawn: { x: Math.round(at.x), z: Math.round(at.z), heading: 0 } };
  });
}

/** Metres every car of a full team gets in 3 s of full throttle from `spawn` (core movement only). */
export function teamDriveDistance(world: World, spawn: Spawn): number {
  const arena = arenaWorld(world, { center: { x: spawn.x, y: groundHeight(world, spawn.x, spawn.z), z: spawn.z }, radius: BOT_SWEEP_ARENA_RADIUS });
  const ids = Array.from({ length: BOT_SWEEP_MAX_PLAYERS }, (_, i) => `p${i + 1}`);
  const start = createInitialState(arena, 1, ids, spawn);
  let state = start;
  const go = Object.fromEntries(ids.map((id) => [id, { throttle: 1, steer: 0, brake: 0, actions: 0 }]));
  for (let i = 0; i < 180; i++) state = step(arena, state, go, [], []);
  return Math.min(...ids.map((id) => Math.hypot(state.players[id]!.car.x - start.players[id]!.car.x, state.players[id]!.car.z - start.players[id]!.car.z)));
}

/**
 * The arenas this world can actually build for a full team, each with the team-spawn heading
 * (of eight) that lets every car drive furthest. Checked once at relay boot.
 */
export function verifiedArenas(world: World): Array<{ id: string; spawn: Spawn; driveM: number }> {
  const out: Array<{ id: string; spawn: Spawn; driveM: number }> = [];
  for (const { id, spawn } of botSweepCandidates()) {
    try { createBotSweep(world, { id: `check-${id}`, seed: 1, players: ["p1", "p2", "p3", "p4"], spawn }); } catch { continue; }
    let best = { spawn, driveM: -1 };
    for (let k = 0; k < 8; k++) {
      const candidate = { ...spawn, heading: (k * Math.PI) / 4 };
      const driveM = teamDriveDistance(world, candidate);
      if (driveM > best.driveM) best = { spawn: candidate, driveM };
    }
    if (best.driveM >= 10) out.push({ id, ...best });
  }
  return out;
}
