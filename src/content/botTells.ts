// Bot Hunt data (content/bot-tells.json): typed access and the cross-reference rules that
// JSON Schema cannot express. Pure: the sim can call botAtLevel() once robots exist.

import botTellsJson from "../../content/bot-tells.json" with { type: "json" };

export type Side = "bad" | "good";
export type Chassis = "strider" | "sidewalkCart" | "quadruped";
export type Target =
  | "robotaxi" | "billboard" | "busShelter" | "storefront" | "produceCrates" | "bakeryLine" | "cafeTables"
  | "crosswalk" | "busStop" | "park" | "owner" | "player" | "dock" | "door" | "sidewalk";

/** Executable behaviour, discriminated by kind. Units: S seconds, M metres, Deg degrees. */
export type Behaviour =
  // bad
  | { kind: "walkAgainstFlow" }
  | { kind: "emptyBag" }
  | { kind: "faceLightFlicker"; periodS: number; holdS: number }
  | { kind: "scanEachPerson"; pauseS: number; radiusM: number }
  | { kind: "loiterNear"; target: Target; radiusM: number; dwellS: number }
  | { kind: "photographFlash"; intervalS: number; radiusM: number }
  | { kind: "pastePoster"; target: "billboard" | "busShelter"; workS: number; intervalS: number }
  | { kind: "pitchPedestrian"; radiusM: number; pitchS: number; cooldownS: number; lineSet: string }
  | { kind: "relabelPrice"; target: "produceCrates"; dwellS: number; swaps: number }
  | { kind: "tailPerson"; distanceM: number; durationS: number }
  | { kind: "circleBlock"; loops: number }
  | { kind: "freezeMidStride"; intervalS: number; holdS: number }
  | { kind: "mirrorPlayer"; lagS: number; maxDistanceM: number }
  | { kind: "orientToPhones"; radiusM: number; turnRateDegS: number }
  | { kind: "avertWhenScanned"; turnAwayS: number }
  | { kind: "speedUpWhenWatched"; multiplier: number; watchConeDeg: number }
  | { kind: "loopLine"; lineSet: string; intervalS: number }
  | { kind: "neverArrives"; approachM: number }
  // good
  | { kind: "walkBeside"; target: "owner"; offsetM: number; maxLagM: number }
  | { kind: "yieldToPedestrians"; radiusM: number; sidestepM: number }
  | { kind: "fullBag" }
  | { kind: "waitAtCrosswalk" }
  | { kind: "queueInLine"; target: "bakeryLine"; spacingM: number }
  | { kind: "pauseForDog"; dogs: number; intervalS: number; pauseS: number }
  | { kind: "steadyFaceLight" }
  | { kind: "arriveAtDoor"; dwellS: number }
  | { kind: "holdDoor"; holdS: number }
  | { kind: "stayNearOwner"; maxDistanceM: number }
  | { kind: "nodAndMoveOn"; nodS: number }
  | { kind: "returnToDock"; batteryPct: number };

export type BehaviourKind = Behaviour["kind"];

/** Which side may use each behaviour kind. loiterNear and friends are always bad news. */
export const BEHAVIOUR_SIDE: Readonly<Record<BehaviourKind, Side>> = {
  walkAgainstFlow: "bad", emptyBag: "bad", faceLightFlicker: "bad", scanEachPerson: "bad", loiterNear: "bad",
  photographFlash: "bad", pastePoster: "bad", pitchPedestrian: "bad", relabelPrice: "bad", tailPerson: "bad",
  circleBlock: "bad", freezeMidStride: "bad", mirrorPlayer: "bad", orientToPhones: "bad", avertWhenScanned: "bad",
  speedUpWhenWatched: "bad", loopLine: "bad", neverArrives: "bad",
  walkBeside: "good", yieldToPedestrians: "good", fullBag: "good", waitAtCrosswalk: "good", queueInLine: "good",
  pauseForDog: "good", steadyFaceLight: "good", arriveAtDoor: "good", holdDoor: "good", stayNearOwner: "good",
  nodAndMoveOn: "good", returnToDock: "good",
};

export interface Tell {
  id: string;
  side: Side;
  subtlety: 1 | 2 | 3 | 4 | 5;
  label: string;
  description: string;
  behaviour: Behaviour;
  opposes?: string[];
}

export interface DifficultyStage {
  level: number;
  showTells: string[];
  intensity: number;
  camouflage: string[];
}

export interface Archetype {
  id: string;
  kind: Side;
  label: string;
  chassis: Chassis;
  habitat: Target[];
  tells: string[];
  difficulty: DifficultyStage[];
  designNote: string;
  rebootLine?: string;
  wrongPatchLine?: string;
}

export interface BotTellsFile {
  version: 1;
  scoring: { patchBad: number; patchGood: number; hitPerson: number };
  lineSets: Record<string, string[]>;
  tells: Tell[];
  archetypes: Archetype[];
}

export const BOT_TELLS = botTellsJson as unknown as BotTellsFile;

export const LEVELS = [1, 2, 3, 4, 5] as const;

/** Words that would turn a tell into a colour code. Tells are behaviour only. */
const COLOUR_WORDS = /\b(red|green|blue|yellow|orange|purple|violet|pink|cyan|magenta|teal|colou?r(ed|s)?|hue|tint(ed)?|glow(s|ing)? (red|green|blue))\b/i;

/**
 * Every rule the Bot Hunt data must satisfy beyond its JSON Schema. Returns a list of
 * human-readable problems; empty means shippable.
 */
export function checkBotTells(d: BotTellsFile = BOT_TELLS): string[] {
  const errs: string[] = [];
  const tells = new Map<string, Tell>();
  for (const t of d.tells) {
    if (tells.has(t.id)) errs.push(`tell ${t.id}: duplicate id`);
    tells.set(t.id, t);
    const side = BEHAVIOUR_SIDE[t.behaviour.kind];
    if (side === undefined) errs.push(`tell ${t.id}: unknown behaviour kind ${t.behaviour.kind}`);
    else if (side !== t.side) errs.push(`tell ${t.id}: behaviour ${t.behaviour.kind} belongs to the ${side} side, tell is ${t.side}`);
    if (COLOUR_WORDS.test(t.description) || COLOUR_WORDS.test(t.label)) errs.push(`tell ${t.id}: mentions a colour; tells are behaviour`);
    const b = t.behaviour as Record<string, unknown>;
    if (typeof b.lineSet === "string" && !(b.lineSet in d.lineSets)) errs.push(`tell ${t.id}: unknown lineSet ${b.lineSet}`);
    if (t.behaviour.kind === "faceLightFlicker" && t.behaviour.holdS >= t.behaviour.periodS) errs.push(`tell ${t.id}: holdS must be shorter than periodS`);
    if (t.behaviour.kind === "freezeMidStride" && t.behaviour.holdS >= t.behaviour.intervalS) errs.push(`tell ${t.id}: holdS must be shorter than intervalS`);
    if (t.opposes && t.side !== "good") errs.push(`tell ${t.id}: only good tells declare opposes`);
  }
  for (const t of d.tells) {
    for (const o of t.opposes ?? []) {
      const ot = tells.get(o);
      if (!ot) errs.push(`tell ${t.id}: opposes unknown tell ${o}`);
      else if (ot.side !== "bad") errs.push(`tell ${t.id}: opposes ${o}, which is not a bad tell`);
    }
  }

  const ids = new Set<string>();
  const used = new Set<string>();
  const goodChassis = new Set(d.archetypes.filter((a) => a.kind === "good").map((a) => a.chassis));
  for (const a of d.archetypes) {
    const where = `archetype ${a.id}`;
    if (ids.has(a.id)) errs.push(`${where}: duplicate id`);
    ids.add(a.id);
    if (a.tells.length < 2 || a.tells.length > 4) errs.push(`${where}: needs 2-4 tells, has ${a.tells.length}`);
    for (const id of a.tells) {
      const t = tells.get(id);
      if (!t) errs.push(`${where}: unknown tell ${id}`);
      else if (t.side !== a.kind) errs.push(`${where}: tell ${id} is ${t.side}, archetype is ${a.kind}`);
      used.add(id);
    }
    if (a.kind === "bad" && !goodChassis.has(a.chassis)) errs.push(`${where}: chassis ${a.chassis} has no good twin, so the body is a tell`);
    if (a.kind === "bad" ? !a.rebootLine : !a.wrongPatchLine) errs.push(`${where}: missing ${a.kind === "bad" ? "rebootLine" : "wrongPatchLine"}`);

    // The difficulty curve.
    const levels = a.difficulty.map((s) => s.level);
    if (levels.join(",") !== LEVELS.join(",")) errs.push(`${where}: difficulty levels must be exactly 1..5 in order, got ${levels.join(",")}`);
    const shownAnywhere = new Set<string>();
    let prevMinSubtlety = 0;
    let prevIntensity = Infinity;
    let prevCamo = 0;
    for (const s of a.difficulty) {
      const at = `${where} level ${s.level}`;
      if (s.showTells.length === 0) errs.push(`${at}: shows no tells, so it cannot be identified`);
      for (const id of s.showTells) {
        if (!a.tells.includes(id)) errs.push(`${at}: shows ${id}, which is not one of its tells`);
        shownAnywhere.add(id);
      }
      for (const id of s.camouflage) {
        const t = tells.get(id);
        used.add(id);
        if (a.kind === "good") errs.push(`${at}: good bots never wear camouflage`);
        if (!t) errs.push(`${at}: unknown camouflage tell ${id}`);
        else if (t.side !== "good") errs.push(`${at}: camouflage ${id} must be a good tell`);
        else for (const o of t.opposes ?? []) if (s.showTells.includes(o)) errs.push(`${at}: camouflage ${id} contradicts shown tell ${o}`);
      }
      const minSub = Math.min(...s.showTells.map((id) => tells.get(id)?.subtlety ?? 0));
      if (minSub < prevMinSubtlety) errs.push(`${at}: gets more obvious (min subtlety ${minSub} < ${prevMinSubtlety})`);
      if (s.intensity > prevIntensity) errs.push(`${at}: intensity rises (${s.intensity} > ${prevIntensity})`);
      if (s.camouflage.length < prevCamo) errs.push(`${at}: less camouflage than the level below`);
      prevMinSubtlety = minSub;
      prevIntensity = s.intensity;
      prevCamo = s.camouflage.length;
    }
    for (const id of a.tells) if (!shownAnywhere.has(id)) errs.push(`${where}: tell ${id} is never shown at any level`);
  }
  for (const t of d.tells) if (!used.has(t.id)) errs.push(`tell ${t.id}: not used by any archetype`);
  return errs;
}

export interface BotProfile {
  archetype: Archetype;
  level: number;
  /** Its own tells that play at this level (bad bots: always at least one bad tell). */
  tells: Tell[];
  /** Good-looking behaviour a bad bot borrows at this level. */
  camouflage: Tell[];
  intensity: number;
}

/** What one archetype does at one difficulty level (1..5, clamped). */
export function botAtLevel(archetypeId: string, level: number, d: BotTellsFile = BOT_TELLS): BotProfile {
  const a = d.archetypes.find((x) => x.id === archetypeId);
  if (!a) throw new Error(`botTells: unknown archetype ${archetypeId}`);
  const lv = Math.min(5, Math.max(1, Math.round(level)));
  const stage = a.difficulty.find((s) => s.level === lv) as DifficultyStage;
  const byId = (id: string): Tell => {
    const t = d.tells.find((x) => x.id === id);
    if (!t) throw new Error(`botTells: unknown tell ${id}`);
    return t;
  };
  return { archetype: a, level: lv, tells: stage.showTells.map(byId), camouflage: stage.camouflage.map(byId), intensity: stage.intensity };
}
