import { ACTIVITY_DEFINITIONS } from "../content/gameplay.ts";
import type { SimState } from "../sim/contract.ts";
import { canStartActivity, missionEngaged } from "../sim/activities/system.ts";
import { DEFAULT_CATALOG } from "../sim/player/catalog.ts";
import { gameplaySnapshot } from "../sim/player/adapter.ts";
import type { ActivityDefinition } from "../sim/player/types.ts";
import type { MapPoint, UiCopy } from "./types.ts";

/** What the side-activity panel shows: an offer at a start marker, or the running activity's next step. */
export interface ActivityView {
  readonly offer?: { readonly id: string; readonly title: string; readonly detail: string };
  readonly active?: { readonly id: string; readonly title: string; readonly detail: string; readonly remainingTicks: number; readonly target?: MapPoint };
}

/** Copy keys are camelCase ids: `embarcadero-sprint` reads `ui.activity.embarcaderoSprint`. */
export function activityCopyKey(id: string): string {
  return `ui.activity.${id.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())}`;
}
function label(activityId: string, checkpointId: string): string {
  return ACTIVITY_DEFINITIONS.find(value => value.id === activityId)?.checkpoints.find(value => value.id === checkpointId)?.label ?? "";
}

/** A pure projection of the simulation; the panel never decides what counts as progress. */
export function activityProjection(state: SimState, playerId: string, wave: number, copy: UiCopy,
  activities: readonly ActivityDefinition[] = DEFAULT_CATALOG.activities): ActivityView {
  const snapshot = gameplaySnapshot({ state }), own = snapshot.activities.players[playerId], player = state.players[playerId];
  const body = player?.mode === "foot" && player.foot ? player.foot : player?.car;
  if (!own || !body) return {};
  const running = activities.find(value => value.id === own.activeActivityId);
  if (running) {
    const checkpoints = running.checkpoints ?? [], index = own.checkpointIndex ?? 0, next = checkpoints[index];
    const remainingTicks = Math.max(0, Math.ceil((running.timeLimitS ?? 600) * 60) - (state.tick - own.activityStartedTick));
    const title = copy(activityCopyKey(running.id));
    if (next) return { active: { id: running.id, title, remainingTicks, target: { x: next.x, z: next.z },
      detail: copy("ui.activity.checkpoint", { label: label(running.id, next.id), index: index + 1, total: checkpoints.length }) } };
    const last = checkpoints.at(-1);
    const detail = running.kind === "delivery" ? copy("ui.activity.handOver", { label: last ? label(running.id, last.id) : "" }) : copy("ui.activity.finishing");
    return { active: { id: running.id, title, remainingTicks, detail, ...(last ? { target: { x: last.x, z: last.z } } : {}) } };
  }
  if (missionEngaged(snapshot.missions.players[playerId], DEFAULT_CATALOG)) return {};
  const here = activities.filter(value => value.checkpoints?.length && canStartActivity(value, own, body, state.tick, wave))
    .sort((a, b) => (a.x - body.x) ** 2 + (a.z - body.z) ** 2 - ((b.x - body.x) ** 2 + (b.z - body.z) ** 2) || (a.id < b.id ? -1 : 1))[0];
  if (!here) return {};
  const first = here.checkpoints![0]!, finish = here.checkpoints!.at(-1)!;
  return { offer: { id: here.id, title: copy(activityCopyKey(here.id)),
    detail: copy("ui.activity.offer", { from: label(here.id, first.id), to: label(here.id, finish.id), seconds: here.timeLimitS ?? 600 }) } };
}

/** Where the minimap should point while an activity runs. */
export function activityDestination(view: ActivityView): MapPoint | undefined {
  return view.active?.target;
}

export interface MountedActivityPanel {
  readonly element: HTMLElement;
  update(view: ActivityView): void;
  dispose(): void;
}

/** A small HUD card under the objective: never modal, so driving up to a marker never pauses play. */
export function mountActivityPanel(host: HTMLElement, copy: UiCopy, start: (activityId: string) => void): MountedActivityPanel {
  const doc = host.ownerDocument;
  const root = doc.createElement("aside");
  root.className = "fc-activity";
  root.setAttribute("aria-label", copy("ui.activity.panel"));
  root.hidden = true;
  const style = doc.createElement("style");
  style.textContent = ".fc-activity{position:absolute;right:18px;top:250px;width:min(300px,36vw);padding:12px 16px;background:#08171ed9;border-left:3px solid #f2c46d;border-radius:6px;pointer-events:auto}"
    + ".fc-activity h2{font-size:14px;margin:0 0 4px}.fc-activity p{margin:0;color:#d2e1e0}.fc-activity button{margin-top:8px}.fc-activity output{display:block;margin-top:6px;font-variant-numeric:tabular-nums}";
  const title = doc.createElement("h2"), detail = doc.createElement("p"), timer = doc.createElement("output");
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = copy("ui.activity.start");
  let offerId = "";
  button.addEventListener("click", () => { if (offerId) { start(offerId); button.disabled = true; } });
  root.append(style, title, detail, timer, button);
  host.append(root);
  let stamp = "";
  return {
    element: root,
    update(view) {
      const next = JSON.stringify([view.offer?.id, view.offer?.detail, view.active?.id, view.active?.detail, Math.ceil((view.active?.remainingTicks ?? 0) / 60)]);
      if (next === stamp) return;
      stamp = next;
      root.hidden = !view.offer && !view.active;
      title.textContent = view.active?.title ?? view.offer?.title ?? "";
      detail.textContent = view.active?.detail ?? view.offer?.detail ?? "";
      timer.hidden = !view.active;
      timer.textContent = view.active ? copy("ui.activity.remaining", { seconds: Math.ceil(view.active.remainingTicks / 60) }) : "";
      button.hidden = !view.offer;
      if (view.offer?.id !== offerId) button.disabled = false;
      offerId = view.offer?.id ?? "";
    },
    dispose() { root.remove(); },
  };
}
