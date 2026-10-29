import { agentsRuntimeOf } from "../sim/agents/runtime.ts";
import type { RuntimeModel } from "../sim/agents/runtime.ts";
import type { AttackKind } from "../sim/combat-contract.ts";
import type { SimState } from "../sim/contract.ts";
import { playerPose } from "../sim/ride.ts";

export const HOSTILE_MARKER_LIMIT = 24;
export const HOSTILE_MARKER_RANGE = 80;
const ROBOTS = new Set<RuntimeModel>(["footman", "trundle", "robotaxi", "drone", "patrol", "sign-spinner", "tidy", "walker"]);

export interface HostileMarker {
  /** The actual runtime/combat target identity, also used by map cues. */
  targetId: string;
  x: number; y: number; z: number; height: number; distance: number;
  confirmed: true;
  mapCue: { id: string; kind: "robot"; label: "Hostile robot"; x: number; z: number; confirmed: true };
  windup: { attackId: string; kind: AttackKind; targetId: string; startTick: number; resolveTick: number; progress: number } | null;
}

/** Current authoritative hostility, not a scanner claim, incident assignment or visual tell. */
export function hostileMarkers(state: Readonly<SimState>, playerId: string): HostileMarker[] {
  const player = state.players[playerId], runtime = agentsRuntimeOf(state);
  if (!player || !runtime) return [];
  const own = playerPose(player), occupied = new Set<number>();
  for (const other of Object.values(state.players)) if (other.ride) occupied.add(other.ride.agentId);
  const rows: HostileMarker[] = [];
  for (const actor of Object.values(runtime.actors)) {
    if (actor.retired || actor.fidelity === "abstract" || actor.fidelity === "despawn" || actor.firmware !== "bad" || !ROBOTS.has(actor.model) ||
        actor.protected || actor.child || actor.mobilityAid || actor.id === playerId || actor.id === `player:${playerId}`) continue;
    if (actor.model === "robotaxi" && (occupied.has(actor.numericId) || actor.legacyId !== null && occupied.has(actor.legacyId))) continue;
    if ((state.ext.combat?.targets[actor.id]?.phase ?? "active") !== "active") continue;
    if (![actor.x, actor.y, actor.z, actor.height].every(Number.isFinite) || actor.height <= 0) continue;
    const distance = Math.hypot(actor.x - own.x, actor.z - own.z);
    if (!Number.isFinite(distance) || distance > HOSTILE_MARKER_RANGE) continue;
    // Keep only the nearest bounded rows; avoid sorting the entire city per frame.
    let index = 0;
    while (index < rows.length && (rows[index]!.distance < distance || rows[index]!.distance === distance && rows[index]!.targetId < actor.id)) index++;
    if (index >= HOSTILE_MARKER_LIMIT) continue;
    const pending = state.ext.combat?.attacks.find(attack => attack.attackerId === actor.id && !attack.active &&
      attack.startTick <= state.tick && state.tick < attack.resolveTick && attack.resolveTick > attack.startTick);
    rows.splice(index, 0, { targetId: actor.id, x: actor.x, y: actor.y, z: actor.z, height: actor.height, distance, confirmed: true,
      mapCue: { id: `hostile:${actor.id}`, kind: "robot", label: "Hostile robot", x: actor.x, z: actor.z, confirmed: true },
      windup: pending ? { attackId: pending.id, kind: pending.kind, targetId: pending.targetId, startTick: pending.startTick,
        resolveTick: pending.resolveTick, progress: Math.max(0, Math.min(1, (state.tick - pending.startTick) / (pending.resolveTick - pending.startTick))) } : null });
    if (rows.length > HOSTILE_MARKER_LIMIT) rows.pop();
  }
  return rows;
}

