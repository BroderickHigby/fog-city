import { clamp, dcos, dsin } from "../dmath.ts";
import { nextFloat } from "../rng.ts";
import { lineOfSight } from "./physics.ts";
import {
  capacity, distance2, DT, emit, FIDELITY_RADIUS, protectedActor, robotActor,
  safeAngle, sortedActors, sortedPlayers, targetOf,
} from "./shared.ts";
import type {
  CombatActor, CombatContext, CombatInputs, CombatPlayer, CombatState,
  Projectile, RefillSource, TargetCombat, Vec3,
} from "./types.ts";

export const EFFECTS = {
  permanentRust: 0.3,
  dryDelay: 300,
  dryPerSecond: 0.02,
  seizedTicks: 30,
  collapseTicks: 120,
  wetDuration: 600,
  wetHitSpan: 120,
  scanTicks: 60,
  scanRange: 25,
  pingRange: 30,
  waryTicks: 600,
  // Rain exposure is a tuning value; fog's rate is prescribed by the design.
  rainRustPerSecond: 0.005,
} as const;

function distance3Squared(a: Vec3, b: Vec3): number {
  const dy = a.y - b.y;
  return distance2(a, b) + dy * dy;
}

function modelRate(actor: CombatActor): number {
  if (Number.isFinite(actor.rustScale) && actor.rustScale! > 0 && actor.rustScale! <= 1) return actor.rustScale!;
  if (actor.model === "patrol") return 0.5;
  if (actor.model === "drone") return 1.5;
  if (actor.model === "robotaxi") return 0.7;
  if (actor.model === "walker") return 0.3;
  return 1;
}

function partialRust(target: TargetCombat, tick: number): void {
  if (target.phase !== "active") {
    target.movementScale = 0;
    target.windupScale = 1;
    return;
  }
  const baseMovement = target.rust >= 0.5 || target.repair ? 0.7 : 1;
  target.movementScale = target.slowUntil > tick ? Math.min(baseMovement, 0.5) : baseMovement;
  target.windupScale = target.rust >= 0.5 ? 1.3 : 1;
}

/** The caller owns state; actors are immutable snapshots supplied by the agent lane. */
export function applyRust(state: CombatState, actor: CombatActor, amount: number, sourceId: string, direct: boolean, scaleModel = true): void {
  if (!Number.isFinite(amount) || amount <= 0 || protectedActor(actor) || !robotActor(actor)) return;
  if (actor.firmware !== "bad" && !(direct && actor.firmware === "good")) return;
  const target = targetOf(state, actor.id);
  if (target.phase !== "active") return;

  target.lastWaterTick = state.tick;
  target.sourceId = sourceId;
  const scaledAmount = amount * (scaleModel ? modelRate(actor) : 1);
  // Occupied taxis never cross the wrong-target threshold or seize. Their riders
  // leave through an agent-lane response to the pull-over event.
  if (actor.model === "robotaxi" && actor.occupied === true) {
    target.rust = Math.min(0.29, target.rust + scaledAmount);
    if (target.pullOverTick === 0) {
      target.pullOverTick = state.tick + 180;
      target.pullOverSpeed = Math.abs(actor.speed);
      emit(state, "robot.pull-over", sourceId, actor.id, 180, "occupied");
    }
    partialRust(target, state.tick);
    return;
  }

  const before = target.rust;
  target.rust = clamp(before + scaledAmount, 0, 1);
  if (direct && actor.firmware === "good" && before < EFFECTS.permanentRust && target.rust >= EFFECTS.permanentRust && !target.penalized) {
    target.penalized = true;
    target.repair = true;
    emit(state, "economy.penalty", sourceId, actor.id, 50, "reputation:-5");
    emit(state, "robot.repair", sourceId, actor.id, 0, "apology");
  }
  partialRust(target, state.tick);
  if (target.rust < 1) return;
  target.phaseTick = state.tick;
  target.movementScale = 0;
  if (actor.model === "robotaxi") {
    target.phase = "disabled";
    target.pullOverTick = state.tick + 180;
    target.pullOverSpeed = Math.abs(actor.speed);
    emit(state, "robot.pull-over", sourceId, actor.id, 180, "rusted");
    emit(state, "robot.disabled", sourceId, actor.id, 1, "robotaxi");
  } else {
    target.phase = "seized";
    emit(state, "robot.seized", sourceId, actor.id, 1, actor.model ?? "robot");
  }
}

export function applyWaterHit(state: CombatState, actor: CombatActor, projectile: Projectile): void {
  if (projectile.kind !== "water" || protectedActor(actor)) return;
  if (robotActor(actor)) {
    applyRust(state, actor, projectile.rustRate * (projectile.salt ? 1.6 : 1), projectile.ownerId, true);
    return;
  }
  if (actor.kind !== "person" || projectile.vehicle) return;
  const target = targetOf(state, actor.id);
  if (target.wetUntil > state.tick) return;
  target.wetHits = target.wetHits.filter(tick => tick >= state.tick - EFFECTS.wetHitSpan);
  target.wetHits.push(state.tick);
  if (target.wetHits.length < 3) return;
  target.wetHits = [];
  target.wetUntil = state.tick + EFFECTS.wetDuration;
  emit(state, "person.wet", projectile.ownerId, actor.id, EFFECTS.wetDuration, "annoyed");
  emit(state, "economy.penalty", projectile.ownerId, actor.id, 20, "reputation:-3");
}

/** Phase timers and environmental exposure run entirely on the simulation tick. */
export function tickEffects(state: CombatState, ctx: CombatContext): void {
  const players = sortedPlayers(ctx);
  for (const actor of sortedActors(ctx)) {
    let target = state.targets[actor.id];
    if (target?.phase === "cleared") continue;
    if ((ctx.wave ?? 2) >= 3 && actor.firmware === "bad" && robotActor(actor) && !actor.sheltered && !protectedActor(actor)) {
      const fog = ctx.night && (ctx.fog ?? 0) > 0.6 ? 0.01 * (actor.pursuing ? 3 : 1) : 0;
      const rain = EFFECTS.rainRustPerSecond * clamp(ctx.rain ?? 0, 0, 1);
      if (fog + rain > 0) {
        applyRust(state, actor, (fog + rain) * DT, "environment", false);
        target = state.targets[actor.id];
      }
    }
    if (!target) continue;
    target.wetHits = target.wetHits.filter(tick => tick >= state.tick - EFFECTS.wetHitSpan);
    if (target.phase === "active") {
      if (target.rust > 0 && target.rust < EFFECTS.permanentRust && state.tick - target.lastWaterTick >= EFFECTS.dryDelay) {
        target.rust = Math.max(0, target.rust - EFFECTS.dryPerSecond * DT);
      }
      partialRust(target, state.tick);
      continue;
    }
    if (target.phase === "disabled") {
      target.heightScale = 1;
      target.puddle = false;
      continue;
    }
    const age = state.tick - target.phaseTick;
    if (target.phase === "seized" && age >= EFFECTS.seizedTicks) {
      target.phase = "slumping";
      emit(state, "robot.slumping", target.sourceId, actor.id, 0, actor.model ?? "robot");
    }
    if (target.phase === "slumping") {
      const collapsed = clamp((age - EFFECTS.seizedTicks) / (EFFECTS.collapseTicks - EFFECTS.seizedTicks), 0, 1);
      target.heightScale = 1 - 0.7 * collapsed;
      if (age >= EFFECTS.collapseTicks) {
        target.phase = "heap";
        target.heightScale = 0.3;
        target.puddle = true;
        emit(state, "robot.heap", target.sourceId, actor.id, 1, actor.model ?? "robot");
      }
    }
    if (target.phase === "heap" && (actor.inFidelity === false ||
      players.length > 0 && players.every(player => distance2(player, actor) > FIDELITY_RADIUS * FIDELITY_RADIUS))) {
      target.phase = "cleared";
      target.heightScale = 0;
      target.puddle = false;
      target.movementScale = 0;
      emit(state, "robot.heap-cleared", target.sourceId, actor.id);
    }
  }
}

/** Scans and projectiles share the same inclusive wall geometry. */
export function hasLineOfSight(ctx: CombatContext, from: Vec3, to: Vec3): boolean {
  return lineOfSight(from, to, ctx.walls);
}

export function scanAccuracy(tier: number, subtlety: number): number {
  const rates = [0.7, 0.8, 0.9, 0.95] as const;
  const index = clamp(Math.floor(tier), 1, 4) - 1;
  return clamp(rates[index]! + (3 - clamp(subtlety, 1, 5)) * 0.05, 0, 1);
}

function scanTarget(state: CombatState, ctx: CombatContext, player: CombatPlayer, yaw: number): CombatActor | undefined {
  const from = { x: player.x, y: player.y + 1.4, z: player.z };
  const fx = dsin(yaw), fz = -dcos(yaw);
  let nearest = EFFECTS.scanRange * EFFECTS.scanRange + 1;
  let selected: CombatActor | undefined;
  for (const actor of sortedActors(ctx)) {
    if (!robotActor(actor) || actor.playerId === player.id || protectedActor(actor)) continue;
    if (state.targets[actor.id]?.phase && state.targets[actor.id]?.phase !== "active") continue;
    const d2 = distance3Squared(player, actor);
    if (d2 > EFFECTS.scanRange * EFFECTS.scanRange || d2 >= nearest) continue;
    const d = Math.sqrt(distance2(player, actor));
    if (d > actor.radius && ((actor.x - player.x) * fx + (actor.z - player.z) * fz) / d < dcos(0.17453292519943295)) continue;
    if (!hasLineOfSight(ctx, from, { x: actor.x, y: actor.y + actor.height * 0.5, z: actor.z })) continue;
    selected = actor;
    nearest = d2;
  }
  return selected;
}

function refillDuration(source: RefillSource, player: CombatPlayer): number {
  if (source.kind === "bay") return player.perks?.includes("brackish") ? 90 : 180;
  if (source.kind === "puddle") return 240;
  if ((source.kind === "hydrant" || source.kind === "fountain") && player.perks?.includes("whisperer")) return 60;
  return 120;
}

export function stepSupport(state: CombatState, ctx: CombatContext, inputs: CombatInputs): void {
  for (const player of sortedPlayers(ctx)) {
    const own = state.players[player.id];
    if (!own) continue;
    const input = inputs[player.id] ?? {};
    const maxWater = capacity(player);
    own.water = clamp(own.water, 0, maxWater);
    own.reserve = clamp(own.reserve, 0, 20);
    if ((player.mount === "vehicle" || player.mount === "roof") && own.previousMount !== "vehicle" && own.previousMount !== "roof") {
      own.cones = 3;
      emit(state, "inventory.cones", player.id, player.id, 3);
    }
    own.previousMount = player.mount;

    const source = ctx.refills.find(value => value.id === input.refill &&
      distance3Squared(value, player) <= value.radius * value.radius && Math.abs(player.speed) <= 3 &&
      (value.kind !== "trunk" || player.trunk && value.ownerId === player.id && own.reserve > 0));
    if (source) {
      if (own.refillId !== source.id) { own.refillId = source.id; own.refillTicks = 0; }
      if (own.water < maxWater || own.balloons < 2 || own.salt !== (source.kind === "bay" || source.salt)) {
        own.refillTicks += 1;
        if (own.refillTicks >= refillDuration(source, player)) {
          const incomingSalt = source.kind === "bay" || source.salt;
          const replacesWater = own.salt !== incomingSalt;
          const deficit = replacesWater ? maxWater : maxWater - own.water;
          const transfer = source.kind === "trunk" ? Math.min(deficit, own.reserve) : deficit;
          own.water = replacesWater ? transfer : own.water + transfer;
          if (source.kind === "trunk") own.reserve -= transfer;
          own.salt = incomingSalt;
          own.balloons = 2;
          own.refillTicks = 0;
          emit(state, "refill.complete", player.id, source.id, transfer, own.salt ? "salt" : "fresh");
        }
      } else own.refillTicks = 0;
    } else {
      own.refillId = "";
      own.refillTicks = 0;
    }

    if (!input.scan || own.gear === "airplane" && own.gearUntil > state.tick || own.nextScanTick > state.tick) {
      own.scanId = "";
      own.scanTicks = 0;
      continue;
    }
    const yaw = safeAngle(input.aimYaw, player.heading);
    const scanned = scanTarget(state, ctx, player, yaw);
    if (!scanned) { own.scanId = ""; own.scanTicks = 0; continue; }
    if (own.scanId !== scanned.id) { own.scanId = scanned.id; own.scanTicks = 0; }
    own.scanTicks += 1;
    if (own.scanTicks < EFFECTS.scanTicks) continue;
    const [roll, firstRng] = nextFloat(state.rng);
    const [confidenceRoll, secondRng] = nextFloat(firstRng);
    state.rng = secondRng;
    const correct = roll < scanAccuracy(player.scannerTier, scanned.subtlety ?? 3);
    const bad = correct ? scanned.firmware === "bad" : scanned.firmware !== "bad";
    own.scan = { targetId: scanned.id, bad, confidence: 85 + Math.floor(confidenceRoll * 15), tick: state.tick };
    own.scanId = "";
    own.scanTicks = 0;
    own.nextScanTick = state.tick + 1;
    emit(state, "scan.result", player.id, scanned.id, own.scan.confidence, bad ? "bad" : "good");
    if (!player.perks?.includes("quiet")) {
      for (const actor of sortedActors(ctx)) {
        if (!robotActor(actor) || protectedActor(actor) || distance3Squared(player, actor) > EFFECTS.pingRange * EFFECTS.pingRange) continue;
        if (actor.firmware === "bad") {
          const target = targetOf(state, actor.id);
          target.waryUntil = state.tick + EFFECTS.waryTicks;
          emit(state, "robot.wary", player.id, actor.id, EFFECTS.waryTicks);
          if (actor.id === scanned.id && distance3Squared(player, actor) <= 100) {
            target.alerted = true;
            emit(state, "robot.alert", player.id, actor.id);
          }
        } else if (actor.firmware === "good") emit(state, "robot.glance", player.id, actor.id);
      }
    }
  }
}
