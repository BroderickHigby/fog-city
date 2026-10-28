import { gameTime } from "../sim/clock/calendar.ts";
import { playerPose } from "../sim/ride.ts";
import { ACTIVITY_DEFINITIONS } from "../content/gameplay.ts";
import type { SimState } from "../sim/contract.ts";
import { canStartActivity, missionEngaged } from "../sim/activities/system.ts";
import { DEFAULT_CATALOG } from "../sim/player/catalog.ts";
import { gameplaySnapshot } from "../sim/player/adapter.ts";
import type { ActivityDefinition } from "../sim/player/types.ts";
import type { MapBlip, MapPoint, UiCopy } from "./types.ts";
import { PLAIN_WORDS_BOARDS, PLAIN_WORDS_ID, PLAIN_WORDS_LADDER } from "../sim/activities/plain-words.ts";
import { agentsRuntimeOf } from "../sim/agents/runtime.ts";

/** What the side-activity panel shows: an offer at a start marker, or the running activity's next step. */
export interface ActivityView {
  readonly offer?: { readonly id: string; readonly title: string; readonly detail: string };
  readonly active?: { readonly id: string; readonly title: string; readonly detail: string; readonly remainingTicks: number; readonly target?: MapPoint };
  /** Things the run asks the player to find on the map (Plain Words boards and spinners). */
  readonly blips?: readonly MapBlip[];
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
  const body = player ? playerPose(player) : undefined;
  if (!own || !body) return {};
  const running = activities.find(value => value.id === own.activeActivityId);
  if (running) {
    const checkpoints = running.checkpoints ?? [], index = own.checkpointIndex ?? 0, next = checkpoints[index];
    const remainingTicks = Math.max(0, Math.ceil((running.timeLimitS ?? 600) * 60) - (state.tick - own.activityStartedTick - (own.pausedTicks ?? 0)));
    const title = copy(activityCopyKey(running.id));
    // An activity mission (Office Hours) is guided by its own mission objective and dialogues.
    if (snapshot.missions.players[playerId]?.missionId === running.id && snapshot.missions.players[playerId]?.status === "active") {
      return { active: { id: running.id, title, remainingTicks, detail: copy("ui.activity.inMission") } };
    }
    // Search & Park: on the signed street, the panel asks for a legal stop (the map points at a legal bay).
    if (running.kind === "parking" && index >= checkpoints.length - 1 && own.parking?.progress.completed !== true) {
      return { active: { id: running.id, title, remainingTicks, detail: copy("ui.activity.park") } };
    }
    const run = own.plainWords;
    if (running.id === PLAIN_WORDS_ID && run) {
      const runtime = agentsRuntimeOf(state)?.actors ?? {};
      const blips: MapBlip[] = [
        ...run.boards.filter(board => board.qualified !== true && board.word >= 0).map(board => {
          const at = PLAIN_WORDS_BOARDS.find(value => value.id === board.id)!;
          return { id: board.id, kind: "mission" as const, label: copy("ui.activity.board", { word: PLAIN_WORDS_LADDER[board.word] ?? "" }), x: at.x, z: at.z };
        }),
        ...run.spinnerIds.filter(id => !run.rusted.includes(id) && runtime[id] && (state.ext.combat?.targets[id]?.phase ?? "active") === "active").map(id => ({ id, kind: "robot" as const, confirmed: true, label: copy("ui.activity.spinner"), x: runtime[id]!.x, z: runtime[id]!.z })),
      ];
      const detail = copy("ui.activity.plainWordsProgress", { washed: Math.min(own.objectiveCount ?? 0, running.objective?.count ?? 20), total: running.objective?.count ?? 20, rusted: run.rusted.length, spinners: run.spinnerIds.length, word: PLAIN_WORDS_LADDER[run.rung] ?? "" });
      // Point at the nearest board still showing a hype word, else the nearest standing spinner.
      const near = [...blips].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "mission" ? -1 : 1) || (a.x - body.x) ** 2 + (a.z - body.z) ** 2 - ((b.x - body.x) ** 2 + (b.z - body.z) ** 2))[0];
      return { active: { id: running.id, title, remainingTicks, detail, ...(near ? { target: { x: near.x, z: near.z } } : {}) }, blips };
    }
    if (next) return { active: { id: running.id, title, remainingTicks, target: { x: next.x, z: next.z },
      detail: copy("ui.activity.checkpoint", { label: label(running.id, next.id), index: index + 1, total: checkpoints.length }) } };
    const last = checkpoints.at(-1);
    const detail = running.kind === "delivery" ? copy("ui.activity.handOver", { label: last ? label(running.id, last.id) : "" }) : copy("ui.activity.finishing");
    return { active: { id: running.id, title, remainingTicks, detail, ...(last ? { target: { x: last.x, z: last.z } } : {}) } };
  }
  if (missionEngaged(snapshot.missions.players[playerId], DEFAULT_CATALOG)) return {};
  const completed = snapshot.missions.players[playerId]?.completedIds ?? [];
  const here = activities.filter(value => value.checkpoints?.length && canStartActivity(value, own, {...body,mode:player!.mode}, state.tick, wave, completed, gameTime(state).dayIndex))
    .sort((a, b) => (a.x - body.x) ** 2 + (a.z - body.z) ** 2 - ((b.x - body.x) ** 2 + (b.z - body.z) ** 2) || (a.id < b.id ? -1 : 1))[0];
  if (!here) return {};
  const first = here.checkpoints![0]!, finish = here.checkpoints!.at(-1)!;
  const detail = here.checkpoints!.length === 1
    ? copy("ui.activity.offerHere", { place: label(here.id, first.id) })
    : copy("ui.activity.offer", { from: label(here.id, first.id), to: label(here.id, finish.id), seconds: here.timeLimitS ?? 600 });
  return { offer: { id: here.id, title: copy(activityCopyKey(here.id)), detail } };
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
  style.textContent = `.fc-activity{position:absolute;right:16px;top:116px;width:min(320px,calc(100vw - 32px));display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:#152027f2;border:1px solid #ffffff2d;border-radius:9px;pointer-events:auto}.fc-activity[hidden]{display:none}.fc-activity details{flex:1;min-width:0}.fc-activity summary{cursor:pointer;min-height:44px;display:flex;align-items:center;gap:8px;list-style:none}.fc-activity summary::after{content:"+";margin-left:auto}.fc-activity details[open] summary::after{content:"−"}.fc-activity h2{font-size:13px;line-height:1.4;margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-activity p{margin:8px 0 0;color:#d2e1e0;font-size:14px;max-height:140px;overflow:auto;overflow-wrap:anywhere}.fc-activity button{flex:none;min-height:44px;margin:0}.fc-activity output{font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}.fc-ui:not([data-panel=""]):not(:not([data-panel])) .fc-activity{visibility:hidden;pointer-events:none}@media(max-width:760px){.fc-activity{right:10px;top:114px;width:min(260px,calc(100vw - 20px))}}`;
  const title = doc.createElement("h2"), detail = doc.createElement("p"), timer = doc.createElement("output");
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = copy("ui.activity.start");
  let offerId = "";
  button.addEventListener("click", () => { if (offerId) { start(offerId); button.disabled = true; } });
  const disclosure=doc.createElement("details"),summary=doc.createElement("summary");summary.append(title,timer);disclosure.append(summary,detail);root.append(style,disclosure,button);
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
      summary.title=title.textContent;
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
