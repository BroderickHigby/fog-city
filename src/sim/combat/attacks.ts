import { DT, FIDELITY_RADIUS, emit, initialTarget, newlyPressed, playerById } from "./shared.ts";
import type {
  AttackKind, AttackRequest, CombatActor, CombatContext, CombatInputs, CombatPlayer,
  CombatState, PendingAttack, RobotModel, TargetCombat, Vec3,
} from "./types.ts";

/** Ad expiry is a tuning value: ten seconds, or one deliberate close per popup. */
export const AD_POPUP_TICKS = 600;
export const HANDSHAKE_TICKS = 120;
export const MAX_ATTACK_SOURCES = 4096;
export const MAX_PENDING_ATTACKS = 512;

interface AttackSpec { range: number; windup: number; models: readonly RobotModel[]; melee: boolean }
export const ATTACK_SPECS: Readonly<Record<AttackKind, AttackSpec>> = {
  shove: { range: 1.5, windup: 36, models: ["footman", "patrol"], melee: true },
  snatch: { range: 1, windup: 30, models: ["footman", "trundle"], melee: false },
  "ad-blast": { range: 8, windup: 48, models: ["footman", "drone"], melee: false },
  "phone-hack": { range: 4, windup: 30, models: ["footman", "trundle"], melee: false },
  handshake: { range: 1.2, windup: 30, models: ["footman", "patrol"], melee: true },
  "forced-update": { range: 3, windup: 360, models: ["footman", "trundle"], melee: false },
};

/**
 * Renderer/adapter output contract. Positions and firmware remain owned by the
 * actor lane. Events carry source/target IDs; amount is months for runway,
 * inventory delta for groceries, and ticks for a newly started timed effect.
 * Active popup/handshake/hack IDs and intervals also remain in state.attacks.
 */
export const ATTACK_EVENT = {
  windup: "attack.windup", resolved: "attack.resolved", cancelled: "attack.cancelled", ended: "attack.ended",
  runway: "player.runway", stumble: "player.stumble", handshake: "player.handshake",
  popup: "player.ad-popup", phone: "player.phone-hack", inventory: "robot.inventory",
  knockdown: "robot.knockdown", converted: "robot.converted", bounty: "robot.bounty",
  interrupted: "update.interrupted",
} as const;
export type AttackEventKind = typeof ATTACK_EVENT[keyof typeof ATTACK_EVENT];

interface Target { position: Vec3; player: CombatPlayer | null; actor: CombatActor | null }

function finitePosition(position: Vec3): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}
function squareDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
function targetState(state: CombatState, id: string): TargetCombat {
  if (!Object.hasOwn(state.targets, id)) {
    Object.defineProperty(state.targets, id, { value: initialTarget(), enumerable: true, configurable: true, writable: true });
  }
  return state.targets[id]!;
}
function inFidelity(actor: CombatActor, ctx: CombatContext): boolean {
  if (actor.inFidelity === false) return false;
  if (ctx.players.length === 0) return actor.inFidelity === true;
  return ctx.players.some(player => squareDistance(actor, player) <= FIDELITY_RADIUS * FIDELITY_RADIUS);
}
function targetFor(ctx: CombatContext, id: string): Target | null {
  const player = playerById(ctx, id);
  if (player) {
    const actor=ctx.actors.find(candidate=>candidate.kind==="player" && candidate.playerId===id)??null;
    return finitePosition(player) ? { position: actor??player, player, actor } : null;
  }
  const actor = ctx.actors.find(candidate => candidate.id === id);
  if (!actor || !finitePosition(actor)) return null;
  if (actor.kind === "player") {
    const owner = playerById(ctx, actor.playerId ?? actor.id);
    return owner ? { position: actor, player: owner, actor } : null;
  }
  return { position: actor, player: null, actor };
}
function hasGear(state: CombatState, target: Target, gear: "boots" | "airplane"): boolean {
  if (!target.player || !Object.hasOwn(state.players, target.player.id)) return false;
  const own = state.players[target.player.id]!;
  return own.gear === gear && own.gearUntil > state.tick;
}
function validTarget(kind: AttackKind, target: Target): boolean {
  if (target.player) return kind !== "snatch" && kind !== "forced-update";
  // NPC people and animals never participate in robot attacks, including adults.
  if (target.actor?.kind !== "robot" || target.actor.firmware !== "good" || target.actor.protected === true) return false;
  return kind === "snatch" || kind === "forced-update" || kind === "shove";
}

/** A narrow wall blocks a short-range attack just as it blocks its readable wind-up. */
function wallBetween(ctx: CombatContext, from: Vec3, to: Vec3): boolean {
  for (const wall of ctx.walls) {
    let lo = 0, hi = 1;
    const axes: Array<[number, number, number, number]> = [
      [from.x, to.x - from.x, wall.minX, wall.maxX],
      [from.y + 0.6, to.y - from.y, wall.minY, wall.maxY],
      [from.z, to.z - from.z, wall.minZ, wall.maxZ],
    ];
    for (const [origin, delta, min, max] of axes) {
      if (Math.abs(delta) < 1e-10) {
        if (origin < min || origin > max) { hi = -1; break; }
      } else {
        const a = (min - origin) / delta, b = (max - origin) / delta;
        lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
        if (lo > hi) break;
      }
    }
    if (lo <= hi && hi > 1e-6 && lo < 1 - 1e-6) return true;
  }
  return false;
}

function pairFor(state: CombatState, ctx: CombatContext, attack: Pick<PendingAttack, "attackerId" | "targetId" | "kind">): { attacker: CombatActor; target: Target } | null {
  const attacker = ctx.actors.find(actor => actor.id === attack.attackerId);
  const spec = ATTACK_SPECS[attack.kind];
  if (!spec || !attacker || attacker.kind !== "robot" || attacker.firmware !== "bad" ||
      attacker.inFidelity === false || !finitePosition(attacker) || attacker.id === attack.targetId) return null;
  if (attacker.model !== undefined && !spec.models.includes(attacker.model)) return null;
  const own = targetState(state, attacker.id);
  if (own.phase !== "active" || own.blindUntil > state.tick || own.stoppedUntil > state.tick || own.distractedUntil > state.tick) return null;
  const target = targetFor(ctx, attack.targetId);
  if (!target || !validTarget(attack.kind, target)) return null;
  if (target.player && targetState(state,target.player.id).phase!=="active") return null;
  if (target.actor && targetState(state, target.actor.id).phase !== "active") return null;
  if (squareDistance(attacker, target.position) > spec.range * spec.range || wallBetween(ctx, attacker, target.position)) return null;
  if (attack.kind === "phone-hack" && (ctx.wave ?? 2) < 3) return null;
  if ((attack.kind === "shove" || attack.kind === "handshake") && hasGear(state, target, "boots")) return null;
  if ((attack.kind === "ad-blast" || attack.kind === "phone-hack") && hasGear(state, target, "airplane")) return null;
  if (attack.kind === "forced-update" && (!target.actor || !inFidelity(attacker, ctx) || !inFidelity(target.actor, ctx) || own.rust >= 0.2)) return null;
  return { attacker, target };
}

function compare(a: Pick<PendingAttack, "attackerId" | "id">, b: Pick<PendingAttack, "attackerId" | "id">): number {
  return a.attackerId < b.attackerId ? -1 : a.attackerId > b.attackerId ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function requestShape(request: AttackRequest): boolean {
  return request !== null && typeof request === "object" && typeof request.id === "string" && request.id.length > 0 && request.id.length <= 256 &&
    typeof request.attackerId === "string" && request.attackerId.length > 0 && request.attackerId.length <= 256 &&
    typeof request.targetId === "string" && request.targetId.length > 0 && request.targetId.length <= 256 &&
    typeof request.kind === "string" &&
    Number.isSafeInteger(request.sequence) && request.sequence > 0;
}
function finish(state: CombatState, attack: PendingAttack, reason: string, cancelled = false): void {
  emit(state, cancelled ? ATTACK_EVENT.cancelled : ATTACK_EVENT.ended, attack.attackerId, attack.targetId, 0, `${attack.kind}:${reason}`);
  if (attack.active && attack.kind === "ad-blast") emit(state, ATTACK_EVENT.popup, attack.attackerId, attack.targetId, -1, reason);
  if (attack.active && attack.kind === "phone-hack") emit(state, ATTACK_EVENT.phone, attack.attackerId, attack.targetId, 0, reason);
  if (attack.active && attack.kind === "handshake") emit(state, ATTACK_EVENT.handshake, attack.attackerId, attack.targetId, 0, reason);
  if (cancelled && attack.kind === "forced-update") emit(state, ATTACK_EVENT.interrupted, attack.attackerId, attack.targetId, 0, reason);
}

/**
 * Updates the caller's already-cloned combat state. Monotonic sequences are the
 * idempotency tokens; display IDs do not create unbounded tombstone history.
 * The 4096-source budget fails closed and never forgets an old source cursor.
 */
export function stepAttacks(state: CombatState, ctx: CombatContext, inputs: CombatInputs): void {
  const converted = new Set(state.events.filter(event => event.tick === state.tick && event.kind === ATTACK_EVENT.converted).map(event => event.targetId));
  const baseBad = ctx.actors.filter(actor => actor.kind === "robot" && actor.firmware === "bad" && inFidelity(actor, ctx)).length;
  const cap = Number.isFinite(ctx.conversionCap) ? Math.max(0, Math.floor(ctx.conversionCap!)) : baseBad;
  const canConvert = (targetId: string): boolean => !converted.has(targetId) && baseBad + converted.size < cap;
  const retained: PendingAttack[] = [];

  for (const attack of [...state.attacks].sort(compare)) {
    // A delivered popup remains until closed/expired; driving away from its source
    // does not erase it. Airplane Mode still clears it immediately.
    if (attack.active && attack.kind === "ad-blast") {
      const target = targetFor(ctx, attack.targetId);
      if (!target?.player || hasGear(state, target, "airplane") || state.tick >= attack.endTick) {
        finish(state, attack, "expired-or-blocked"); continue;
      }
      retained.push(attack); continue;
    }
    const pair = pairFor(state, ctx, attack);
    if (!pair || attack.kind === "phone-hack" && targetState(state, attack.attackerId).lastWaterTick >= attack.startTick ||
        attack.kind === "forced-update" && !canConvert(attack.targetId)) {
      finish(state, attack, "interrupted", true); continue;
    }
    if (attack.active) {
      if (attack.kind === "handshake" && state.tick >= attack.endTick) { finish(state, attack, "released"); continue; }
      retained.push(attack); continue;
    }
    if (state.tick < attack.resolveTick) { retained.push(attack); continue; }

    emit(state, ATTACK_EVENT.resolved, attack.attackerId, attack.targetId, 0, attack.kind);
    if (attack.kind === "shove") {
      if (pair.target.player) {
        emit(state, ATTACK_EVENT.runway, attack.attackerId, pair.target.player.id, -1, "shove");
        emit(state, ATTACK_EVENT.stumble, attack.attackerId, pair.target.player.id, 60, "shove");
        targetState(state, pair.target.player.id).slowUntil = Math.max(targetState(state, pair.target.player.id).slowUntil, state.tick + 60);
      } else {
        const target = targetState(state, attack.targetId);
        target.stoppedUntil = Math.max(target.stoppedUntil, state.tick + 180);
        emit(state, ATTACK_EVENT.knockdown, attack.attackerId, attack.targetId, 180, "shove");
        emit(state, ATTACK_EVENT.inventory, attack.attackerId, attack.targetId, -1, "groceries");
      }
    } else if (attack.kind === "snatch") {
      emit(state, ATTACK_EVENT.inventory, attack.attackerId, attack.targetId, -1, "groceries");
    } else if (attack.kind === "forced-update") {
      converted.add(attack.targetId);
      emit(state, ATTACK_EVENT.converted, attack.attackerId, attack.targetId, 1, "forced-update");
      emit(state, ATTACK_EVENT.bounty, attack.attackerId, attack.targetId, 3600, "conversion");
    } else {
      attack.active = true;
      const playerId = pair.target.player!.id;
      if (attack.kind === "ad-blast") emit(state, ATTACK_EVENT.popup, attack.attackerId, playerId, AD_POPUP_TICKS, "start");
      else if (attack.kind === "phone-hack") emit(state, ATTACK_EVENT.phone, attack.attackerId, playerId, 1, "start");
      else emit(state, ATTACK_EVENT.handshake, attack.attackerId, playerId, HANDSHAKE_TICKS, "start");
      retained.push(attack);
    }
  }
  state.attacks = retained;

  let sources = Object.keys(state.attackSequence).length;
  const requests = [...(ctx.attacks ?? [])].filter(requestShape).sort((a, b) =>
    a.attackerId < b.attackerId ? -1 : a.attackerId > b.attackerId ? 1 : a.sequence - b.sequence || compare(a, b) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));
  for (const request of requests) {
    // Unknown source IDs must not exhaust the lifetime replay-cursor budget.
    if (!Object.hasOwn(ATTACK_SPECS, request.kind) || !ctx.actors.some(actor=>actor.id===request.attackerId && actor.kind==="robot" && actor.firmware==="bad")) continue;
    const known = Object.hasOwn(state.attackSequence, request.attackerId);
    if ((known && request.sequence <= state.attackSequence[request.attackerId]!) || (!known && sources >= MAX_ATTACK_SOURCES)) continue;
    Object.defineProperty(state.attackSequence, request.attackerId, { value: request.sequence, enumerable: true, configurable: true, writable: true });
    if (!known) sources++;
    if (!Object.hasOwn(ATTACK_SPECS, request.kind) || state.attacks.length >= MAX_PENDING_ATTACKS ||
        state.attacks.some(attack => attack.attackerId === request.attackerId || attack.id === request.id)) continue;
    const pair = pairFor(state, ctx, request);
    if (!pair || request.kind === "forced-update" && !canConvert(request.targetId)) continue;
    const spec = ATTACK_SPECS[request.kind];
    if (pair.target.player && spec.melee && state.attacks.filter(attack => ATTACK_SPECS[attack.kind].melee && targetFor(ctx, attack.targetId)?.player?.id === pair.target.player!.id).length >= 2) continue;
    if (request.kind === "ad-blast" && state.attacks.filter(attack => attack.kind === "ad-blast" && targetFor(ctx, attack.targetId)?.player?.id === pair.target.player!.id).length >= 3) continue;
    const scale = targetState(state, request.attackerId).windupScale;
    const windup = Math.ceil(spec.windup * (Number.isFinite(scale) ? Math.max(1, Math.min(4, scale)) : 1));
    const resolveTick = state.tick + windup;
    const targetId = pair.target.player?.id ?? request.targetId;
    state.attacks.push({ id: request.id, kind: request.kind, attackerId: request.attackerId, targetId,
      startTick: state.tick, resolveTick, endTick: resolveTick + (request.kind === "ad-blast" ? AD_POPUP_TICKS : request.kind === "handshake" ? HANDSHAKE_TICKS : 0), presses: 0, active: false });
    emit(state, ATTACK_EVENT.windup, request.attackerId, targetId, windup, request.kind);
  }

  // One close input removes one popup, and eight distinct press edges release a
  // handshake. Holding either input never repeats its one-shot action.
  for (const player of [...ctx.players].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (!Object.hasOwn(state.players, player.id)) continue;
    const own = state.players[player.id]!;
    const matchesPlayer = (attack: PendingAttack): boolean => targetFor(ctx, attack.targetId)?.player?.id === player.id;
    if (newlyPressed(own, "closeAd", inputs[player.id]?.closeAd === true)) {
      const popup = state.attacks.find(attack => attack.active && attack.kind === "ad-blast" && matchesPlayer(attack));
      if (popup) { finish(state, popup, "closed"); state.attacks = state.attacks.filter(attack => attack !== popup); }
    }
    if (newlyPressed(own, "breakFree", inputs[player.id]?.breakFree === true)) {
      state.attacks = state.attacks.filter(attack => {
        if (!attack.active || attack.kind !== "handshake" || !matchesPlayer(attack)) return true;
        attack.presses++;
        if (attack.presses < 8) return true;
        finish(state, attack, "broke-free"); return false;
      });
    }
    const popups = state.attacks.filter(attack => attack.active && attack.kind === "ad-blast" && matchesPlayer(attack));
    const phones = state.attacks.filter(attack => attack.active && attack.kind === "phone-hack" && matchesPlayer(attack));
    if (popups.length) emit(state, ATTACK_EVENT.runway, popups[0]!.attackerId, player.id, -0.2 * DT, "ad-blast");
    if (phones.length) emit(state, ATTACK_EVENT.runway, phones[0]!.attackerId, player.id, -0.1 * DT, "phone-hack");
    if (state.attacks.some(attack => attack.active && attack.kind === "handshake" && matchesPlayer(attack))) {
      const target = targetState(state, player.id);
      target.stoppedUntil = Math.max(target.stoppedUntil, state.tick + 1);
    }
  }
}
