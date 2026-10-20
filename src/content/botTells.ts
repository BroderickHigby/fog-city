// Bot Hunt data (content/bot-tells.json): typed access and the cross-reference rules that
// JSON Schema cannot express. Pure: the sim and the bounty board call botAtLevel() and friends.
//
// docs/design.md "Telling good from bad": a bad robot looks exactly like a good one of the same
// model; behaviour gives it away. A bad robot shows 2-3 tells, subtler at higher levels. False
// tells are good robots glitching in ways that overlap the bad tells, so one tell is never proof.

import botTellsJson from "../../content/bot-tells.json" with { type: "json" };

export type Side = "bad" | "good";
export type ModelId = "errand-robot" | "sidewalk-bot" | "robotaxi";
export type Channel = "look" | "path" | "audio" | "status" | "speech";
export type Condition = "rain" | "fog" | "night" | "freeze";
export type Target =
  | "robotaxiPickup" | "billboard" | "busShelter" | "storefront" | "marketQueue" | "bakeryLine" | "crosswalk" | "busStop"
  | "park" | "door" | "sidewalk" | "chargingDock" | "parkedCars" | "garage" | "hydrant" | "road" | "depotLot"
  | "officeLobby" | "turntable" | "workbench" | "drawbridge" | "overlook";

/** Executable behaviour, discriminated by kind. Units: S seconds, M metres, Deg degrees, Pct percent. */
export type Behaviour =
  | { kind: "decal"; decal: "scuffedQrSticker" | "conferenceLanyard" | "fairSticker"; placement: "back" | "front" }
  | { kind: "askPassersBy"; lineSet: string; radiusM: number; cooldownS: number; audience: "adults" }
  | { kind: "tailRobot"; target: "goodErrandRobot" | "goodSidewalkBot"; distanceM: number; minDurationS: number }
  | { kind: "pastePoster"; target: "billboard" | "busShelter"; workS: number; intervalS: number }
  | { kind: "parkAcross"; target: "hydrant" | "laneAhead"; dwellS: number }
  | { kind: "tryCarDoors"; chime: "pairing"; intervalS: number }
  | { kind: "scanBeam"; target: "numberPlates"; sweepS: number; intervalS: number }
  | { kind: "trackPlayer"; radiusM: number; holdS: number }
  | { kind: "waitThroughSignal"; cycles: number }
  | { kind: "walkAgainstFlow" }
  | { kind: "skipRainCape"; shelter: "awning" | "busShelter" | "arcade" }
  | { kind: "loopLine"; lineSet: string; intervalS: number }
  | { kind: "skipsSignals" }
  | { kind: "emptyBag" }
  | { kind: "avoidWater"; puddleClearanceM: number; hydrantClearanceM: number }
  | { kind: "humJingle"; intervalS: number; rangeM: number }
  | { kind: "speedUpWhenWatched"; multiplier: number; watchConeDeg: number }
  | { kind: "loiterNear"; target: Target; radiusM: number; dwellS: number }
  | { kind: "noApology"; bumpRadiusM: number }
  | { kind: "neverCharges"; statusPct: number }
  | { kind: "stepLoop"; steps: number; loops: number }
  | { kind: "avoidFog"; densityAbove: number }
  | { kind: "faceLightFlicker"; periodS: number; holdS: number }
  | { kind: "freezeMidStride"; intervalS: number; holdS: number }
  | { kind: "circleBlock"; loops: number }
  | { kind: "takesStairs" }
  | { kind: "neverArrives"; approachM: number }
  | { kind: "mirrorPlayer"; lagS: number; maxDistanceM: number }
  | { kind: "queueJump"; target: "marketQueue" }
  | { kind: "ignoresFreeze" }
  | { kind: "lapLoop"; target: "park"; laps: number }
  | { kind: "fullBag" }
  | { kind: "crossOnWalk" }
  | { kind: "yieldToPedestrians"; radiusM: number; sidestepM: number }
  | { kind: "wearsRainCape" }
  | { kind: "apologiseOnBump"; bumpRadiusM: number }
  | { kind: "splashThrough" }
  | { kind: "signalsEveryChange" }
  | { kind: "queueInLine"; target: "marketQueue" | "bakeryLine"; spacingM: number }
  | { kind: "holdDoor"; holdS: number }
  | { kind: "steadyFaceLight" }
  | { kind: "arriveAtDoor"; dwellS: number }
  | { kind: "entersFog" }
  | { kind: "returnToDock"; batteryPct: number }
  | { kind: "takesRamps" }
  | { kind: "nodAndMoveOn"; nodS: number }
  | { kind: "pauseForFreeze"; holdS: number }
  | { kind: "lowBatteryStall"; batteryPct: number; holdS: number }
  | { kind: "gpsLostLoop"; loops: number }
  | { kind: "dance"; holdS: number }
  | { kind: "talksToNobody"; lineSet: string; intervalS: number }
  | { kind: "glanceOnPing"; holdS: number }
  | { kind: "emptyBagReturning" }
  | { kind: "shelterWithCape"; shelter: "awning" | "busShelter" | "arcade" }
  | { kind: "detourForParcel" }
  | { kind: "justCharged" }
  | { kind: "scenicLoop"; loops: number }
;

export type BehaviourKind = Behaviour["kind"];

/**
 * Which side may use each behaviour kind. "either" kinds are shared (a decal can be a jailbreak
 * sticker or a street-fair sticker; the decal itself decides, see DECAL_SIDE).
 */
export const BEHAVIOUR_SIDE: Readonly<Record<BehaviourKind, Side | "either">> = {
  decal: "either", askPassersBy: "bad", tailRobot: "bad", pastePoster: "bad", parkAcross: "bad", tryCarDoors: "bad",
  scanBeam: "bad", trackPlayer: "bad", waitThroughSignal: "bad", walkAgainstFlow: "bad", skipRainCape: "bad", loopLine: "bad",
  skipsSignals: "bad", emptyBag: "bad", avoidWater: "bad", humJingle: "bad", speedUpWhenWatched: "bad", loiterNear: "bad",
  noApology: "bad", neverCharges: "bad", stepLoop: "bad", avoidFog: "bad", faceLightFlicker: "bad", freezeMidStride: "bad",
  circleBlock: "bad", takesStairs: "bad", neverArrives: "bad", mirrorPlayer: "bad", queueJump: "bad", ignoresFreeze: "bad",
  lapLoop: "bad",
  fullBag: "good", crossOnWalk: "good", yieldToPedestrians: "good", wearsRainCape: "good", apologiseOnBump: "good",
  splashThrough: "good", signalsEveryChange: "good", queueInLine: "good", holdDoor: "good", steadyFaceLight: "good",
  arriveAtDoor: "good", entersFog: "good", returnToDock: "good", takesRamps: "good", nodAndMoveOn: "good", pauseForFreeze: "good",
  lowBatteryStall: "good", gpsLostLoop: "good", dance: "good", talksToNobody: "good", glanceOnPing: "good",
  emptyBagReturning: "good", shelterWithCape: "good", detourForParcel: "good", justCharged: "good", scenicLoop: "good",
};

export const DECAL_SIDE: Readonly<Record<string, Side>> = { scuffedQrSticker: "bad", conferenceLanyard: "bad", fairSticker: "good" };

export interface Tell {
  id: string;
  side: Side;
  falseTell?: true;
  mimics?: string[];
  subtlety: 1 | 2 | 3 | 4 | 5;
  channel: Channel;
  models: ModelId[];
  districts?: string[];
  when?: Condition;
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
  model: ModelId;
  habitat: Target[];
  tells: string[];
  falseTells?: string[];
  difficulty: DifficultyStage[];
  designNote: string;
  restoredLine?: string;
  wrongTargetLine?: string;
}

export interface RobotModel {
  name: string;
  maker: string;
  glb: string;
  rustRate: number;
  description: string;
}

export interface BotTellsFile {
  version: 2;
  scoring: { meltBad: number; meltArmoured: number; interruptUpdate: number; rustGood: number; wetPerson: number };
  models: Record<ModelId, RobotModel>;
  lineSets: Record<string, string[]>;
  tells: Tell[];
  archetypes: Archetype[];
}

export const BOT_TELLS = botTellsJson as unknown as BotTellsFile;

export const LEVELS = [1, 2, 3, 4, 5] as const;

/** Words that would turn a tell into a colour code. Tells are behaviour only. */
const COLOUR_WORDS = /\b(red|green|blue|yellow|orange|purple|violet|pink|cyan|magenta|teal|colou?r(ed|s)?|hue|tint(ed)?|glow(s|ing)? (red|green|blue))\b/i;

/** People a tell may never single out (design.md: a tell never involves a child or an animal as a target). */
const NO_TARGET = /\b(child|children|kids?|toddlers?|babies|baby|dogs?|cats?|pets?|animals?)\b/i;

/** Tell ids a bad archetype or a local bounty set may use (local tells are used by district packs). */
export function localTells(d: BotTellsFile = BOT_TELLS): Tell[] {
  return d.tells.filter((t) => t.districts !== undefined);
}

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
    const want = t.behaviour.kind === "decal" ? DECAL_SIDE[t.behaviour.decal] : side;
    if (side === undefined) errs.push(`tell ${t.id}: unknown behaviour kind ${t.behaviour.kind}`);
    else if (want !== t.side) errs.push(`tell ${t.id}: behaviour ${t.behaviour.kind} belongs to the ${want} side, tell is ${t.side}`);
    if (COLOUR_WORDS.test(t.description) || COLOUR_WORDS.test(t.label)) errs.push(`tell ${t.id}: mentions a colour; tells are behaviour`);
    if (t.side === "bad" && NO_TARGET.test(`${t.label} ${t.description}`)) errs.push(`tell ${t.id}: a bad tell may not involve a child or an animal`);
    const b = t.behaviour as Record<string, unknown>;
    if (typeof b.lineSet === "string" && !(b.lineSet in d.lineSets)) errs.push(`tell ${t.id}: unknown lineSet ${b.lineSet}`);
    if (t.behaviour.kind === "faceLightFlicker") {
      if (t.behaviour.holdS >= t.behaviour.periodS) errs.push(`tell ${t.id}: holdS must be shorter than periodS`);
      if (1 / t.behaviour.periodS > 3) errs.push(`tell ${t.id}: flashes more than 3 times a second (design.md, Flashing)`);
    }
    if (t.behaviour.kind === "freezeMidStride" && t.behaviour.holdS >= t.behaviour.intervalS) errs.push(`tell ${t.id}: holdS must be shorter than intervalS`);
    if (t.opposes && (t.side !== "good" || t.falseTell)) errs.push(`tell ${t.id}: only ordinary good tells declare opposes`);
    if (t.falseTell && t.side !== "good") errs.push(`tell ${t.id}: a false tell is a good robot's glitch`);
    if (t.districts && t.side !== "bad") errs.push(`tell ${t.id}: local tells are bad tells`);
  }
  for (const t of d.tells) {
    for (const o of t.opposes ?? []) {
      const ot = tells.get(o);
      if (!ot) errs.push(`tell ${t.id}: opposes unknown tell ${o}`);
      else if (ot.side !== "bad") errs.push(`tell ${t.id}: opposes ${o}, which is not a bad tell`);
    }
    for (const m of t.mimics ?? []) {
      const mt = tells.get(m);
      if (!mt) errs.push(`tell ${t.id}: mimics unknown tell ${m}`);
      else if (mt.side !== "bad") errs.push(`tell ${t.id}: mimics ${m}, which is not a bad tell`);
      else if (!t.models.some((x) => mt.models.includes(x))) errs.push(`tell ${t.id}: mimics ${m} on a model that never shows it`);
    }
  }

  const ids = new Set<string>();
  const used = new Set<string>();
  const goodModels = new Set(d.archetypes.filter((a) => a.kind === "good").map((a) => a.model));
  for (const a of d.archetypes) {
    const where = `archetype ${a.id}`;
    if (ids.has(a.id)) errs.push(`${where}: duplicate id`);
    ids.add(a.id);
    if (!(a.model in d.models)) errs.push(`${where}: unknown model ${a.model}`);
    const own = (id: string, what: string): Tell | undefined => {
      const t = tells.get(id);
      if (!t) errs.push(`${where}: unknown ${what} ${id}`);
      else if (!t.models.includes(a.model)) errs.push(`${where}: ${what} ${id} is never shown by a ${a.model}`);
      return t;
    };
    for (const id of a.tells) {
      const t = own(id, "tell");
      if (t && t.side !== a.kind) errs.push(`${where}: tell ${id} is ${t.side}, archetype is ${a.kind}`);
      if (t?.falseTell) errs.push(`${where}: ${id} is a false tell; list it under falseTells`);
      if (t?.districts) errs.push(`${where}: ${id} is a local tell; district bounty sets use it`);
      used.add(id);
    }
    for (const id of a.falseTells ?? []) {
      const t = own(id, "false tell");
      if (t && !t.falseTell) errs.push(`${where}: ${id} is not a false tell`);
      used.add(id);
    }
    if (a.kind === "bad" && !goodModels.has(a.model)) errs.push(`${where}: model ${a.model} has no good twin, so the body is a tell`);
    if (a.kind === "bad" ? !a.restoredLine : !a.wrongTargetLine) errs.push(`${where}: missing ${a.kind === "bad" ? "restoredLine" : "wrongTargetLine"}`);

    // The difficulty curve.
    const levels = a.difficulty.map((s) => s.level);
    if (levels.join(",") !== LEVELS.join(",")) errs.push(`${where}: difficulty levels must be exactly 1..5 in order, got ${levels.join(",")}`);
    const shownAnywhere = new Set<string>();
    let prevMinSubtlety = 0;
    let prevIntensity = Infinity;
    let prevCamo = 0;
    for (const s of a.difficulty) {
      const at = `${where} level ${s.level}`;
      if (a.kind === "bad" && (s.showTells.length < 2 || s.showTells.length > 3)) errs.push(`${at}: a bad robot shows 2-3 tells, this shows ${s.showTells.length}`);
      for (const id of s.showTells) {
        if (!a.tells.includes(id)) errs.push(`${at}: shows ${id}, which is not one of its tells`);
        shownAnywhere.add(id);
      }
      if (!s.showTells.some((id) => tells.get(id)?.when === undefined)) errs.push(`${at}: every tell shown is conditional; it would show nothing in fair weather`);
      for (const id of s.camouflage) {
        const t = tells.get(id);
        used.add(id);
        if (a.kind === "good") errs.push(`${at}: good robots never wear camouflage`);
        if (!t) errs.push(`${at}: unknown camouflage tell ${id}`);
        else if (t.side !== "good" || t.falseTell) errs.push(`${at}: camouflage ${id} must be an ordinary good tell`);
        else {
          if (!t.models.includes(a.model)) errs.push(`${at}: camouflage ${id} is never shown by a ${a.model}`);
          for (const o of t.opposes ?? []) if (s.showTells.includes(o)) errs.push(`${at}: camouflage ${id} contradicts shown tell ${o}`);
        }
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
  for (const t of d.tells) if (!used.has(t.id) && !t.districts) errs.push(`tell ${t.id}: not used by any archetype`);
  return errs;
}

export interface BotProfile {
  archetype: Archetype;
  level: number;
  /** Its own tells that play at this level (bad robots: always 2-3 bad tells). */
  tells: Tell[];
  /** Good-looking behaviour a bad robot borrows at this level. */
  camouflage: Tell[];
  intensity: number;
}

function tellById(id: string, d: BotTellsFile): Tell {
  const t = d.tells.find((x) => x.id === id);
  if (!t) throw new Error(`botTells: unknown tell ${id}`);
  return t;
}

/** What one archetype does at one difficulty level (1..5, clamped). */
export function botAtLevel(archetypeId: string, level: number, d: BotTellsFile = BOT_TELLS): BotProfile {
  const a = d.archetypes.find((x) => x.id === archetypeId);
  if (!a) throw new Error(`botTells: unknown archetype ${archetypeId}`);
  const lv = Math.min(5, Math.max(1, Math.round(level)));
  const stage = a.difficulty.find((s) => s.level === lv) as DifficultyStage;
  return {
    archetype: a,
    level: lv,
    tells: stage.showTells.map((id) => tellById(id, d)),
    camouflage: stage.camouflage.map((id) => tellById(id, d)),
    intensity: stage.intensity,
  };
}

/**
 * A bounty's profile: the archetype at a level with one local tell swapped in for its most
 * obvious shown tell (district bounty sets, content/districts/*.json). The local tell must fit
 * the archetype's model.
 */
export function botWithLocalTell(archetypeId: string, level: number, localTellId: string, d: BotTellsFile = BOT_TELLS): BotProfile {
  const p = botAtLevel(archetypeId, level, d);
  const local = tellById(localTellId, d);
  if (!local.districts) throw new Error(`botTells: ${localTellId} is not a local tell`);
  if (!local.models.includes(p.archetype.model)) throw new Error(`botTells: ${localTellId} is never shown by a ${p.archetype.model}`);
  const sorted = [...p.tells].sort((x, y) => x.subtlety - y.subtlety || (x.id < y.id ? -1 : 1));
  const drop = sorted[0] as Tell;
  return { ...p, tells: [...p.tells.filter((t) => t !== drop), local] };
}

/** The hardest (highest) subtlety among the tells a robot shows: bounty pay scales with it. */
export function hardestSubtlety(p: BotProfile): number {
  return Math.max(...p.tells.map((t) => t.subtlety));
}

/** Bounty cash per docs/design.md: base x (1 + 0.25 x (hardest subtlety - 1)), so subtlety 5 pays 2x. */
export function bountyPay(base: number, p: BotProfile, caughtInAct = false): number {
  const v = base * (1 + 0.25 * (hardestSubtlety(p) - 1)) * (caughtInAct ? 1.5 : 1);
  return Math.round(v);
}
