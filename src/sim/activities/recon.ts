import { ACTIVITY_RULES } from "../../content/gameplay.ts";
import { toLocal } from "../../geo/project.ts";
import { Action } from "../contract.ts";
import { event, planarDistanceSquared } from "../player/common.ts";
import type { ActivitiesState, GameplayBody, GameplayContext, ReconRun } from "../player/types.ts";

/**
 * Coit Tower Recon (docs/design.md, Side activities): rogue signal relays are planted on Telegraph
 * Hill. Holding Bot Check beside one reads its signal (recon.signalFound). Only the player's own
 * held scan within range counts; the coin-op viewer and audio guide come with wave 4.
 */
const RULES = ACTIVITY_RULES.coitRecon;
export const RECON_ID = "coit-recon";
export const RECON_RELAYS: readonly { id: string; x: number; z: number }[] = RULES.relays.map(relay => ({ id: relay.id, ...toLocal(relay.lat, relay.lon) }));

export function startRecon(): ReconRun { return { found: [], scanning: "", scanTicks: 0 }; }

/** One tick: returns the relays whose signal was read this tick. */
export function stepRecon(run: ReconRun, ctx: GameplayContext, body: GameplayBody, state: ActivitiesState): number {
  const scanning = Boolean((ctx.actions?.[body.id] ?? 0) & Action.scan);
  const near = RECON_RELAYS.filter(relay => !run.found.includes(relay.id) && planarDistanceSquared(relay, body) <= RULES.rangeM * RULES.rangeM)
    .sort((a, b) => planarDistanceSquared(a, body) - planarDistanceSquared(b, body) || (a.id < b.id ? -1 : 1))[0];
  if (!scanning || !near || body.mode !== "foot") { run.scanning = ""; run.scanTicks = 0; return 0; }
  run.scanTicks = run.scanning === near.id ? run.scanTicks + 1 : 1;
  run.scanning = near.id;
  if (run.scanTicks < Math.ceil(RULES.scanS * 60)) return 0;
  run.found.push(near.id); run.scanning = ""; run.scanTicks = 0;
  event(state, "recon.signalFound", body.id, near.id);
  return 1;
}
