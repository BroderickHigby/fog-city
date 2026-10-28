import { ACTIVITY_RULES } from "../../content/gameplay.ts";
import { toLocal } from "../../geo/project.ts";
import { Action } from "../contract.ts";
import { event, planarDistanceSquared } from "../player/common.ts";
import type { ActivitiesState, GameplayBody, GameplayContext, ReconRun } from "../player/types.ts";
import { advanceCoitViewer, coitViewerComplete } from "./coit-viewer.ts";

/**
 * Coit Tower Recon (docs/design.md, Side activities): rogue signal relays are planted on Telegraph
 * Hill. Relay scanning remains a measured utility. The paid viewer's actual observed behavior
 * and timely guide correction own completion; scanning a relay cannot settle the activity.
 */
const RULES = ACTIVITY_RULES.coitRecon;
export const RECON_ID = "coit-recon";
export const RECON_RELAYS: readonly { id: string; x: number; z: number }[] = RULES.relays.map(relay => ({ id: relay.id, ...toLocal(relay.lat, relay.lon) }));

export function startRecon(): ReconRun { return { found: [], scanning: "", scanTicks: 0 }; }

/** One tick: returns the relays whose signal was read this tick. */
export function stepRelayRecon(run: ReconRun, ctx: GameplayContext, body: GameplayBody, state: ActivitiesState): number {
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

export function stepRecon(run: ReconRun, ctx: GameplayContext, body: GameplayBody, state: ActivitiesState): number {
  stepRelayRecon(run, ctx, body, state);
  const commands = ctx.commands.filter(command => command.playerId === body.id && command.kind === "coit-viewer" && command.sequence > (run.viewerCommandSequence ?? 0));
  for (const command of commands) run.viewerCommandSequence = Math.max(run.viewerCommandSequence ?? 0, command.sequence);
  const result = advanceCoitViewer(run.viewer, ctx.coit?.players[body.id], body, commands, state.tick, state.players[body.id]?.directorRng[0] ?? 1,
    (kind, targetId, amount = 0, detail = "") => event(state, kind, body.id, targetId, amount, detail));
  if (result.viewer) run.viewer = result.viewer;
  return result.completed ? 1 : 0;
}
export function reconComplete(run: ReconRun | undefined): boolean { return coitViewerComplete(run?.viewer); }
