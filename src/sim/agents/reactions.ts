// Reactions consume sensed facts and propose velocity. Clearance/dodge remains the final mover.
export type ReactionKind = "person" | "good-robot" | "pigeon" | "dog";
export type ReactionMode = "idle" | "glance" | "startle" | "avoid";

export interface ReactionBody {
  readonly kind: ReactionKind;
  readonly child?: boolean;
  readonly posture?: "standing" | "seated" | "lying";
  readonly mobilityAid?: boolean;
}

export interface DogLeash {
  readonly ownerId: string;
  readonly ownerX: number;
  readonly ownerZ: number;
  readonly lengthM: number;
}

export interface ReactionActor extends ReactionBody {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly wet: boolean;
  readonly leash?: DogLeash;
}

/** No reaction reads other world actors: the caller supplies only observed/heard stimuli. */
export interface PerceivedStimulus {
  readonly sourceId: string;
  readonly kind: "spray" | "horn" | "ping" | "vehicle" | "nearby";
  readonly x: number;
  readonly z: number;
  readonly seen: boolean;
  readonly heard: boolean;
  readonly waterContact?: boolean;
  readonly speedMps?: number;
}

export interface ReactionSource { readonly id: string; readonly x: number; readonly z: number }
export interface ReactionState {
  readonly mode: ReactionMode;
  readonly untilTick: number;
  readonly source: ReactionSource | null;
}

export interface MovementIntent {
  readonly kind: "hold" | "velocity";
  readonly vx: number;
  readonly vz: number;
  readonly reason: "idle" | "routine" | "reaction" | "leash" | "dodge" | "posture";
}

export interface ReactionResult {
  readonly state: ReactionState;
  readonly movement: MovementIntent;
  readonly wet: boolean;
  readonly waterEligible: boolean;
}

export const IDLE_REACTION: ReactionState = { mode: "idle", untilTick: 0, source: null };

/** Mirrors the no-touch category rule; combat must also filter before creating water contact. */
export function canReceiveWater(body: ReactionBody): boolean {
  if (body.kind === "pigeon" || body.kind === "dog") return false;
  if (body.kind === "good-robot") return true;
  return !body.child && !body.mobilityAid && (body.posture ?? "standing") === "standing";
}

interface Candidate {
  stimulus: PerceivedStimulus;
  mode: ReactionMode;
  priority: number;
  distanceSq: number;
  duration: number;
}

const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/**
 * The widest radius any stimulus registers at, squared (the horn's 40 m in sense()). Past it
 * sense() returns null for every kind, so a caller may skip building those stimuli.
 */
export const STIMULUS_REACH_SQ = 1600;

function sense(actor: ReactionActor, stimulus: PerceivedStimulus): Candidate | null {
  if (!stimulus.seen && !stimulus.heard) return null;
  const dx = actor.x - stimulus.x;
  const dz = actor.z - stimulus.z;
  const distanceSq = dx * dx + dz * dz;
  if (stimulus.kind === "vehicle" && stimulus.seen && (stimulus.speedMps ?? 0) > 0.5 && distanceSq <= 100) {
    return { stimulus, mode: "avoid", priority: 4, distanceSq, duration: 60 };
  }
  if (stimulus.kind === "spray" && distanceSq <= 400) {
    return { stimulus, mode: "avoid", priority: 3, distanceSq, duration: 90 };
  }
  if (stimulus.kind === "horn" && stimulus.heard && distanceSq <= STIMULUS_REACH_SQ) {
    return { stimulus, mode: "startle", priority: 2, distanceSq, duration: 18 };
  }
  if (stimulus.kind === "ping" && actor.kind === "good-robot" && distanceSq <= 900) {
    return { stimulus, mode: "glance", priority: 1, distanceSq, duration: 30 };
  }
  if (stimulus.kind === "nearby" && stimulus.seen && distanceSq <= 25) {
    return { stimulus, mode: "glance", priority: 0, distanceSq, duration: 30 };
  }
  return null;
}

function awayDirection(actor: ReactionActor, source: ReactionSource): { x: number; z: number } {
  const dx = actor.x - source.x;
  const dz = actor.z - source.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  if (distance > 1e-9) return { x: dx / distance, z: dz / distance };
  let hash = 0;
  for (let i = 0; i < actor.id.length; i++) hash = (Math.imul(hash, 31) + actor.id.charCodeAt(i)) | 0;
  const direction = hash & 3;
  return { x: direction === 0 ? 1 : direction === 2 ? -1 : 0, z: direction === 1 ? 1 : direction === 3 ? -1 : 0 };
}

/** A valid attached dog starts inside its leash radius; invalid inputs cannot cause a snap. */
export function constrainLeashedIntent(
  actor: ReactionActor, velocity: { readonly vx: number; readonly vz: number }, stepSeconds: number,
): MovementIntent {
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0 ||
    !Number.isFinite(velocity.vx) || !Number.isFinite(velocity.vz) ||
    !Number.isFinite(actor.x) || !Number.isFinite(actor.z)) throw new Error("Invalid leash step");
  const leash = actor.leash;
  if (!leash || !Number.isFinite(leash.lengthM) || leash.lengthM <= 0 ||
    !Number.isFinite(leash.ownerX) || !Number.isFinite(leash.ownerZ)) throw new Error("Dog requires a valid leash");
  const dx = actor.x - leash.ownerX;
  const dz = actor.z - leash.ownerZ;
  if (!Number.isFinite(dx * dx + dz * dz) || !Number.isFinite(leash.lengthM * leash.lengthM)) {
    throw new Error("Invalid leash geometry");
  }
  if (dx * dx + dz * dz > leash.lengthM * leash.lengthM + 1e-8) throw new Error("Dog starts outside its leash");
  const nextX = dx + velocity.vx * stepSeconds;
  const nextZ = dz + velocity.vz * stepSeconds;
  const nextLength = Math.sqrt(nextX * nextX + nextZ * nextZ);
  if (!Number.isFinite(nextLength)) throw new Error("Invalid leash step");
  if (nextLength <= leash.lengthM) {
    return { kind: velocity.vx === 0 && velocity.vz === 0 ? "hold" : "velocity", ...velocity, reason: "reaction" };
  }
  const scale = leash.lengthM / nextLength;
  const vx = (nextX * scale - dx) / stepSeconds;
  const vz = (nextZ * scale - dz) / stepSeconds;
  if (!Number.isFinite(vx) || !Number.isFinite(vz)) throw new Error("Invalid leash step");
  return { kind: vx === 0 && vz === 0 ? "hold" : "velocity", vx, vz, reason: "leash" };
}

export interface ReactionInput {
  readonly actor: ReactionActor;
  readonly state: ReactionState;
  readonly stimuli: ReadonlyArray<PerceivedStimulus>;
  readonly tick: number;
  readonly dodgeOverrideActive: boolean;
  readonly stepSeconds?: number;
  /** Already path-constrained routine velocity, used only while idle. */
  readonly routineVelocity?: { readonly vx: number; readonly vz: number };
}

export function reactToPerception(input: ReactionInput): ReactionResult {
  const { actor, tick } = input;
  const stepSeconds = input.stepSeconds ?? 1 / 60;
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0 || !Number.isSafeInteger(tick) || tick < 0 ||
    !Number.isFinite(actor.x) || !Number.isFinite(actor.z) ||
    !Number.isSafeInteger(input.state.untilTick) || input.state.untilTick < 0 ||
    (input.state.source !== null && (!Number.isFinite(input.state.source.x) || !Number.isFinite(input.state.source.z))) ||
    input.stimuli.some((stimulus) => !Number.isFinite(stimulus.x) || !Number.isFinite(stimulus.z) ||
      (stimulus.speedMps !== undefined && (!Number.isFinite(stimulus.speedMps) || stimulus.speedMps < 0))) ||
    (input.routineVelocity !== undefined &&
      (!Number.isFinite(input.routineVelocity.vx) || !Number.isFinite(input.routineVelocity.vz)))) {
    throw new Error("Invalid reaction step");
  }
  const candidates = input.stimuli.map((stimulus) => sense(actor, stimulus)).filter((value): value is Candidate => value !== null);
  candidates.sort((a, b) => b.priority - a.priority || a.distanceSq - b.distanceSq ||
    compareId(a.stimulus.sourceId, b.stimulus.sourceId) || compareId(a.stimulus.kind, b.stimulus.kind) ||
    a.stimulus.x - b.stimulus.x || a.stimulus.z - b.stimulus.z);
  const selected = candidates[0];
  let state = input.state;
  const modePriority: Record<ReactionMode, number> = { idle: -1, glance: 0, startle: 1, avoid: 2 };
  if (selected && (tick >= state.untilTick || modePriority[selected.mode] >= modePriority[state.mode])) {
    state = { mode: selected.mode, untilTick: Math.min(Number.MAX_SAFE_INTEGER, tick + selected.duration),
      source: { id: selected.stimulus.sourceId, x: selected.stimulus.x, z: selected.stimulus.z } };
  } else if (tick >= state.untilTick) {
    state = state.mode === "startle" && state.source ?
      { mode: "avoid", untilTick: Math.min(Number.MAX_SAFE_INTEGER, tick + 60), source: state.source } : IDLE_REACTION;
  }
  const waterEligible = canReceiveWater(actor);
  const wet = waterEligible && (actor.wet || candidates.some(({ stimulus }) => stimulus.kind === "spray" && stimulus.waterContact));
  const hold = (reason: MovementIntent["reason"]): ReactionResult =>
    ({ state, movement: { kind: "hold", vx: 0, vz: 0, reason }, wet, waterEligible });
  // This wins even for a leashed animal: the clearance owner resolves the paired owner/dog move.
  if (input.dodgeOverrideActive) return hold("dodge");
  if (actor.posture === "seated" || actor.posture === "lying") return hold("posture");
  let vx = 0;
  let vz = 0;
  let reason: MovementIntent["reason"] = "idle";
  if (state.mode === "avoid" && state.source) {
    const direction = awayDirection(actor, state.source);
    const speed = actor.kind === "pigeon" ? 3.5 : actor.kind === "dog" ? 2.5 : actor.kind === "good-robot" ? 1.4 : 1.6;
    vx = direction.x * speed;
    vz = direction.z * speed;
    reason = "reaction";
  } else if (state.mode === "idle" && input.routineVelocity) {
    vx = input.routineVelocity.vx;
    vz = input.routineVelocity.vz;
    reason = "routine";
  }
  if (!Number.isFinite(vx) || !Number.isFinite(vz)) throw new Error("Invalid reaction velocity");
  if (actor.kind === "dog") {
    const constrained = constrainLeashedIntent(actor, { vx, vz }, stepSeconds);
    return { state, movement: { ...constrained, reason: constrained.reason === "leash" ? "leash" : reason }, wet, waterEligible };
  }
  return { state, movement: { kind: vx === 0 && vz === 0 ? "hold" : "velocity", vx, vz, reason }, wet, waterEligible };
}
