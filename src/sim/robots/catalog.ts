import { BOT_TELLS, botAtLevel, type ModelId, type Tell } from "../../content/botTells.ts";
import { goalsInWave, type BrainState, type Goal } from "../../content/robotGoals.ts";
import { TICK_HZ } from "../contract.ts";
import { datan2, PI } from "../dmath.ts";
import { hash32 } from "../rng.ts";
import type { RobotGoal } from "./brain.ts";

export interface RobotCatalogProfile {
  readonly archetypeId: string;
  readonly model: ModelId;
  readonly level: number;
  readonly intensity: number;
  readonly ownTellIds: readonly string[];
  readonly camouflageTellIds: readonly string[];
  readonly falseTellIds: readonly string[];
  readonly phase: number;
}
/** World-derived appearance identity, independent of a transient physical actor ID. */
export interface RobotCatalogSource { readonly seed: number; readonly key: string }

/** These have a concrete presentation consumer; other catalog behaviors stay explicitly pending. */
export const RENDERED_ROBOT_TELLS = Object.freeze(["emptyBag", "fullBag", "emptyBagHome", "trackPlayer", "pingGlance", "faceLightFlicker", "steadyFaceLight"]);
const rendered = new Set(RENDERED_ROBOT_TELLS);
const tells = new Map(BOT_TELLS.tells.map(tell => [tell.id, tell]));
const MODELS: Readonly<Record<string, ModelId | undefined>> = { footman: "errand-robot", trundle: "sidewalk-bot", robotaxi: "robotaxi" };
const candidates = new Map<string, string[]>();
for (const archetype of BOT_TELLS.archetypes) {
  const key = `${archetype.model}:${archetype.kind}`, list = candidates.get(key) ?? [];
  list.push(archetype.id); candidates.set(key, list);
}
for (const list of candidates.values()) list.sort();

/** Level is explicit. Wave unlocks mechanics; it never silently invents difficulty progression. */
export function robotCatalogProfile(seed: number, agentId: number, model: string, firmware: "good" | "bad", level = 1, archetypeId?: string): RobotCatalogProfile | null {
  const catalogModel = MODELS[model]; if (!catalogModel) return null;
  const compatible = candidates.get(`${catalogModel}:${firmware}`); if (!compatible?.length) return null;
  const selected = archetypeId ?? compatible[hash32(seed, agentId, 0x636174) % compatible.length]!;
  if (!compatible.includes(selected)) throw new RangeError("Catalog archetype must match robot model and firmware");
  const profile = botAtLevel(selected, level);
  const falsePool = profile.archetype.falseTells ?? [];
  // Only some good robots exhibit a false tell, and the choice is stable across reloads.
  const falseTell = firmware === "good" && falsePool.length && hash32(seed, agentId, 0x66616c) % 3 === 0 ?
    falsePool[hash32(seed, agentId, 0x676c69) % falsePool.length] : undefined;
  return { archetypeId: selected, model: catalogModel, level: profile.level, intensity: profile.intensity,
    ownTellIds: profile.tells.map(tell => tell.id), camouflageTellIds: profile.camouflage.map(tell => tell.id),
    falseTellIds: falseTell ? [falseTell] : [], phase: hash32(seed, agentId, 0x706861) };
}

export function validateRobotCatalogSource(source: RobotCatalogSource): void {
  if (!source || typeof source !== "object" || Array.isArray(source) || !Number.isSafeInteger(source.seed) || source.seed < 0 || source.seed > 0xffffffff ||
      typeof source.key !== "string" || source.key.length === 0 || source.key.length > 256) throw new RangeError("Invalid robot catalog source");
}

/** FNV-1a over exact UTF-16 code units; deterministic on Node and browsers. */
export function robotCatalogProfileForSource(source: RobotCatalogSource, model: string, firmware: "good" | "bad", level = 1, archetypeId?: string): RobotCatalogProfile | null {
  validateRobotCatalogSource(source);
  let identity = 0x811c9dc5;
  for (let index = 0; index < source.key.length; index++) identity = Math.imul(identity ^ source.key.charCodeAt(index), 0x01000193) >>> 0;
  return robotCatalogProfile(source.seed, identity, model, firmware, level, archetypeId);
}

export interface RobotTellObservation {
  readonly x: number;
  readonly z: number;
  readonly observedTick: number;
}
export interface RobotTellInput {
  readonly tick: number;
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly hideOneTell: boolean;
  readonly sabotageActive: boolean;
  /** Only actual visible-player or scan observations supplied by the sensing adapter. */
  readonly watchedTarget?: RobotTellObservation | null;
  readonly pingTarget?: RobotTellObservation | null;
  readonly returningFromDelivery?: boolean;
}
export interface RobotTellPresentation {
  readonly bagFull: boolean | null;
  /** Gain relative to normal authored arm/bag swing; hiding does not conjure groceries. */
  readonly bagSwing: number;
  /** Local Y rotation in radians, or null when the head should follow its ordinary pose. */
  readonly headYaw: number | null;
  readonly faceLight: number;
}
export interface RobotCatalogMetadata {
  readonly catalogArchetypeId: string;
  /** Effective implemented behaviors only; pending IDs are never claimed as visible. */
  readonly tellIds: readonly string[];
  readonly pendingTellIds: readonly string[];
  readonly hiddenTellId: string | null;
  readonly hideOneTell: boolean;
  readonly sabotageActive: boolean;
  readonly presentation: RobotTellPresentation;
}

function compatible(tell: Tell, profile: RobotCatalogProfile): boolean { return tell.models.includes(profile.model); }
function renderable(tell: Tell, profile: RobotCatalogProfile): boolean {
  return rendered.has(tell.id) && (tell.id !== "pingGlance" || profile.model === "errand-robot");
}
function headAngle(input: RobotTellInput, observation: RobotTellObservation | null | undefined, holdSeconds: number, radius: number): number | null {
  if (!observation || ![input.tick, input.x, input.z, input.heading, observation.x, observation.z, observation.observedTick].every(Number.isFinite) ||
      observation.observedTick > input.tick || input.tick - observation.observedTick > Math.round(holdSeconds * TICK_HZ)) return null;
  const dx = observation.x - input.x, dz = observation.z - input.z;
  if (dx * dx + dz * dz > radius * radius) return null;
  let angle = datan2(dx, -dz) - input.heading;
  while (angle > PI) angle -= 2 * PI;
  while (angle < -PI) angle += 2 * PI;
  return -Math.max(-1.1, Math.min(1.1, angle));
}

interface PresentationPlan {
  readonly tellIds: readonly string[];
  readonly pendingTellIds: readonly string[];
  readonly hiddenTellId: string | null;
  readonly bagFull: boolean | null;
  readonly bagSwing: number;
  readonly track: { readonly holdS: number; readonly radiusM: number } | null;
  readonly ping: { readonly holdS: number } | null;
  readonly blink: { readonly period: number; readonly hold: number } | null;
}
const presentationPlans = new WeakMap<RobotCatalogProfile, readonly PresentationPlan[]>();

function compilePresentation(profile: RobotCatalogProfile, hideOneTell: boolean, returningFromDelivery: boolean): PresentationPlan {
  const selected = [...new Set([...profile.ownTellIds, ...profile.camouflageTellIds, ...profile.falseTellIds])]
    .map(id => tells.get(id)).filter((tell): tell is Tell => !!tell && compatible(tell, profile)).slice(0, 6);
  const visibleOwn = selected.filter(tell => profile.ownTellIds.includes(tell.id) && renderable(tell, profile))
    .sort((a, b) => a.subtlety - b.subtlety || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const hiddenTellId = hideOneTell ? visibleOwn[0]?.id ?? null : null;
  const effective = selected.filter(tell => tell.id !== hiddenTellId);
  const active = effective.filter(tell => renderable(tell, profile) && (tell.id !== "emptyBagHome" || returningFromDelivery));
  const pendingTellIds = effective.filter(tell => !renderable(tell, profile)).map(tell => tell.id);
  const ids = new Set(active.map(tell => tell.id));
  const emptyBag = selected.some(tell => tell.id === "emptyBag") || ids.has("emptyBagHome");
  const bagFull = emptyBag ? false : ids.has("fullBag") ? true : null;
  let track: PresentationPlan["track"] = null, ping: PresentationPlan["ping"] = null, blink: PresentationPlan["blink"] = null;
  if (ids.has("trackPlayer")) {
    const behavior = tells.get("trackPlayer")!.behaviour;
    if (behavior.kind === "trackPlayer") track = { holdS: behavior.holdS, radiusM: behavior.radiusM };
  }
  if (ids.has("pingGlance")) {
    const behavior = tells.get("pingGlance")!.behaviour;
    if (behavior.kind === "glanceOnPing") ping = { holdS: behavior.holdS };
  }
  if (ids.has("faceLightFlicker")) {
    const behavior = tells.get("faceLightFlicker")!.behaviour;
    if (behavior.kind === "faceLightFlicker") blink = { period: Math.round(behavior.periodS * TICK_HZ), hold: Math.round(behavior.holdS * TICK_HZ) };
  }
  return { tellIds: active.map(tell => tell.id), pendingTellIds, hiddenTellId, bagFull,
    bagSwing: ids.has("emptyBag") || ids.has("emptyBagHome") ? 1 + profile.intensity : 1, track, ping, blink };
}

function presentationPlan(profile: RobotCatalogProfile, hideOneTell: boolean, returning: boolean): PresentationPlan {
  // Public profiles may be caller-owned and mutable, including nested tell arrays.
  // Only a fully immutable profile can safely keep compiled plans between calls.
  if (!Object.isFrozen(profile) || !Object.isFrozen(profile.ownTellIds) ||
      !Object.isFrozen(profile.camouflageTellIds) || !Object.isFrozen(profile.falseTellIds)) return compilePresentation(profile, hideOneTell, returning);
  let plans = presentationPlans.get(profile);
  if (!plans) {
    plans = [compilePresentation(profile, false, false), compilePresentation(profile, false, true),
      compilePresentation(profile, true, false), compilePresentation(profile, true, true)];
    presentationPlans.set(profile, plans);
  }
  return plans[(hideOneTell ? 2 : 0) + (returning ? 1 : 0)]!;
}

/** Pure, bounded presentation from real catalog entries and authoritative observation times. */
export function robotCatalogPresentation(profile: RobotCatalogProfile, input: RobotTellInput): RobotCatalogMetadata {
  const plan = presentationPlan(profile, input.hideOneTell, !!input.returningFromDelivery);
  let headYaw = plan.track ? headAngle(input, input.watchedTarget, plan.track.holdS, plan.track.radiusM) : null;
  if (plan.ping) headYaw = headAngle(input, input.pingTarget, plan.ping.holdS, 30) ?? headYaw;
  const faceLight = plan.blink && (input.tick + profile.phase % plan.blink.period) % plan.blink.period < plan.blink.hold ? 0 : 1;
  return { catalogArchetypeId: profile.archetypeId, tellIds: [...plan.tellIds], pendingTellIds: [...plan.pendingTellIds],
    hiddenTellId: plan.hiddenTellId, hideOneTell: input.hideOneTell, sabotageActive: input.sabotageActive,
    presentation: { bagFull: plan.bagFull, bagSwing: plan.bagSwing, headYaw, faceLight } };
}

export interface RobotGoalConditions {
  readonly unobserved?: boolean;
  readonly playerInSight?: boolean;
  readonly playerFar?: boolean;
  readonly playerInCar?: boolean;
  readonly goodRobotNear?: boolean;
  readonly meleeSlotFree?: boolean;
  readonly meleeSlotsFull?: boolean;
  readonly rain?: boolean;
  readonly fog?: boolean;
}
export interface RobotCatalogGoals { readonly weights: Readonly<Record<RobotGoal, number>>; readonly pendingGoalIds: readonly string[] }
const ATTACKS = new Set<RobotGoal>(["shove", "grocerySnatch", "adBlast", "handshake", "forcedUpdate", "phoneHack"]);
function supportedGoal(goal: Goal): RobotGoal | null {
  if (goal.goal === "attack" && goal.attack && ATTACKS.has(goal.attack as RobotGoal)) return goal.attack as RobotGoal;
  if (goal.goal === "sabotage" && goal.sabotage === "pushUpdate") return "forcedUpdate";
  if (goal.goal === "sabotage" && goal.sabotage === "snatchGroceries") return "grocerySnatch";
  return null;
}

/** Project existing content weights onto supported combat only; unsupported world effects stay pending. */
export function robotCatalogGoalWeights(profile: RobotCatalogProfile, state: BrainState, wave: number, conditions: RobotGoalConditions): RobotCatalogGoals {
  const weights: Record<RobotGoal, number> = { shove: 0, grocerySnatch: 0, adBlast: 0, handshake: 0, forcedUpdate: 0, phoneHack: 0 };
  if (!BOT_TELLS.archetypes.some(archetype => archetype.id === profile.archetypeId && archetype.kind === "bad")) return { weights, pendingGoalIds: [] };
  const pendingGoalIds: string[] = [];
  for (const goal of goalsInWave(profile.archetypeId, state, wave)) {
    if (goal.when !== "always" && conditions[goal.when] !== true) continue;
    const supported = supportedGoal(goal);
    if (supported) weights[supported] += goal.weight;
    else if (goal.goal === "attack" || goal.goal === "sabotage") pendingGoalIds.push(goal.attack ?? goal.sabotage!);
  }
  return { weights, pendingGoalIds: [...new Set(pendingGoalIds)].sort() };
}
