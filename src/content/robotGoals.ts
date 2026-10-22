// Goal tables for the bad-robot brain (content/robot-goals.json): typed access and the rules
// that tie them to the archetypes in content/bot-tells.json and to docs/design.md.
//
// The sim's brain (Sim-Agents) owns the state machine; this file owns what each archetype WANTS
// in each state, so tuning a robot is a content change.

import goalsJson from "../../content/robot-goals.json" with { type: "json" };
import { BOT_TELLS, type BotTellsFile, type ModelId } from "./botTells.ts";

export type BrainState = "disguised" | "wary" | "alerted" | "attack" | "flee";
export const BRAIN_STATES: readonly BrainState[] = ["disguised", "wary", "alerted", "attack", "flee"];

export type AttackId = "shove" | "grocerySnatch" | "adBlast" | "handshake" | "forcedUpdate" | "phoneHack" | "carTheft" | "boxIn" | "termsOfService" | "swarm";
export type AttackTarget = "player" | "robot" | "emptyParkedCar" | "playerCar";

export interface Attack {
  wave: number;
  rangeM: number;
  windupS: number;
  models: ModelId[];
  targets: AttackTarget[];
  effect: string;
}

export interface Goal {
  goal: "errand" | "sabotage" | "shelter" | "avoid" | "hideTell" | "lookAt" | "callOthers" | "keepDistance" | "attack" | "flee" | "regroup";
  sabotage?: "snatchGroceries" | "pushUpdate" | "stickAd" | "tryCarDoor" | "stealEmptyCar" | "harvestData" | "parkAcrossHydrant";
  attack?: AttackId;
  when: "always" | "unobserved" | "playerInSight" | "playerFar" | "playerInCar" | "goodRobotNear" | "meleeSlotFree" | "meleeSlotsFull" | "rain" | "fog";
  target: string;
  weight: number;
  fromWave?: number;
}

export interface GoalTable {
  fightBias: number;
  states: Record<BrainState, Goal[]>;
}

export interface RobotGoalsFile {
  version: 1;
  knowledge: Record<string, number>;
  rules: Record<string, number>;
  attacks: Partial<Record<AttackId, Attack>>;
  transitions: Array<{ from: BrainState[]; to: BrainState | "seized"; when: string; note?: string }>;
  archetypes: Record<string, GoalTable>;
}

export const ROBOT_GOALS = goalsJson as unknown as RobotGoalsFile;

/** What an attack's goal target must be, by the attack's target kind. */
const TARGET_FOR: Readonly<Record<AttackTarget, readonly string[]>> = {
  player: ["player"],
  robot: ["nearestGoodRobot"],
  emptyParkedCar: ["emptyPlayerCar", "nearestParkedCar"],
  playerCar: ["laneAheadOfPlayerCar"],
};

/** Goals usable in a given wave (later-wave mechanics are inert until they ship). */
export function goalsInWave(archetype: string, state: BrainState, wave: number, g: RobotGoalsFile = ROBOT_GOALS): Goal[] {
  const t = g.archetypes[archetype];
  if (!t) throw new Error(`robotGoals: no table for ${archetype}`);
  return t.states[state].filter((x) => (x.fromWave ?? 2) <= wave && (x.attack === undefined || (g.attacks[x.attack]?.wave ?? 99) <= wave));
}

/** Every rule beyond the schema. Empty means the tables are consistent with bot-tells and the design. */
export function checkRobotGoals(g: RobotGoalsFile = ROBOT_GOALS, tells: BotTellsFile = BOT_TELLS): string[] {
  const errs: string[] = [];
  const bad = tells.archetypes.filter((a) => a.kind === "bad");
  for (const a of bad) if (!g.archetypes[a.id]) errs.push(`archetype ${a.id}: no goal table`);
  for (const [id, table] of Object.entries(g.archetypes)) {
    const a = tells.archetypes.find((x) => x.id === id);
    if (!a) {
      errs.push(`table ${id}: no such archetype in bot-tells.json`);
      continue;
    }
    if (a.kind !== "bad") errs.push(`table ${id}: only bad robots have a brain`);
    for (const s of BRAIN_STATES) {
      const goals = table.states[s];
      const at = `${id}.${s}`;
      if (!goals || goals.length === 0) {
        errs.push(`${at}: no goals`);
        continue;
      }
      if (goalsInWave(id, s, 2, g).length === 0) errs.push(`${at}: no goal works in wave 2`);
      for (const x of goals) {
        if (x.goal === "sabotage" && s !== "disguised") errs.push(`${at}: sabotage only while disguised (wary and alerted robots stop)`);
        if (x.goal === "sabotage" && x.when !== "unobserved" && x.when !== "playerFar") errs.push(`${at}: sabotage only when unobserved`);
        if (x.goal === "attack" && s !== "attack") errs.push(`${at}: attacks only in the attack state`);
        if (x.attack !== undefined) {
          const atk = g.attacks[x.attack];
          if (!atk) errs.push(`${at}: unknown attack ${x.attack}`);
          else {
            if (!atk.models.includes(a.model)) errs.push(`${at}: a ${a.model} cannot use ${x.attack}`);
            if (!atk.targets.some((k) => TARGET_FOR[k].includes(x.target))) errs.push(`${at}: ${x.attack} cannot target ${x.target}`);
            if (atk.wave > 2 && (x.fromWave ?? 2) < atk.wave) errs.push(`${at}: ${x.attack} ships in wave ${atk.wave}; mark the goal fromWave ${atk.wave}`);
          }
        }
      }
      if (s === "wary" && !goals.some((x) => x.goal === "hideTell")) errs.push(`${at}: a wary robot hides one tell`);
      if (s === "wary" && !goals.some((x) => x.goal === "errand")) errs.push(`${at}: a wary robot keeps its disguise and errand`);
      if (s === "flee" && !goals.some((x) => x.target === "awayFromWater")) errs.push(`${at}: fleeing robots run away from water`);
    }
  }
  for (const [id, atk] of Object.entries(g.attacks)) {
    if (atk.windupS < 0.5) errs.push(`attack ${id}: wind-up under 0.5 s is not readable`);
    for (const m of atk.models) if (!(m in tells.models)) errs.push(`attack ${id}: unknown model ${m}`);
  }
  if (!g.transitions.some((t) => t.to === "flee" && t.when === "rustHigh")) errs.push("transitions: rust 0.6 must send a robot to flee");
  if (!g.transitions.some((t) => t.to === "wary" && t.when === "pinged")) errs.push("transitions: a ping makes a bad robot wary");
  if (g.transitions.some((t) => t.when === "pinged" && t.to === "alerted")) errs.push("transitions: a ping makes a robot wary, never alerted");
  return errs;
}
