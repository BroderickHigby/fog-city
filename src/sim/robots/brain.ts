import { TICK_HZ } from "../contract.ts";
import { dcos, dsin, PI } from "../dmath.ts";

/** Pure policy only. A caller validates observations against the world and applies intents
 * through navigation, combat and person-clearance systems. This module moves no bodies. */
export type RobotBrainMode = "disguised" | "wary" | "alerted" | "attack" | "flee";
export type RobotArchetype = "footman" | "trundle" | "patrol";
export type RobotAttack = "shove" | "grocerySnatch" | "adBlast" | "phoneHack" | "handshake";
export type RobotGoal = RobotAttack | "forcedUpdate";
export interface BrainPoint { readonly x: number; readonly z: number }
export type BrainTarget = { readonly kind: "player"; readonly id: string } | { readonly kind: "robot"; readonly id: number };

interface SightBase extends BrainPoint { readonly lineOfSight: boolean }
export interface PlayerSight extends SightBase {
  readonly kind: "player";
  readonly id: string;
  readonly heading: number;
  readonly inVehicle: boolean;
  /** Visible hostile behaviour, supplied by the sensing adapter, not global heat. */
  readonly threatening: boolean;
}
export interface RobotSight extends SightBase {
  readonly kind: "robot";
  readonly id: number;
  readonly alignment: "good" | "bad";
  readonly operational: boolean;
}
export interface PersonSight extends SightBase { readonly kind: "person"; readonly id: number }
export type RobotSightObservation = PlayerSight | RobotSight | PersonSight;
export interface RobotSound extends BrainPoint { readonly kind: "spray" | "horn"; readonly playerId: string }
export interface RobotBroadcast {
  readonly sourceId: number;
  readonly sourcePosition: BrainPoint;
  readonly sourceSeized: boolean;
  readonly emittedTick: number;
  /** Original observation time. Forwarding a report must not refresh old knowledge. */
  readonly observedTick: number;
  readonly playerId: string;
  readonly position: BrainPoint;
}
export interface RobotScan extends BrainPoint { readonly playerId: string; readonly targetRobotId: number | null }
export interface RobotWatch extends BrainPoint { readonly playerId: string; readonly lineOfSight: boolean }
export interface RobotObservations {
  readonly sight: readonly RobotSightObservation[];
  readonly sounds: readonly RobotSound[];
  readonly broadcasts: readonly RobotBroadcast[];
  readonly scans: readonly RobotScan[];
  /** Present each tick that this robot is being watched. Gaps reset the close-watch timer. */
  readonly watches: readonly RobotWatch[];
}
export interface ConversionBudget {
  readonly withinFidelity: boolean;
  readonly protectedArea: boolean;
  readonly baseBadCount: number;
  readonly badCount: number;
  /** Other channels reserved by the caller, excluding this robot's existing channel. */
  readonly reservedCount?: number;
}
export interface RobotUpdateCompletion { readonly targetId: number; readonly completedTick: number }
export interface RobotBrainInput {
  readonly tick: number;
  readonly self: BrainPoint & { readonly heading: number; readonly rust: number; readonly fogDensity: number; readonly shoved: boolean };
  readonly observations: RobotObservations;
  readonly conversion: ConversionBudget;
  readonly fleetUpdate?: boolean;
  readonly meleeSlotsAvailable?: number;
  /** Completion intents applied by the authoritative reducer. Acknowledge only after
   * applying them; current sight should then reflect the resulting robot status. */
  readonly acknowledgedUpdates?: readonly RobotUpdateCompletion[];
  /** Content adapters may replace weights; unsupported attacks remain unavailable. */
  readonly goalWeights?: Readonly<Partial<Record<RobotGoal, number>>>;
}
export interface PlayerKnowledge extends BrainPoint {
  readonly playerId: string;
  readonly observedTick: number;
  readonly expiresTick: number;
  readonly channel: "sight" | "hearing" | "broadcast";
}
export interface CloseWatch { readonly playerId: string; readonly startedTick: number }
export interface RobotWindup { readonly target: BrainTarget; readonly attack: RobotAttack; readonly startedTick: number }
export interface RobotUpdateChannel { readonly targetId: number; readonly startedTick: number }
export interface RobotBrainState {
  readonly id: number;
  readonly archetype: RobotArchetype;
  readonly mode: RobotBrainMode;
  readonly modeSinceTick: number;
  readonly lastTick: number;
  readonly waryUntilTick: number;
  readonly knowledge: readonly PlayerKnowledge[];
  readonly closeWatches: readonly CloseWatch[];
  readonly windup: RobotWindup | null;
  readonly update: RobotUpdateChannel | null;
  readonly cooldownUntilTick: number;
  readonly fogChaseSinceTick: number | null;
  /** Bounded unacknowledged completion intents, not permanent immunity from future updates. */
  readonly pendingUpdates: readonly RobotUpdateCompletion[];
}
export type RobotMovementIntent =
  | { readonly kind: "errand"; readonly avoidFog: boolean }
  | { readonly kind: "hold"; readonly face: BrainPoint | null; readonly avoidFog: boolean }
  | { readonly kind: "pursue"; readonly target: BrainTarget; readonly destination: BrainPoint; readonly stopDistance: number; readonly avoidFog: boolean }
  | { readonly kind: "flee"; readonly from: BrainPoint | null; readonly toward: BrainPoint | null; readonly avoidFog: boolean };
export type RobotActionIntent =
  | { readonly kind: "none" }
  | { readonly kind: "windup"; readonly attack: RobotAttack; readonly target: BrainTarget; readonly remainingTicks: number }
  | { readonly kind: "attack"; readonly attack: RobotAttack; readonly target: BrainTarget }
  | { readonly kind: "update"; readonly targetId: number; readonly phase: "start" | "channel" | "complete"; readonly progress: number }
  | { readonly kind: "cancel"; readonly activity: "attack" | "update"; readonly reason: "contact" | "rust" | "shove" | "cap" | "state" };
export interface RobotBrainIntent {
  readonly movement: RobotMovementIntent;
  readonly action: RobotActionIntent;
  readonly hideOneTell: boolean;
  readonly sabotageActive: boolean;
  /** Combat may use this multiplier; the brain never changes rust itself. */
  readonly fogRustMultiplier: 1 | 3;
}
export interface RobotBrainStep { readonly state: RobotBrainState; readonly intent: RobotBrainIntent }
export interface RobotBrainOptions { readonly id: number; readonly archetype?: RobotArchetype; readonly tick?: number }

export const ROBOT_MEMORY_TICKS = 10 * TICK_HZ;
export const ROBOT_WARY_TICKS = 10 * TICK_HZ;
export const ROBOT_UPDATE_TICKS = 6 * TICK_HZ;
export const ROBOT_FOG_CHASE_TICKS = 8 * TICK_HZ;
/** A robot is "in fog" above this density (bot-tells.json avoidFog densityAbove; Marine Layer's threshold). Thinner haze only shortens sight. */
export const ROBOT_FOG_DENSITY = 0.4;
export const ROBOT_MAX_PENDING_UPDATES = 8;
/** This policy supports at most the documented 24 simultaneous players. */
export const ROBOT_MAX_KNOWN_PLAYERS = 24;
const WATCH_TICKS = 3 * TICK_HZ;
const HALF_SIGHT_COS = dcos(50 * PI / 180);
const MELEE: readonly RobotAttack[] = ["shove", "grocerySnatch", "handshake"];
const GOALS: readonly RobotGoal[] = ["forcedUpdate", "shove", "grocerySnatch", "handshake", "adBlast", "phoneHack"];
const ATTACKS: Readonly<Record<RobotAttack, { readonly range: number; readonly windup: number; readonly robotsOnly: boolean }>> = {
  shove: { range: 1.5, windup: Math.round(0.6 * TICK_HZ), robotsOnly: false },
  grocerySnatch: { range: 1, windup: Math.round(0.5 * TICK_HZ), robotsOnly: true },
  adBlast: { range: 8, windup: Math.round(0.8 * TICK_HZ), robotsOnly: false },
  phoneHack: { range: 4, windup: Math.round(0.5 * TICK_HZ), robotsOnly: false },
  handshake: { range: 1.2, windup: Math.round(0.5 * TICK_HZ), robotsOnly: false },
};
/** Deterministic priority weights, with stable GOALS-order ties. Content can override weights. */
export const ROBOT_GOAL_WEIGHTS: Readonly<Record<RobotArchetype, Readonly<Record<RobotGoal, number>>>> = {
  footman: { forcedUpdate: 8, shove: 6, grocerySnatch: 5, handshake: 4, adBlast: 3, phoneHack: 2 },
  trundle: { forcedUpdate: 8, shove: 0, grocerySnatch: 5, handshake: 0, adBlast: 0, phoneHack: 2 },
  patrol: { forcedUpdate: 0, shove: 6, grocerySnatch: 0, handshake: 4, adBlast: 0, phoneHack: 0 },
};

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(label);
}
function point(value: BrainPoint): void {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.z)) throw new RangeError("non-finite observation position");
}
function playerId(id: string): void {
  if (typeof id !== "string" || id.length === 0) throw new RangeError("empty player id");
}
function unit(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(label);
}
function boolean(value: boolean, label: string): void {
  if (typeof value !== "boolean") throw new RangeError(label);
}
/** Reject malformed numeric data before it can poison a serializable deterministic state. */
function validateInput(state: RobotBrainState, input: RobotBrainInput): void {
  integer(input.tick, "tick");
  if (input.tick <= state.lastTick) throw new RangeError("brain tick must increase");
  point(input.self);
  unit(input.self.rust, "rust");
  unit(input.self.fogDensity, "fog density");
  boolean(input.self.shoved, "shoved");
  if (!Number.isFinite(input.self.heading)) throw new RangeError("heading");
  boolean(input.conversion.withinFidelity, "fidelity flag");
  boolean(input.conversion.protectedArea, "protected area flag");
  if (input.fleetUpdate !== undefined) boolean(input.fleetUpdate, "fleet update flag");
  integer(input.conversion.baseBadCount, "base bad count");
  integer(input.conversion.badCount, "bad count");
  integer(input.conversion.reservedCount ?? 0, "reserved count");
  integer(input.meleeSlotsAvailable ?? 2, "melee slots");
  for (const completion of input.acknowledgedUpdates ?? []) {
    integer(completion.targetId, "acknowledged update id");
    integer(completion.completedTick, "acknowledged update tick");
  }
  for (const goal of GOALS) {
    const weight = input.goalWeights?.[goal];
    if (weight !== undefined && (!Number.isFinite(weight) || weight < 0)) throw new RangeError("goal weight");
  }
  const seen = new Set<string>();
  for (const observation of input.observations.sight) {
    point(observation);
    boolean(observation.lineOfSight, "sight line of sight");
    if (observation.kind === "player") {
      playerId(observation.id);
      if (!Number.isFinite(observation.heading)) throw new RangeError("player heading");
      boolean(observation.inVehicle, "player vehicle flag");
      boolean(observation.threatening, "player threat flag");
    } else if (observation.kind === "robot" || observation.kind === "person") {
      integer(observation.id, "observed id");
      if (observation.kind === "robot") {
        if (observation.alignment !== "good" && observation.alignment !== "bad") throw new RangeError("robot alignment");
        boolean(observation.operational, "robot operational flag");
      }
    } else throw new RangeError("sight kind");
    const key = `${observation.kind}:${observation.id}`;
    if (seen.has(key)) throw new RangeError("duplicate sight observation");
    seen.add(key);
  }
  for (const sound of input.observations.sounds) {
    point(sound); playerId(sound.playerId);
    if (sound.kind !== "spray" && sound.kind !== "horn") throw new RangeError("sound kind");
  }
  for (const broadcast of input.observations.broadcasts) {
    integer(broadcast.sourceId, "broadcast source");
    integer(broadcast.emittedTick, "broadcast emission");
    integer(broadcast.observedTick, "broadcast observation");
    boolean(broadcast.sourceSeized, "broadcast seized flag");
    point(broadcast.sourcePosition); point(broadcast.position); playerId(broadcast.playerId);
  }
  const watched = new Set<string>();
  for (const watch of input.observations.watches) {
    point(watch); playerId(watch.playerId);
    boolean(watch.lineOfSight, "watch line of sight");
    if (watched.has(watch.playerId)) throw new RangeError("duplicate watch observation");
    watched.add(watch.playerId);
  }
  for (const scan of input.observations.scans) {
    point(scan); playerId(scan.playerId);
    if (scan.targetRobotId !== null) integer(scan.targetRobotId, "scan target");
  }
}
function distanceSq(a: BrainPoint, b: BrainPoint): number {
  const x = a.x - b.x, z = a.z - b.z;
  return x * x + z * z;
}
function inCone(observer: BrainPoint, heading: number, target: BrainPoint, range: number): boolean {
  const dx = target.x - observer.x, dz = target.z - observer.z;
  const sq = dx * dx + dz * dz;
  if (sq > range * range) return false;
  if (sq === 0) return true;
  return dx * dsin(heading) - dz * dcos(heading) >= Math.sqrt(sq) * HALF_SIGHT_COS;
}
function copyPoint(value: BrainPoint): BrainPoint { return { x: value.x, z: value.z }; }
function compareString(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function targetEqual(a: BrainTarget, b: BrainTarget): boolean { return a.kind === b.kind && a.id === b.id; }
function visible(input: RobotBrainInput): RobotSightObservation[] {
  const range = 30 * (1 - 0.6 * input.self.fogDensity);
  return input.observations.sight.filter((o) => o.lineOfSight && inCone(input.self, input.self.heading, o, range));
}
function canConvert(input: RobotBrainInput): boolean {
  const budget = input.conversion;
  const cap = budget.baseBadCount * (budget.protectedArea ? 1 : 2);
  return budget.withinFidelity && budget.badCount + (budget.reservedCount ?? 0) < cap;
}
function remember(knowledge: PlayerKnowledge[], observation: PlayerKnowledge): void {
  const index = knowledge.findIndex((k) => k.playerId === observation.playerId);
  const prior = knowledge[index];
  const rank = { broadcast: 0, hearing: 1, sight: 2 };
  // Coordinate ties are explicit, so input-array order cannot decide a remembered position.
  if (prior && (prior.observedTick > observation.observedTick ||
      (prior.observedTick === observation.observedTick && (rank[prior.channel] > rank[observation.channel] ||
      (rank[prior.channel] === rank[observation.channel] && (prior.x < observation.x || (prior.x === observation.x && prior.z <= observation.z))))))) return;
  if (index < 0) knowledge.push(observation);
  else knowledge[index] = observation;
}
function weight(state: RobotBrainState, input: RobotBrainInput, goal: RobotGoal): number {
  const base = ROBOT_GOAL_WEIGHTS[state.archetype][goal];
  return base === 0 ? 0 : (input.goalWeights?.[goal] ?? base);
}
function chooseAttack(state: RobotBrainState, input: RobotBrainInput, target: BrainTarget, distance: number): RobotAttack | null {
  let chosen: RobotAttack | null = null, best = 0;
  for (const goal of GOALS) {
    if (goal === "forcedUpdate") continue;
    const spec = ATTACKS[goal];
    if (distance > spec.range || (spec.robotsOnly && target.kind !== "robot")) continue;
    if (target.kind === "player" && MELEE.includes(goal) && (input.meleeSlotsAvailable ?? 2) === 0) continue;
    const priority = weight(state, input, goal);
    if (priority > best) { chosen = goal; best = priority; }
  }
  return chosen;
}
function maximumAttackRange(state: RobotBrainState, input: RobotBrainInput, target: BrainTarget): number {
  let range = 0;
  for (const goal of GOALS) {
    if (goal === "forcedUpdate" || weight(state, input, goal) === 0) continue;
    if (ATTACKS[goal].robotsOnly && target.kind !== "robot") continue;
    if (target.kind === "player" && MELEE.includes(goal) && (input.meleeSlotsAvailable ?? 2) === 0) continue;
    range = Math.max(range, ATTACKS[goal].range);
  }
  return range;
}

export function createRobotBrain(options: RobotBrainOptions): RobotBrainState {
  integer(options.id, "robot id");
  if (options.archetype !== undefined && options.archetype !== "footman" && options.archetype !== "trundle" && options.archetype !== "patrol") {
    throw new RangeError("robot archetype");
  }
  const tick = options.tick ?? 0;
  integer(tick, "initial tick");
  return {
    id: options.id, archetype: options.archetype ?? "footman", mode: "disguised", modeSinceTick: tick,
    lastTick: tick - 1, waryUntilTick: 0, knowledge: [], closeWatches: [], windup: null,
    update: null, cooldownUntilTick: 0, fogChaseSinceTick: null, pendingUpdates: [],
  };
}

export function stepRobotBrain(previous: RobotBrainState, input: RobotBrainInput): RobotBrainStep {
  validateInput(previous, input);
  const tick = input.tick, consecutive = tick === previous.lastTick + 1;
  const sight = visible(input);
  const players = sight.filter((o): o is PlayerSight => o.kind === "player");
  const robots = sight.filter((o): o is RobotSight => o.kind === "robot" && o.id !== previous.id && o.operational);
  const knowledge = previous.knowledge.filter((k) => tick < k.expiresTick).map((k) => ({ ...k }));
  let alarm = false;
  for (const player of players) {
    remember(knowledge, { playerId: player.id, x: player.x, z: player.z, observedTick: tick, expiresTick: tick + ROBOT_MEMORY_TICKS, channel: "sight" });
    alarm = alarm || player.threatening;
  }
  for (const sound of input.observations.sounds) {
    const range = sound.kind === "spray" ? 20 : 40;
    if (distanceSq(input.self, sound) > range * range) continue;
    remember(knowledge, { playerId: sound.playerId, x: sound.x, z: sound.z, observedTick: tick, expiresTick: tick + ROBOT_MEMORY_TICKS, channel: "hearing" });
    alarm = alarm || sound.kind === "spray";
  }
  for (const broadcast of input.observations.broadcasts) {
    if (!broadcast.sourceSeized || broadcast.sourceId === previous.id || distanceSq(input.self, broadcast.sourcePosition) > 60 * 60 ||
        broadcast.emittedTick > tick || broadcast.emittedTick < tick - 1 || broadcast.observedTick > broadcast.emittedTick ||
        tick >= broadcast.observedTick + ROBOT_MEMORY_TICKS) continue;
    remember(knowledge, { playerId: broadcast.playerId, ...copyPoint(broadcast.position), observedTick: broadcast.observedTick,
      expiresTick: broadcast.observedTick + ROBOT_MEMORY_TICKS, channel: "broadcast" });
    alarm = true;
  }
  // Churn in player identities cannot grow saved state. Retain the freshest evidence,
  // breaking equal-time ties by ID so observation order never decides eviction.
  knowledge.sort((a, b) => b.observedTick - a.observedTick || compareString(a.playerId, b.playerId));
  if (knowledge.length > ROBOT_MAX_KNOWN_PLAYERS) knowledge.length = ROBOT_MAX_KNOWN_PLAYERS;
  knowledge.sort((a, b) => compareString(a.playerId, b.playerId));
  const nearestMemory = [...knowledge].sort((a, b) => distanceSq(input.self, a) - distanceSq(input.self, b) || compareString(a.playerId, b.playerId))[0];
  let waryUntilTick = previous.waryUntilTick;
  const closeWatches: CloseWatch[] = [];
  for (const watch of input.observations.watches) {
    if (!watch.lineOfSight || distanceSq(input.self, watch) > 10 * 10) continue;
    const prior = consecutive ? previous.closeWatches.find((w) => w.playerId === watch.playerId) : undefined;
    const startedTick = prior?.startedTick ?? tick;
    closeWatches.push({ playerId: watch.playerId, startedTick });
    if (tick - startedTick > WATCH_TICKS) waryUntilTick = tick + ROBOT_WARY_TICKS;
  }
  closeWatches.sort((a, b) => compareString(a.playerId, b.playerId));
  // Every retained watch was observed this tick, so ID resolves equal-recency ties.
  if (closeWatches.length > ROBOT_MAX_KNOWN_PLAYERS) closeWatches.length = ROBOT_MAX_KNOWN_PLAYERS;
  for (const scan of input.observations.scans) {
    const distance = distanceSq(input.self, scan);
    if (distance <= 30 * 30) waryUntilTick = tick + ROBOT_WARY_TICKS;
    if (scan.targetRobotId === previous.id && distance <= 10 * 10) alarm = true;
  }

  let mode: RobotBrainMode = previous.mode;
  const avoidFog = input.fleetUpdate !== true;
  let fogChaseSinceTick = previous.fogChaseSinceTick;
  const currentPlayer = nearestMemory && players.find((p) => p.id === nearestMemory.playerId);
  const wasHostile = previous.mode === "alerted" || previous.mode === "attack";
  if (wasHostile && nearestMemory) mode = "attack";
  else if (alarm) mode = "alerted";
  else mode = tick < waryUntilTick ? "wary" : "disguised";
  const inFog = input.self.fogDensity > ROBOT_FOG_DENSITY;
  if (!avoidFog || !inFog) fogChaseSinceTick = null;
  else if ((mode === "attack" || mode === "alerted") && currentPlayer) fogChaseSinceTick ??= tick;
  // A rusted robot keeps fleeing while damaged; fog permits pursuit only with current sight.
  const fogBreakoff = avoidFog && inFog &&
    (!(mode === "attack" || mode === "alerted") || !currentPlayer || (fogChaseSinceTick !== null && tick - fogChaseSinceTick >= ROBOT_FOG_CHASE_TICKS));
  if (input.self.rust >= 0.6 || fogBreakoff) mode = "flee";
  const movementAvoidFog = avoidFog && !(mode === "attack" && currentPlayer && inFog);

  let windup: RobotWindup | null = null;
  let update: RobotUpdateChannel | null = null;
  let cooldownUntilTick = previous.cooldownUntilTick;
  const acknowledgements = input.acknowledgedUpdates ?? [];
  const pendingUpdates = previous.pendingUpdates.filter((pending) =>
    !acknowledgements.some((ack) => ack.targetId === pending.targetId && ack.completedTick === pending.completedTick) &&
    !sight.some((o) => o.kind === "robot" && o.id === pending.targetId && (o.alignment !== "good" || !o.operational)))
    .map((pending) => ({ ...pending }));
  const conversionAvailable = canConvert(input) && pendingUpdates.length < ROBOT_MAX_PENDING_UPDATES;
  let movement: RobotMovementIntent = { kind: "errand", avoidFog: movementAvoidFog };
  let action: RobotActionIntent = { kind: "none" };
  let sabotageActive = false;
  const observed = players.some((p) => !p.inVehicle && inCone(p, p.heading, input.self, 20));
  const goodRobots = robots.filter((r) => r.alignment === "good" && distanceSq(input.self, r) <= 10 * 10)
    .sort((a, b) => distanceSq(input.self, a) - distanceSq(input.self, b) || a.id - b.id);
  const hostile = mode === "attack" || mode === "alerted";
  const playerTarget = hostile && nearestMemory && distanceSq(input.self, nearestMemory) <= 15 * 15 ? nearestMemory : undefined;
  const maySabotage = (mode === "disguised" && !observed) || hostile;

  // An existing channel is checked before choosing a fresh target. Failed channels cannot
  // restart on the same tick, even when a second eligible robot is nearby.
  if (previous.update) {
    const target = robots.find((r) => r.id === previous.update?.targetId && r.alignment === "good");
    const reason = input.self.rust >= 0.2 ? "rust" : input.self.shoved ? "shove" : !conversionAvailable ? "cap" :
      (!consecutive || !target || distanceSq(input.self, target) > 9) ? "contact" :
      (!maySabotage || !!playerTarget || mode === "alerted" || mode === "flee" || mode === "wary") ? "state" : null;
    if (reason) action = { kind: "cancel", activity: "update", reason };
    else if (target) {
      const elapsed = tick - previous.update.startedTick;
      movement = { kind: "hold", face: copyPoint(target), avoidFog: movementAvoidFog };
      sabotageActive = true;
      if (elapsed >= ROBOT_UPDATE_TICKS) {
        action = { kind: "update", targetId: target.id, phase: "complete", progress: 1 };
        pendingUpdates.push({ targetId: target.id, completedTick: tick });
        pendingUpdates.sort((a, b) => a.targetId - b.targetId);
      } else {
        update = { ...previous.update };
        action = { kind: "update", targetId: target.id, phase: "channel", progress: elapsed / ROBOT_UPDATE_TICKS };
      }
    }
  }

  let target: BrainTarget | null = null;
  let destination: BrainPoint | null = null;
  let contact: PlayerSight | RobotSight | undefined;
  if (mode === "flee") {
    const ally = robots.filter((r) => r.alignment === "bad").sort((a, b) => distanceSq(input.self, a) - distanceSq(input.self, b) || a.id - b.id)[0];
    movement = { kind: "flee", from: nearestMemory ? copyPoint(nearestMemory) : null, toward: ally ? copyPoint(ally) : null, avoidFog: movementAvoidFog };
  } else if (playerTarget) {
    target = { kind: "player", id: playerTarget.playerId };
    destination = copyPoint(playerTarget);
    contact = players.find((p) => p.id === playerTarget.playerId);
  } else if (maySabotage && goodRobots[0]) {
    const robot = goodRobots[0];
    target = { kind: "robot", id: robot.id }; destination = copyPoint(robot); contact = robot;
  } else if (hostile && nearestMemory) {
    movement = { kind: "pursue", target: { kind: "player", id: nearestMemory.playerId }, destination: copyPoint(nearestMemory), stopDistance: 1, avoidFog: movementAvoidFog };
  }

  if (target && destination && !previous.update) {
    const targetId = target.id;
    const distance = Math.sqrt(distanceSq(input.self, destination));
    const attack = chooseAttack(previous, input, target, distance);
    const conversionPriority = weight(previous, input, "forcedUpdate");
    const converting = target.kind === "robot" && conversionPriority > 0 &&
      conversionPriority >= (attack ? weight(previous, input, attack) : 0) && conversionAvailable &&
      input.self.rust < 0.2 && !input.self.shoved && !pendingUpdates.some((pending) => pending.targetId === targetId);
    const stopDistance = converting ? 3 : maximumAttackRange(previous, input, target);
    movement = { kind: "pursue", target, destination, stopDistance, avoidFog: movementAvoidFog };
    if (mode === "alerted") movement = { kind: "hold", face: destination, avoidFog: movementAvoidFog };
    else if (converting && contact && distance <= 3) {
      update = { targetId: target.id as number, startedTick: tick };
      movement = { kind: "hold", face: destination, avoidFog: movementAvoidFog };
      action = { kind: "update", targetId: target.id as number, phase: "start", progress: 0 };
      sabotageActive = true;
    } else if (!converting && attack && contact && tick >= cooldownUntilTick && !input.self.shoved) {
      const prior = previous.windup;
      windup = consecutive && prior && prior.attack === attack && targetEqual(prior.target, target) ? { ...prior, target: { ...target } } : { target: { ...target }, attack, startedTick: tick };
      const remainingTicks = ATTACKS[attack].windup - (tick - windup.startedTick);
      movement = { kind: "hold", face: destination, avoidFog: movementAvoidFog };
      sabotageActive = target.kind === "robot";
      if (remainingTicks <= 0) {
        action = { kind: "attack", attack, target: { ...target } };
        windup = null; cooldownUntilTick = tick + TICK_HZ;
      } else action = { kind: "windup", attack, target: { ...target }, remainingTicks };
    }
  }
  if (previous.windup && !windup && action.kind === "none") {
    action = { kind: "cancel", activity: "attack", reason: input.self.shoved ? "shove" : mode === "flee" || mode === "wary" ? "state" : "contact" };
  }
  const state: RobotBrainState = {
    ...previous, mode, modeSinceTick: mode === previous.mode ? previous.modeSinceTick : tick,
    lastTick: tick, waryUntilTick, knowledge, closeWatches, windup, update, cooldownUntilTick,
    fogChaseSinceTick, pendingUpdates,
  };
  return { state, intent: { movement, action, hideOneTell: mode === "wary", sabotageActive,
    fogRustMultiplier: mode === "attack" && avoidFog && inFog ? 3 : 1 } };
}
