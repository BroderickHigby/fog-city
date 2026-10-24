// The player's inner voice, GTA-style: short asides that say what to do next and where ("Okay,
// I gotta get to the Ferry Building plaza."), when a refill switches between fresh and salt
// water (the blaster never runs dry), when a bot looks wrong,
// and on a win or a retry. Every possible line is enumerated from the mission data, so the
// generator can voice the whole bank ahead of time (scripts/audio/generate-voices.ts) and the
// subtitles work without it. Variants rotate (least recently used) and each situation has a
// cooldown, so the same line is rarely heard twice in a row. Read-only over the sim: pure.

import type { Mission, Step } from "../content/missions.ts";
import { toLocal } from "../geo/project.ts";
import type { VoiceLine } from "./voice-lines.ts";

export const INNER_SPEAKER = "player";
export const INNER_MISSION = "inner";

/** Situations the inner voice speaks in; the templates use {place}. */
export const INNER_TEMPLATES = {
  goto: ["Okay, I gotta get to {place}.", "{Place}. Let's move.", "Right. {Place}, and fast."],
  gotoRush: ["Clock's running. {Place}, go go go.", "No time. {Place}, now."],
  start: ["Next stop: {place}.", "Gotta swing by {place}."],
  reminder: ["Still need to get to {place}.", "{Place}. Focus."],
  melt: ["Water on the bad one. Only the bad one.", "Rust it. Just that one, though."],
  watch: ["Don't spray yet. Just watch what it does.", "Eyes on it. What's it up to?"],
  scan: ["Let's see what this thing really is.", "Scan it. Trust, but verify."],
  cone: ["Cone time. Very official.", "One traffic cone, coming right up."],
  threatUp: ["Need these bots to notice me.", "Okay. Time to make some noise."],
  threatDown: ["Too much heat. Lay low.", "Cool it. Let them forget me."],
  salt: ["Salt water. Great for rust, rough on the nozzle.", "Bay water. Extra crunchy.", "Salt in the tank. The bots won't love this."],
  fresh: ["Fresh water again.", "Back on the good stuff.", "Fresh tank. Nice and gentle."],
  sketchy: ["That bot's acting sketchy.", "Yeah, that one's not right.", "Huh. That bot's up to something."],
  win: ["Nailed it.", "Ship it.", "Another one for the pitch deck."],
  retry: ["Okay. Again.", "Fine. Take two.", "That didn't happen. Again."],
} as const satisfies Record<string, readonly string[]>;
export type InnerSituation = keyof typeof INNER_TEMPLATES;

/** Seconds before the same situation may speak again (place lines key on their step). */
export const INNER_COOLDOWN_S: Readonly<Record<InnerSituation, number>> = {
  goto: 0, gotoRush: 0, start: 0, reminder: 90, melt: 30, watch: 30, scan: 30, cone: 30, threatUp: 30, threatDown: 30,
  salt: 30, fresh: 30, sketchy: 30, win: 0, retry: 0,
};
/** At least this long between any two inner-voice lines. */
export const INNER_GAP_S = 6;
/** A goto step longer than this and still far: a reminder. */
export const REMINDER_FAR_M = 150;

/**
 * A place label as the player would say it: the part before any comma, street abbreviations
 * spelled out, and "the" before a place named by a common noun ("Bay Bridge approach deck" ->
 * "the Bay Bridge approach deck"; "Moat Labs HQ" and "Hyde Street near Union Street" stay bare).
 */
export function spokenPlace(label: string): string {
  let head = label.split(",")[0]!.trim()
    .replace(/\bSt\b\.?/g, "Street").replace(/\bBlvd\b\.?/g, "Boulevard").replace(/\bAve\b\.?/g, "Avenue");
  if (/^The /.test(head)) return head.replace(/^The /, "the ");
  const last = head.split(/\s+/).pop() ?? "";
  if (/^[a-z]/.test(last)) head = `the ${head}`;
  return head;
}

const placeKey = (place: string): string => place.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fill = (template: string, place: string): string => {
  const capital = place.charAt(0).toUpperCase() + place.slice(1);
  return template.replace("{place}", place).replace("{Place}", capital);
};

/** The place a step sends the player to, if any. */
export function stepPlace(step: Step): { place: string; kind: "goto" | "start" } | null {
  if (step.type === "goto") return { place: spokenPlace(step.target.label), kind: "goto" };
  if (step.type === "trigger" && step.event.kind === "enterArea") return { place: spokenPlace(step.event.place.label), kind: "start" };
  return null;
}

const PLACE_SITUATIONS = ["goto", "gotoRush", "start", "reminder"] as const;

/** Every inner-voice line, ids "inner.<situation>[.<place>].<n>", in a stable order. */
export function innerVoiceLines(missions: readonly Mission[]): VoiceLine[] {
  const places = new Set<string>();
  for (const m of missions) for (const s of m.steps) { const p = stepPlace(s); if (p) places.add(p.place); }
  const out: VoiceLine[] = [];
  const line = (id: string, text: string): VoiceLine => ({ id, missionId: INNER_MISSION, stepId: id.split(".")[1]!, kind: "inner", speaker: INNER_SPEAKER, text });
  for (const place of [...places].sort())
    for (const situation of PLACE_SITUATIONS)
      INNER_TEMPLATES[situation].forEach((t, i) => out.push(line(`inner.${situation}.${placeKey(place)}.${i}`, fill(t, place))));
  for (const [situation, templates] of Object.entries(INNER_TEMPLATES)) {
    if ((PLACE_SITUATIONS as readonly string[]).includes(situation)) continue;
    templates.forEach((t, i) => out.push(line(`inner.${situation}.${i}`, t)));
  }
  return out;
}

export interface InnerObservation {
  missionId: string;
  stepId: string;
  status: string;
  visits: number;
  /** The local player's position, when known. */
  player: { x: number; z: number } | null;
  /** Whether the blaster holds salt water (the last refill point's), when known. */
  salt: boolean | null;
  /** The latest scan said "bad" (a fresh result only: its tick). */
  badScanTick: number | null;
}

/** Decides which inner-voice line, if any, to say now. Deterministic given its inputs. */
export class InnerVoice {
  private readonly lines: ReadonlyMap<string, VoiceLine>;
  private readonly missions: ReadonlyMap<string, Mission>;
  private readonly lastUse = new Map<string, number>();
  private readonly lastSituation = new Map<InnerSituation, number>();
  private lastSpokeS = Number.NEGATIVE_INFINITY;
  private stepKey = "";
  private stepEnteredS = 0;
  private lastStatus = "";
  private lastBadScan: number | null = null;
  private salt: boolean | null = null;
  private uses = 0;

  constructor(missions: readonly Mission[]) {
    this.missions = new Map(missions.map((m) => [m.id, m]));
    this.lines = new Map(innerVoiceLines(missions).map((l) => [l.id, l]));
  }

  /** Forget the moment (a save restore). */
  reset(): void {
    this.stepKey = "";
    this.lastStatus = "";
    this.lastBadScan = null;
    this.salt = null;
    this.lastSpokeS = Number.NEGATIVE_INFINITY;
  }

  /** The line to say now, or null. `nowS` is wall-clock seconds. */
  observe(o: InnerObservation, nowS: number): VoiceLine | null {
    const mission = this.missions.get(o.missionId);
    const step = mission?.steps.find((s) => s.id === o.stepId);
    const key = `${o.missionId}:${o.stepId}:${o.visits}`;
    const entered = key !== this.stepKey;
    if (entered) { this.stepKey = key; this.stepEnteredS = nowS; }
    // The first look after a boot or restore only learns the status: no "win" for an old win.
    const statusChanged = this.lastStatus !== "" && o.status !== this.lastStatus;
    this.lastStatus = o.status;
    // Events first: they are the moment.
    if (statusChanged && o.status === "complete") return this.say("win", null, nowS, true);
    if (statusChanged && o.status === "retry") return this.say("retry", null, nowS, true);
    const freshBad = o.badScanTick !== null && o.badScanTick !== this.lastBadScan;
    if (o.badScanTick !== null) this.lastBadScan = o.badScanTick;
    if (freshBad) { const l = this.say("sketchy", null, nowS); if (l) return l; }
    // A refill switched the tank between fresh and salt (the first look only learns which).
    const switched = o.salt !== null && this.salt !== null && o.salt !== this.salt;
    if (o.salt !== null) this.salt = o.salt;
    if (switched) { const l = this.say(o.salt ? "salt" : "fresh", null, nowS); if (l) return l; }
    if (!step || o.status !== "active") return null;
    const target = stepPlace(step);
    if (entered) {
      if (target) {
        const rush = step.type === "goto" && step.timer.limitS <= 300;
        return this.say(target.kind === "start" ? "start" : rush ? "gotoRush" : "goto", target.place, nowS, true);
      }
      if (step.type === "objective") {
        const k = step.objective.kind;
        const situation: InnerSituation | null = k === "melt" ? "melt" : k === "watch" ? "watch" : k === "scan" ? "scan" : k === "cone" ? "cone" : k === "threatAtLeast" ? "threatUp" : k === "threatAtMost" ? "threatDown" : null;
        if (situation) return this.say(situation, null, nowS);
      }
      return null;
    }
    // Still heading somewhere, and still far: a reminder now and then.
    if (target && o.player && nowS - this.stepEnteredS > INNER_COOLDOWN_S.reminder) {
      const at = step.type === "goto" ? step.target : step.type === "trigger" ? step.event.place : null;
      if (at && distanceTo(o.player, at) > REMINDER_FAR_M) return this.say("reminder", target.place, nowS);
    }
    return null;
  }

  /** The least recently used variant of a situation, if its cooldown and the gap allow. */
  private say(situation: InnerSituation, place: string | null, nowS: number, force = false): VoiceLine | null {
    if (!force && nowS - this.lastSpokeS < INNER_GAP_S) return null;
    const last = this.lastSituation.get(situation);
    if (last !== undefined && nowS - last < INNER_COOLDOWN_S[situation]) return null;
    const ids = INNER_TEMPLATES[situation].map((_, i) => (place === null ? `inner.${situation}.${i}` : `inner.${situation}.${placeKey(place)}.${i}`));
    let best: string | null = null;
    for (const id of ids) {
      if (!this.lines.has(id)) continue;
      if (best === null || (this.lastUse.get(id) ?? -1) < (this.lastUse.get(best) ?? -1)) best = id;
    }
    if (best === null) return null;
    this.lastUse.set(best, this.uses++);
    this.lastSituation.set(situation, nowS);
    this.lastSpokeS = nowS;
    return this.lines.get(best)!;
  }
}

function distanceTo(p: { x: number; z: number }, place: { lat: number; lon: number }): number {
  const at = toLocal(place.lat, place.lon);
  return Math.hypot(p.x - at.x, p.z - at.z);
}
