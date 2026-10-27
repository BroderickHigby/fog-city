// v22: steal an ordinary car. On foot, F within boarding reach of a civilian car (civilian-traffic.ts)
// that is stopped or nearly so puts the player behind its wheel. The car keeps its ambient
// identity, body and look (it stays a civilian agent and is drawn as one); as for a commandeered
// robotaxi (manual-taxi.ts), ordinary vehicle physics replaces its lane follower, so it leaves
// traffic for good. The player's own car stays parked where it was left, and F beside it still
// gets back into it first. Getting out (F) brakes the stolen car and parks it at its actual pose;
// F beside it later drives it again.
//
// No saved field is added: a stolen car is PlayerRide.manual on the player plus
// AgentState.manualCar on the civilian agent, both already in the v16 contract. Robotaxis are
// never stolen this way: F still boards one as a passenger and H still commandeers it.

import { isCivilianTraffic } from "./civilian-traffic.ts";
import type { SimState } from "./contract.ts";
import type { AgentState } from "./agents.ts";
import { segmentCrossesWall } from "./boundary.ts";
import { RIDE, distanceToTaxi, ridesByAgent } from "./ride.ts";
import { segmentBlocked, type World } from "./world.ts";

/** The first SIM_VERSION in which F steals a civilian car; earlier replays keep the old rule. */
export const STEAL_CAR_VERSION = 22;

/**
 * The civilian car a walker at (x, z) can steal, or null: not ridden by anyone, not dodging,
 * not sliding from a shove, no faster than RIDE.boardSpeed, within RIDE.boardRange of its body,
 * with no building or wall in between. The nearest wins, then the lowest id.
 */
export function stealableCar(world: World, state: Readonly<SimState>, agents: readonly AgentState[], x: number, z: number): AgentState | null {
  if (state.version < STEAL_CAR_VERSION) return null;
  const ridden = ridesByAgent(state);
  let best: AgentState | null = null;
  let bestD = Infinity;
  for (const a of agents) {
    if (!isCivilianTraffic(a) || a.dodge !== null || ridden.has(a.id)) continue;
    if (a.knock && a.knock.phase !== "stopped") continue;
    if (Math.abs(a.speed) > RIDE.boardSpeed) continue;
    const d = distanceToTaxi(a, x, z);
    if (d > RIDE.boardRange || d > bestD || (d === bestD && best !== null && a.id > best.id)) continue;
    if (segmentBlocked(world, x, z, a.x, a.z) || segmentCrossesWall(world.walls, x, z, a.x, a.z)) continue;
    best = a;
    bestD = d;
  }
  return best;
}
