import type { SimInput, SimState } from "../sim/contract.ts";
import { datan2 } from "../sim/dmath.ts";
import type { World } from "../sim/world.ts";
import { playerPose } from "../sim/ride.ts";
import { coitLandmarks } from "../sim/activities/coit-observation.ts";
import { COIT_VIEWER, COIT_VIEW, coitAngles, coitCameraPose, coitGuideText, coitGuideVoice, coitSessionActive, type CoitCameraPose } from "../sim/activities/coit-viewer.ts";

export type CoitViewerChoice = "open" | "close" | "tag" | "flag" | "skip";
export interface CoitViewerOptions {
  command(choice: CoitViewerChoice): void;
  /** Existing voice queue/mixer owns audio settings, unlock and optional media. Captions always work. */
  voice?: { play(id: string, text: string): void | Promise<void>; skip(): void };
}
export interface MountedCoitViewer {
  readonly element: HTMLElement;
  update(state: Readonly<SimState>, playerId: string, world: World): void;
  /** Feed this into the normal recorded-input boundary, then use the resulting sim camera pose. */
  input(base: SimInput): SimInput;
  camera(): CoitCameraPose | null;
  dispose(): void;
}
export function coitViewerInput(base: SimInput, aim: { yaw: number; pitch: number } | null): SimInput {
  return aim ? { ...base, throttle: 0, steer: 0, brake: 1, actions: 0, aimYaw: coitAngles(aim.yaw, aim.pitch).yaw, aimPitch: coitAngles(aim.yaw, aim.pitch).pitch } : base;
}

/** Original coin-op frame and controls; presentation cannot buy time or declare a tag. */
export function mountCoitViewer(host: HTMLElement, options: CoitViewerOptions): MountedCoitViewer {
  const doc = host.ownerDocument, root = doc.createElement("section"), style = doc.createElement("style");
  root.className = "coit-viewer"; root.hidden = true; root.tabIndex = 0; root.setAttribute("aria-label", "Coit Tower coin-operated viewer");
  style.textContent = `.coit-viewer{position:absolute;inset:auto 20px 20px;z-index:18;max-width:560px;background:#142126ed;color:#fff6e8;border:2px solid #cfaa69;border-radius:14px;padding:16px;font:14px/1.45 monospace;pointer-events:auto}.coit-viewer[hidden]{display:none}.coit-viewer.active{inset:24px;max-width:none;background:transparent;border:12px solid #142126;border-radius:70px;display:flex;align-items:flex-end;cursor:grab}.coit-viewer .coit-card{background:#142126ec;padding:14px;border-radius:12px;max-width:600px;cursor:default}.coit-viewer button{background:#efe3c9;color:#152529;border:0;border-radius:5px;padding:8px 10px;margin:4px;font:inherit}.coit-viewer button:disabled{opacity:.45}.coit-viewer .coit-caption{font-size:17px;color:#ffe4a2}.coit-viewer .coit-feedback{min-height:2em}.coit-viewer h2{margin:0 0 8px;font-size:18px}`;
  const card = doc.createElement("div"); card.className = "coit-card";
  const title = doc.createElement("h2"), hint = doc.createElement("p"), caption = doc.createElement("p"), feedback = doc.createElement("p"), controls = doc.createElement("div"), presets = doc.createElement("div");
  caption.className = "coit-caption"; caption.setAttribute("aria-live", "polite"); feedback.className = "coit-feedback";
  title.textContent = "Coit Tower · coin-op recon";
  const skipVoice = (): void => { try { options.voice?.skip(); } catch { /* Caption controls and exit remain available without audio. */ } };
  const buttons = new Map<CoitViewerChoice, HTMLButtonElement>();
  for (const [choice, label] of [["open", "Insert quarter · 30 seconds"], ["tag", "Tag observed behavior"], ["flag", "Flag wrong landmark"], ["skip", "Skip guide audio"], ["close", "Leave viewer"]] as const) {
    const button = doc.createElement("button"); button.type = "button"; button.textContent = label;
    button.addEventListener("click", () => { if (choice === "skip" || choice === "close") skipVoice(); options.command(choice); });
    controls.append(button); buttons.set(choice, button);
  }
  const disclosure = doc.createElement("small"); disclosure.textContent = "Machine-generated fictional guide · stock voice · captions always available.";
  card.append(title, hint, caption, feedback, controls, presets, disclosure); root.append(card); host.append(style, root);
  let active = false, disposed = false, pose: CoitCameraPose | null = null, yaw = Math.PI, pitch = -.2, session = -1, spoken = "", lastPointer: { x: number; y: number } | null = null;
  let mountedWorld: World | undefined;
  const aim = (nextYaw: number, nextPitch: number): void => { const angles = coitAngles(nextYaw, nextPitch); yaw = angles.yaw; pitch = angles.pitch; };
  const down = (event: PointerEvent): void => { if (!active || card.contains(event.target as Node)) return; lastPointer = { x: event.clientX, y: event.clientY }; root.setPointerCapture?.(event.pointerId); };
  const move = (event: PointerEvent): void => { if (!active || !lastPointer) return; aim(yaw + (event.clientX - lastPointer.x) * .003, pitch - (event.clientY - lastPointer.y) * .003); lastPointer = { x: event.clientX, y: event.clientY }; };
  const up = (): void => { lastPointer = null; };
  const key = (event: KeyboardEvent): void => {
    if (!active) return;
    const delta = event.shiftKey ? .055 : .018;
    if (event.key === "ArrowLeft") aim(yaw - delta, pitch);
    else if (event.key === "ArrowRight") aim(yaw + delta, pitch);
    else if (event.key === "ArrowUp") aim(yaw, pitch + delta);
    else if (event.key === "ArrowDown") aim(yaw, pitch - delta);
    else if (event.key === "Escape") options.command("close");
    else return;
    event.preventDefault(); event.stopPropagation();
  };
  root.addEventListener("pointerdown", down); root.addEventListener("pointermove", move); root.addEventListener("pointerup", up); root.addEventListener("pointercancel", up); root.addEventListener("keydown", key);
  return {
    element: root,
    update(state, playerId, world) {
      if (disposed) return;
      const own = state.ext.activities?.players[playerId], viewer = own?.recon?.viewer, player = state.players[playerId];
      root.hidden = own?.activeActivityId !== "coit-recon" || !player;
      const wasActive = active; active = !root.hidden && coitSessionActive(viewer, state.tick);
      root.classList.toggle("active", active); pose = active ? coitCameraPose(world, viewer!) : null;
      if (root.hidden) { if (wasActive) skipVoice(); return; }
      const body = playerPose(player!), near = !player!.ride && player!.mode === "foot" && Math.abs(body.speed) < .3 && Math.hypot(body.x - COIT_VIEWER.x, body.z - COIT_VIEWER.z) <= COIT_VIEWER.radius;
      if (viewer && session !== viewer.startedTick) { session = viewer.startedTick; aim(viewer.yaw, viewer.pitch); spoken = ""; }
      if (active && !wasActive) root.focus({ preventScroll: true });
      if (!active && wasActive) skipVoice();
      title.textContent = active ? `Coit coin-op · ${Math.max(0, Math.ceil((viewer!.untilTick - state.tick) / 60))} seconds` : "Coit Tower · coin-op recon";
      hint.textContent = active ? "Drag the view or use arrow keys. Watch a robot for one second and tag an actual sabotage you see. Challenge a wrong guide label within five seconds." : "Walk to the overlook viewer and stop. A quarter buys thirty seconds; leaving ends the viewing.";
      caption.textContent = viewer ? coitGuideText(viewer) : "AI audio guide · captions available even when audio is muted or missing.";
      feedback.textContent = viewer?.observingId && active ? `Observing ${viewer.observingId}: ${Math.min(100, Math.floor(viewer.observedTicks / COIT_VIEW.observeTicks * 100))}% · ${viewer.taggedIds.length} tag(s). ${viewer.feedback}` : viewer?.feedback ?? "Find the viewer at the overlook marker.";
      buttons.get("open")!.hidden = active; buttons.get("open")!.disabled = !near || (state.ext.economy?.players[playerId]?.cashCents ?? 0) < COIT_VIEW.priceCents;
      for (const choice of ["tag", "flag", "skip", "close"] as const) buttons.get(choice)!.hidden = !active;
      buttons.get("tag")!.disabled = !viewer?.observingId || viewer.observedTicks < COIT_VIEW.observeTicks || !viewer.observedBehavior || state.tick - viewer.evidenceTick > COIT_VIEW.flagTicks;
      buttons.get("flag")!.disabled = !viewer?.guide || viewer.guide.flagged || state.tick > viewer.guide.flagUntilTick;
      buttons.get("flag")!.textContent = viewer?.guide && !viewer.guide.flagged && state.tick <= viewer.guide.flagUntilTick ? `Flag wrong landmark · ${Math.ceil((viewer.guide.flagUntilTick - state.tick) / 60)}s` : "Flag wrong landmark";
      if (mountedWorld !== world) {
        mountedWorld = world; presets.replaceChildren();
        for (const landmark of coitLandmarks(world)) {
          const button = doc.createElement("button"); button.type = "button"; button.textContent = `Look toward ${landmark.label}`;
          button.addEventListener("click", () => { const origin = coitCameraPose(world, { yaw, pitch }); aim(datan2(landmark.x - origin.x, -(landmark.z - origin.z)), datan2(landmark.y - origin.y, Math.hypot(landmark.x - origin.x, landmark.z - origin.z))); });
          presets.append(button);
        }
      }
      presets.hidden = !active;
      const voiceId = viewer?.guide ? `${viewer.guide.id}:${viewer.guide.flagged ? "correct" : "claim"}` : viewer ? `coit-intro:${viewer.startedTick}` : "";
      if (active && voiceId && spoken !== voiceId) {
        spoken = voiceId;
        const line = coitGuideVoice(viewer!);
        try { void Promise.resolve(options.voice?.play(line.id, line.text)).catch(() => { /* Captions and sim deadlines remain authoritative. */ }); }
        catch { /* Missing media never blocks captions, flagging or progression. */ }
      }
    },
    input(base) { return coitViewerInput(base, active ? { yaw, pitch } : null); },
    camera() { return pose; },
    dispose() {
      if (disposed) return; disposed = true; active = false; pose = null; skipVoice();
      root.removeEventListener("pointerdown", down); root.removeEventListener("pointermove", move); root.removeEventListener("pointerup", up); root.removeEventListener("pointercancel", up); root.removeEventListener("keydown", key);
      root.remove(); style.remove();
    },
  };
}
