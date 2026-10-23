import instances from "../../content/modes/instances.json" with { type: "json" };
import { toLocal } from "../../src/geo/project.ts";
import type { Spawn } from "../../src/sim/contract.ts";
import { createBotSweep } from "../../src/sim/modes/botsweep.ts";
import type { World } from "../../src/sim/world.ts";

interface Instance { id: string; modes: string[]; polygon: number[][] }

/** Bot Sweep arena centres: the approved district instances (content/modes/instances.json). */
export function botSweepCandidates(): Array<{ id: string; spawn: Spawn }> {
  return (instances.instances as Instance[]).filter((i) => i.modes.includes("botSweep")).map((i) => {
    const lat = i.polygon.reduce((s, p) => s + p[0]!, 0) / i.polygon.length, lon = i.polygon.reduce((s, p) => s + p[1]!, 0) / i.polygon.length;
    const at = toLocal(lat, lon);
    return { id: i.id, spawn: { x: Math.round(at.x), z: Math.round(at.z), heading: 0 } };
  });
}

/** Keep only the arenas this world can actually build for a full team (checked once at boot). */
export function verifiedArenas(world: World): Array<{ id: string; spawn: Spawn }> {
  return botSweepCandidates().filter(({ id, spawn }) => {
    try { createBotSweep(world, { id: `check-${id}`, seed: 1, players: ["p1", "p2", "p3", "p4"], spawn }); return true; } catch { return false; }
  });
}
