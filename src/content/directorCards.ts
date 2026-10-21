// Ambient Director cards (content/director-cards.json): typed access, the eligibility filter
// the director uses, and the rules that keep cards consistent with the robots and the design.
//
// docs/design.md: after 45-75 s with no active objective, the director stages one card within
// 150 m from sim primitives. A card with a bad robot never runs in a protected area.

import cardsJson from "../../content/director-cards.json" with { type: "json" };
import { ROBOT_BARKS } from "./barks.ts";
import { BOT_TELLS, type BotTellsFile } from "./botTells.ts";
import { ROBOT_GOALS } from "./robotGoals.ts";
import { ACTIVITIES, DISTRICTS } from "./places.ts";

export type ActorKind = "badRobot" | "goodRobot" | "rogueTaxi" | "goodTaxi" | "moatVan" | "bystanders" | "associate";
export type TimeOfDay = "morning" | "day" | "evening" | "night";
export type Weather = "clear" | "rain" | "fog";

export interface CardActor {
  id: string;
  kind: ActorKind;
  archetype?: string;
  level?: number;
  count?: number;
}

export interface CardBeat {
  do: string;
  actor?: string;
  target?: string;
  seconds?: number;
  sabotage?: string;
  tell?: string;
  speaker?: string;
  context?: string;
  status?: string;
  prop?: string;
  speedMps?: number;
  loops?: number;
  laps?: number;
  activity?: string;
  text?: string;
  actors?: string[];
}

export interface DirectorCard {
  id: string;
  title: string;
  blurb: string;
  fromWave: number;
  radiusM: number;
  cooldownS: number;
  protectedAreas: boolean;
  when: {
    near: string[];
    time?: "any" | TimeOfDay;
    weather?: "any" | Weather;
    playerState?: "any" | "onFoot" | "inCar";
    minThreat?: number;
    maxThreat?: number;
    minStars?: number;
    districts?: string[];
    afterMelt?: true;
    afterWrongTarget?: true;
  };
  actors: CardActor[];
  beats: CardBeat[];
  payoff: { kind: string; cash?: "bounty"; reputation?: number; points?: number; note?: string };
}

export interface DirectorCardsFile {
  version: 1;
  maxRadiusM: number;
  idleWindowS: [number, number];
  cards: DirectorCard[];
}

export const DIRECTOR_CARDS = cardsJson as unknown as DirectorCardsFile;

/** What the director knows about the moment when it looks for a card. */
export interface DirectorContext {
  wave: number;
  /** Features within the card radius (sidewalk, hydrant, crosswalk, ...). */
  near: ReadonlySet<string>;
  time: TimeOfDay;
  weather: Weather;
  threat: number;
  stars: number;
  district: string | null;
  inProtectedArea: boolean;
  playerState: "onFoot" | "inCar";
  afterMelt?: boolean;
  afterWrongTarget?: boolean;
}

const BAD_KINDS: ReadonlySet<ActorKind> = new Set(["badRobot", "rogueTaxi", "moatVan"]);
const PERSON_KINDS: ReadonlySet<ActorKind> = new Set(["bystanders", "associate"]);
/** Targets that are places or roles rather than actors. */
const TARGET_WORDS: ReadonlySet<string> = new Set(["laneAhead", "repairKiosk", "nearestGoodRobot"]);
/** Beats a person (bystanders, an associate) may do. Robots and vans do the rest. */
const PERSON_VERBS: ReadonlySet<string> = new Set(["watch", "approachPlayer", "quickCall"]);

export function cardHasBadRobot(c: DirectorCard): boolean {
  return c.actors.some((a) => BAD_KINDS.has(a.kind));
}

/** Cards the director may stage now. */
export function eligibleCards(ctx: DirectorContext, f: DirectorCardsFile = DIRECTOR_CARDS): DirectorCard[] {
  return f.cards.filter((c) => {
    const w = c.when;
    if (c.fromWave > ctx.wave) return false;
    if (ctx.inProtectedArea && (!c.protectedAreas || cardHasBadRobot(c))) return false;
    if (!w.near.every((n) => ctx.near.has(n))) return false;
    if (w.time && w.time !== "any" && w.time !== ctx.time) return false;
    if (w.weather && w.weather !== "any" && w.weather !== ctx.weather) return false;
    if (w.playerState && w.playerState !== "any" && w.playerState !== ctx.playerState) return false;
    if (w.minThreat !== undefined && ctx.threat < w.minThreat) return false;
    if (w.maxThreat !== undefined && ctx.threat > w.maxThreat) return false;
    if (w.minStars !== undefined && ctx.stars < w.minStars) return false;
    if (w.districts && (ctx.district === null || !w.districts.includes(ctx.district))) return false;
    if (w.afterMelt && !ctx.afterMelt) return false;
    if (w.afterWrongTarget && !ctx.afterWrongTarget) return false;
    return true;
  });
}

/** Every rule beyond the schema. Empty means shippable. */
export function checkDirectorCards(f: DirectorCardsFile = DIRECTOR_CARDS, tells: BotTellsFile = BOT_TELLS): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const barkKeys = new Set(ROBOT_BARKS.barks.map((b) => `${b.speaker}/${b.context}`));
  const districtIds = new Set(DISTRICTS.map((d) => d.id));
  for (const c of f.cards) {
    const at = `card ${c.id}`;
    if (ids.has(c.id)) errs.push(`${at}: duplicate id`);
    ids.add(c.id);
    if (c.radiusM > f.maxRadiusM) errs.push(`${at}: radius ${c.radiusM} m is beyond ${f.maxRadiusM} m`);
    const bad = cardHasBadRobot(c);
    if (bad && c.protectedAreas) errs.push(`${at}: a card with a bad robot may not run in a protected area`);
    for (const d of c.when.districts ?? []) if (!districtIds.has(d)) errs.push(`${at}: unknown district ${d}`);
    const actors = new Map<string, CardActor>();
    for (const a of c.actors) {
      if (actors.has(a.id)) errs.push(`${at}: duplicate actor ${a.id}`);
      actors.set(a.id, a);
      const arch = a.archetype ? tells.archetypes.find((x) => x.id === a.archetype) : undefined;
      if (["badRobot", "goodRobot", "rogueTaxi", "goodTaxi"].includes(a.kind)) {
        if (!arch) errs.push(`${at}: actor ${a.id} needs a known archetype`);
        else {
          const wantBad = a.kind === "badRobot" || a.kind === "rogueTaxi";
          if ((arch.kind === "bad") !== wantBad) errs.push(`${at}: actor ${a.id} is ${a.kind} but ${arch.id} is ${arch.kind}`);
          const taxi = a.kind === "rogueTaxi" || a.kind === "goodTaxi";
          if ((arch.model === "robotaxi") !== taxi) errs.push(`${at}: actor ${a.id} kind ${a.kind} does not match model ${arch.model}`);
        }
      } else if (a.archetype) errs.push(`${at}: actor ${a.id} (${a.kind}) has no archetype`);
      if (a.kind === "associate" && c.fromWave < 3) errs.push(`${at}: VC associates arrive in wave 3`);
    }
    for (const b of c.beats) {
      const who = b.actor ? actors.get(b.actor) : undefined;
      if (b.actor && !who) errs.push(`${at}: beat ${b.do} names unknown actor ${b.actor}`);
      if (who && PERSON_KINDS.has(who.kind) && !PERSON_VERBS.has(b.do)) errs.push(`${at}: a person (${who.id}) cannot ${b.do}`);
      if (b.target !== undefined) {
        const t = actors.get(b.target);
        if (!t && !TARGET_WORDS.has(b.target)) errs.push(`${at}: beat ${b.do} targets unknown ${b.target}`);
        if (t && PERSON_KINDS.has(t.kind)) errs.push(`${at}: beat ${b.do} targets a person (${t.id}); robots target the player and robots only`);
      }
      for (const x of b.actors ?? []) if (!actors.has(x)) errs.push(`${at}: beat ${b.do} names unknown actor ${x}`);
      if (b.do === "sabotage") {
        if (!who || !BAD_KINDS.has(who.kind)) errs.push(`${at}: only a bad robot sabotages`);
        else {
          const table = ROBOT_GOALS.archetypes[who.archetype ?? ""];
          if (!table?.states.disguised.some((g) => g.sabotage === b.sabotage)) errs.push(`${at}: ${who.archetype} has no ${b.sabotage} sabotage in robot-goals.json`);
        }
      }
      if (b.do === "falseTell") {
        const t = tells.tells.find((x) => x.id === b.tell);
        const arch = tells.archetypes.find((x) => x.id === who?.archetype);
        if (!t?.falseTell) errs.push(`${at}: ${b.tell} is not a false tell`);
        else if (!arch?.falseTells?.includes(t.id)) errs.push(`${at}: ${who?.archetype} never shows ${t.id}`);
      }
      if (b.do === "bark" && !barkKeys.has(`${b.speaker}/${b.context}`)) errs.push(`${at}: no shared barks for ${b.speaker}/${b.context}`);
      if (b.do === "offerShift" && !ACTIVITIES.some((x) => x.id === b.activity)) errs.push(`${at}: unknown activity ${b.activity}`);
    }
    const k = c.payoff.kind;
    if (["melt", "catchInTheAct", "interruptUpdate"].includes(k) && !bad) errs.push(`${at}: payoff ${k} needs a bad robot`);
    if (k === "holdFire" && bad) errs.push(`${at}: a hold-fire card has no bad robot`);
    if (k === "catchInTheAct" && !c.beats.some((b) => b.do === "sabotage")) errs.push(`${at}: caught in the act needs a sabotage beat`);
    if (k === "interruptUpdate" && !c.beats.some((b) => b.sabotage === "pushUpdate")) errs.push(`${at}: an interrupt needs an update to interrupt`);
  }
  return errs;
}
