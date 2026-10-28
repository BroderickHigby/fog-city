import { toLocal } from "../../geo/project.ts";
import { COIT_GUIDE_LINES, COIT_LABEL_IDS } from "../../content/coit-guide.ts";
import { clamp, dcos, dsin, PI } from "../dmath.ts";
import type { GameplayCommand, GameplayBody } from "../gameplay-contract.ts";
import { sortedIds, type SimState } from "../contract.ts";
import type { World } from "../world.ts";
import { groundHeight, groundWater } from "../world.ts";
import type { FidelityAnchor } from "../agents/fidelity.ts";

export const COIT_VIEWER = Object.freeze({ id: "coit-viewer", ...toLocal(37.802478, -122.405743), radius: 3 });
export const COIT_VIEW = Object.freeze({ priceCents: 25, durationTicks: 1800, flagTicks: 300, observeTicks: 60, anchorRadiusM: 120,
  yawMin: 110 * PI / 180, yawMax: 250 * PI / 180, pitchMin: -.85, pitchMax: .35, fovRadians: .16, maxRangeM: 1400 });
export interface CoitLandmark { id: string; label: string; x: number; y: number; z: number }
export interface CoitObservedActor { id: string; behavior: string; visible: boolean; firmware: "good" | "bad" | "none"; protected: boolean; active: boolean }
export interface CoitPlayerContext { cashCents: number; usable: boolean; aimYaw?: number; aimPitch?: number; actors: readonly CoitObservedActor[]; landmark: CoitLandmark | null }
export interface CoitContext { players: Readonly<Record<string, CoitPlayerContext>> }
export interface CoitGuideClaim { id: string; landmarkId: string; actualLabel: string; claimedLabel: string; startedTick: number; flagUntilTick: number; flagged: boolean; skipped: boolean }
export interface CoitViewerSession {
  pausedTicks?:number;
  startedTick: number; untilTick: number; yaw: number; pitch: number; paidCents: number; commandSequence: number;
  closed: boolean; settled: boolean; observingId: string; observedTicks: number; lastObservedTick: number; observedBehavior: string; evidenceTick: number;
  taggedIds: string[]; flaggedIds: string[]; guide: CoitGuideClaim | null; feedback: string; seed: number;
}
export interface CoitCameraPose { x: number; y: number; z: number; yaw: number; pitch: number; fovDegrees: number; aim: { x: number; y: number; z: number } }
export interface CoitInterestAnchor extends FidelityAnchor { readonly ownerId: string }

export function coitAngles(yaw: number, pitch: number): { yaw: number; pitch: number } {
  const positive = ((Number.isFinite(yaw) ? yaw : PI) % (2 * PI) + 2 * PI) % (2 * PI);
  return { yaw: clamp(positive, COIT_VIEW.yawMin, COIT_VIEW.yawMax), pitch: clamp(Number.isFinite(pitch) ? pitch : -.2, COIT_VIEW.pitchMin, COIT_VIEW.pitchMax) };
}
export function coitSessionActive(viewer: CoitViewerSession | undefined, tick: number): viewer is CoitViewerSession {
  return !!viewer && !viewer.closed && tick >= viewer.startedTick && tick < viewer.untilTick;
}
export function cloneCoitViewer(viewer: CoitViewerSession | undefined): CoitViewerSession | undefined {
  return viewer ? { ...viewer, taggedIds: [...viewer.taggedIds], flaggedIds: [...viewer.flaggedIds], guide: viewer.guide ? { ...viewer.guide } : null } : undefined;
}
export function coitViewerComplete(viewer: CoitViewerSession | undefined): boolean {
  return !!viewer && viewer.settled && viewer.taggedIds.length > 0 && viewer.flaggedIds.length > 0;
}

/** A real, recorded aim ray; the camera only presents it. No camera coordinates enter the sim. */
export function coitCameraPose(world: World, viewer: Pick<CoitViewerSession, "yaw" | "pitch">): CoitCameraPose {
  const angles = coitAngles(viewer.yaw, viewer.pitch), y = groundHeight(world, COIT_VIEWER.x, COIT_VIEWER.z) + 1.55;
  const fx = dsin(angles.yaw), fz = -dcos(angles.yaw), slope = dsin(angles.pitch) / Math.max(.01, dcos(angles.pitch));
  let range: number = COIT_VIEW.maxRangeM;
  for (let distance = 10; distance <= COIT_VIEW.maxRangeM; distance += 10) {
    const x = COIT_VIEWER.x + fx * distance, z = COIT_VIEWER.z + fz * distance;
    if (y + slope * distance <= groundHeight(world, x, z)) { range = distance; break; }
  }
  const x = COIT_VIEWER.x + fx * range, z = COIT_VIEWER.z + fz * range;
  return { x: COIT_VIEWER.x, y, z: COIT_VIEWER.z, ...angles, fovDegrees: 18, aim: { x, y: groundHeight(world, x, z), z } };
}
export function coitFidelityAnchors(state: Readonly<SimState>, world: World): CoitInterestAnchor[] {
  if (state.version < 24) return [];
  const result: CoitInterestAnchor[] = [];
  for (const playerId of sortedIds(state.ext.activities?.players ?? {})) {
    const own = state.ext.activities!.players[playerId]!, viewer = own.recon?.viewer;
    if (own.activeActivityId !== "coit-recon" || !coitSessionActive(viewer, state.tick)) continue;
    const pose = coitCameraPose(world, viewer);
    if (!groundWater(world, pose.aim.x, pose.aim.z)) result.push({ id: `coit:${playerId}`, ownerId: playerId, x: pose.aim.x, z: pose.aim.z, radiusM: COIT_VIEW.anchorRadiusM });
  }
  return result;
}

function seeded(seed: number, playerId: string, tick: number): number {
  let value = seed ^ tick;
  for (const char of playerId) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}
const WRONG_LABELS = ["Ferry Building", "Transamerica Pyramid", "Salesforce Tower"] as const;
function claim(landmark: CoitLandmark, viewer: CoitViewerSession, tick: number): CoitGuideClaim {
  const wrong = WRONG_LABELS.filter(label => label !== landmark.label);
  return { id: `coit-claim:${viewer.startedTick}:${landmark.id}`, landmarkId: landmark.id, actualLabel: landmark.label,
    claimedLabel: wrong[viewer.seed % wrong.length]!, startedTick: tick, flagUntilTick: tick + COIT_VIEW.flagTicks, flagged: false, skipped: false };
}

/** Reducer helper: no world facts or claimed labels can award tags. Only observed context can. */
export function advanceCoitViewer(previous: CoitViewerSession | undefined, context: CoitPlayerContext | undefined,
  body: GameplayBody, commands: readonly GameplayCommand[], tick: number, seed: number,
  emit: (kind: string, targetId: string, amount?: number, detail?: string) => void): { viewer: CoitViewerSession | undefined; completed: boolean } {
  let viewer = cloneCoitViewer(previous);
  let availableCash = context?.cashCents ?? 0;
  const near = body.mode === "foot" && Math.abs(body.speed) < .3 && Math.hypot(body.x - COIT_VIEWER.x, body.z - COIT_VIEWER.z) <= COIT_VIEWER.radius && context?.usable === true;
  if (viewer && !viewer.closed && tick >= viewer.untilTick) {
    viewer.closed = true;
    const completed = near && !viewer.settled && viewer.taggedIds.length > 0 && viewer.flaggedIds.length > 0;
    if (completed) { viewer.settled = true; viewer.feedback = "Viewing complete. Behavior tag and guide correction recorded."; emit("recon.viewerCompleted", COIT_VIEWER.id, 1); }
    else viewer.feedback = "Viewing ended. A behavior tag and a timely guide correction are both needed.";
    return { viewer, completed };
  }
  for (const command of [...commands].filter(command => command.playerId === body.id && command.kind === "coit-viewer" && command.targetId === "coit-recon")
    .sort((a, b) => a.sequence - b.sequence)) {
    if (command.sequence <= (viewer?.commandSequence ?? 0)) continue;
    if (viewer) viewer.commandSequence = command.sequence;
    if (command.choiceId === "open") {
      if (!near || Boolean(coitSessionActive(viewer, tick)) || viewer?.settled || !Number.isSafeInteger(availableCash) || availableCash < COIT_VIEW.priceCents) continue;
      const angles = coitAngles(context!.aimYaw ?? PI, context!.aimPitch ?? -.2);
      viewer = { startedTick: tick, untilTick: tick + COIT_VIEW.durationTicks, ...angles, paidCents: COIT_VIEW.priceCents, commandSequence: command.sequence,
        closed: false, settled: false, observingId: "", observedTicks: 0, lastObservedTick: -1, observedBehavior: "", evidenceTick: -1, taggedIds: [], flaggedIds: [], guide: null,
        feedback: "Quarter accepted. Observe sabotage, tag the robot, and challenge a wrong landmark label within five seconds.", seed: seeded(seed, body.id, tick) };
      availableCash -= COIT_VIEW.priceCents;
      emit("activity.cash", "coit-recon", -COIT_VIEW.priceCents, "viewer-quarter"); emit("coit.viewerOpened", COIT_VIEWER.id, COIT_VIEW.durationTicks);
    } else if (coitSessionActive(viewer, tick) && near) {
      if (command.choiceId === "close") { viewer.closed = true; viewer.feedback = "Viewer closed. The quarter is spent."; emit("coit.viewerClosed", COIT_VIEWER.id); }
      if (command.choiceId === "tag" && viewer.taggedIds.length < 8 && viewer.observingId && viewer.observedTicks >= COIT_VIEW.observeTicks && viewer.observedBehavior && tick - viewer.evidenceTick <= COIT_VIEW.flagTicks && !viewer.taggedIds.includes(viewer.observingId)) {
        const actor = context!.actors.find(actor => actor.id === viewer!.observingId && actor.visible && actor.active && actor.firmware === "bad" && !actor.protected);
        if (actor) { viewer.taggedIds.push(actor.id); viewer.feedback = `Behavior confirmed: ${viewer.observedBehavior}.`; emit("coit.robotTagged", actor.id, 1, viewer.observedBehavior); }
      }
      if (command.choiceId === "flag" && viewer.guide && !viewer.guide.flagged && tick <= viewer.guide.flagUntilTick) {
        viewer.guide.flagged = true; viewer.flaggedIds.push(viewer.guide.id); viewer.feedback = `You're absolutely right! That is the ${viewer.guide.actualLabel}.`;
        emit("coit.hallucinationFlagged", viewer.guide.id, 1, viewer.guide.actualLabel);
      }
      if (command.choiceId === "skip" && viewer.guide) { viewer.guide.skipped = true; viewer.feedback = "Guide audio skipped. The caption and five-second flag window remain."; emit("coit.guideSkipped", viewer.guide.id); }
    }
  }
  if (!viewer) return { viewer, completed: false };
  if (!near) { viewer.closed = true; viewer.observingId = ""; viewer.observedTicks = 0; viewer.observedBehavior = ""; viewer.feedback = "Return to the viewer to buy another viewing."; }
  if (coitSessionActive(viewer, tick) && near) {
    const angles = coitAngles(context!.aimYaw ?? viewer.yaw, context!.aimPitch ?? viewer.pitch);
    viewer.yaw = angles.yaw; viewer.pitch = angles.pitch;
    const eligible = context!.actors.filter(actor => actor.visible && actor.active && actor.firmware === "bad" && !actor.protected);
    const actor = eligible.find(actor => actor.id === viewer!.observingId) ?? eligible.find(actor => actor.behavior) ?? eligible[0];
    const consecutive = !!actor && viewer.observingId === actor.id && viewer.lastObservedTick === tick - 1;
    viewer.observedTicks = actor ? consecutive ? Math.min(COIT_VIEW.observeTicks, viewer.observedTicks + 1) : 1 : 0;
    if (!consecutive) { viewer.observedBehavior = ""; viewer.evidenceTick = -1; }
    if (actor?.behavior) { viewer.observedBehavior = actor.behavior; viewer.evidenceTick = tick; }
    viewer.observingId = actor?.id ?? ""; viewer.lastObservedTick = tick;
    if (!viewer.guide && tick >= viewer.startedTick + 180 + (viewer.pausedTicks??0) && context!.landmark) { viewer.guide = claim(context!.landmark, viewer, tick); emit("coit.guideClaim", viewer.guide.id, 98, viewer.guide.claimedLabel); }
  }
  return { viewer, completed: false };
}

export function coitGuideText(viewer: CoitViewerSession): string {
  if (viewer.guide?.flagged) return `You're absolutely right! That is the ${viewer.guide.actualLabel}.`;
  if (viewer.guide) return `With 98% confidence: that is the ${viewer.guide.claimedLabel}.`;
  return COIT_GUIDE_LINES[0].text;
}
export function coitGuideVoice(viewer: CoitViewerSession): { id: string; text: string } {
  const guide = viewer.guide;
  return { id: guide ? `coit:${guide.flagged ? "correct" : "claim"}:${guide.flagged ? guide.landmarkId : COIT_LABEL_IDS[guide.claimedLabel]}` : "coit:intro", text: coitGuideText(viewer) };
}
