import { clamp, dcos, dsin } from "../dmath.ts";
import { nextU32 } from "../rng.ts";
import { applyRust } from "./effects.ts";
import { lineOfSight, segmentActorFraction, segmentGroundFraction } from "./physics.ts";
import {
  DT, MAX_GADGETS, MAX_PROJECTILES, distance2, emit, newlyPressed, playerById,
  protectedActor, robotActor, safeAngle, sortedActors, sortedPlayers, targetOf,
} from "./shared.ts";
import type {
  CombatActor, CombatContext, CombatInput, CombatInputs, CombatPlayer, CombatState,
  Gadget, Projectile, StreakKind, Vec3,
} from "./types.ts";

/** Placement distances and ordinary-gadget reuse delays are tuning values, not fixed design rules. */
export const DEVICE_TUNING = {
  maxConfidenceMarks: 4096,
  placementRange: 2,
  balloonRange: 15,
  balloonSplash: 3,
  balloonRust: 0.2,
  balloonReuseTicks: 120,
  sprinklerRange: 4,
  sprinklerTicks: 900,
  sprinklerRustPerSecond: 0.15,
  sprinklerReuseTicks: 900,
  speakerRange: 10,
  speakerTicks: 480,
  speakerReuseTicks: 480,
  gearTicks: 900,
  gearReuseTicks: 5400,
  confidenceRange: 150,
  confidenceTicks: 1200,
  parrotsPlacementRange: 200,
  parrotsRange: 40,
  parrotsStopRange: 15,
  parrotsTicks: 1200,
  parrotsReuseTicks: 3600,
  tensorPlacementRange: 150,
  tensorLoadRange: 3,
  tensorLoadTicks: 180,
  tensorSunTicks: 5400,
  tensorFogTicks: 10800,
  tensorCrateTicks: 3600,
  blimpRange: 200,
  blimpTicks: 1800,
  hydrantPlacementRange: 150,
  hydrantJetRange: 12,
  hydrantTicks: 900,
  hydrantRustPerSecond: 0.25,
  agiRange: 500,
  agiPauseTicks: 180,
  agiRust: 0.6,
} as const;

function finitePoint(point: Vec3): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function bodyCenter(actor: CombatActor): Vec3 {
  return { x: actor.x, y: actor.y + actor.height * 0.5, z: actor.z };
}

function spatialDistance2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function activeBad(state: CombatState, actor: CombatActor): boolean {
  return robotActor(actor) && actor.firmware === "bad" && actor.model !== "tidy" &&
    (state.targets[actor.id]?.phase ?? "active") === "active";
}

function rivalActor(ctx: CombatContext, ownerId: string, actor: CombatActor): boolean {
  const playerId = actor.playerId ?? actor.id;
  return actor.kind === "player" && playerId !== ownerId && ctx.mode !== undefined && ctx.mode !== "free-roam" &&
    (ctx.rivalPlayerIds?.[ownerId]?.includes(playerId) ?? false);
}

/** Automated water never crosses another actor or an opaque wall to reach its target. */
function clearWaterPath(ctx: CombatContext, source: Vec3, target: CombatActor, ownerId: string): boolean {
  const end = bodyCenter(target);
  if (!lineOfSight(source, end, ctx.walls) || segmentGroundFraction(source, end, ctx) !== null) return false;
  return !ctx.actors.some(actor => actor.id !== target.id && actor.id !== ownerId && actor.playerId !== ownerId &&
    segmentActorFraction(source, end, actor) !== null);
}

function rust(state: CombatState, actor: CombatActor, amount: number, ownerId: string, scaleModel = true): void {
  if (!activeBad(state, actor) || amount <= 0) return;
  applyRust(state, actor, amount, ownerId, false, scaleModel);
}

function safeSpot(ctx: CombatContext, point: Vec3, clearance: number): boolean {
  return finitePoint(point) && !ctx.actors.some(actor => (actor.kind === "person" || actor.kind === "animal") &&
    distance2(point, actor) <= (Math.max(0, actor.radius) + clearance) * (Math.max(0, actor.radius) + clearance));
}

function placement(player: CombatPlayer, input: Readonly<CombatInput>, ctx: CombatContext, range: number): Vec3 | null {
  const x = input.targetX ?? player.x;
  const z = input.targetZ ?? player.z;
  if (!Number.isFinite(x) || !Number.isFinite(z) || distance2(player, { x, z }) > range * range) return null;
  const y = ctx.groundHeight?.(x, z) ?? player.y;
  return Number.isFinite(y) ? { x, y, z } : null;
}

function addGadget(state: CombatState, kind: Gadget["kind"], ownerId: string, point: Vec3, radius: number, ticks: number): Gadget | null {
  if (state.gadgets.length >= MAX_GADGETS) return null;
  const gadget: Gadget = { ...point, id: state.nextId++, kind, ownerId, untilTick: state.tick + ticks,
    targetId: "", radius, progress: 0, boost: "salt" };
  state.gadgets.push(gadget);
  return gadget;
}

function pingPlacement(state: CombatState, ctx: CombatContext, player: CombatPlayer, point: Vec3): void {
  if (player.perks?.includes("quiet")) return;
  for (const actor of sortedActors(ctx)) {
    if (!activeBad(state, actor) || spatialDistance2(point, actor) > 30 * 30) continue;
    targetOf(state, actor.id).waryUntil = Math.max(targetOf(state, actor.id).waryUntil, state.tick + 300);
    emit(state, "combat.ping", player.id, actor.id, 300, "gadget");
  }
}

function nearestBad(state: CombatState, ctx: CombatContext, point: Vec3, range: number, requireClearPath = false, ownerId = ""): CombatActor | undefined {
  let nearest: CombatActor | undefined;
  let nearestDistance = range * range;
  for (const actor of sortedActors(ctx)) {
    if (!activeBad(state, actor)) continue;
    const distance = requireClearPath ? spatialDistance2(point, actor) : distance2(point, actor);
    if (distance > nearestDistance || distance === nearestDistance && nearest !== undefined) continue;
    if (requireClearPath && !clearWaterPath(ctx, point, actor, ownerId)) continue;
    nearest = actor;
    nearestDistance = distance;
  }
  return nearest;
}

/** Root reducer owns inserting the returned projectile and advancing its ballistic collisions. */
export function launchBalloon(state: CombatState, player: CombatPlayer, input: Readonly<CombatInput>): Projectile | null {
  const owner = state.players[player.id];
  if (!owner || player.gadget !== "balloon" || input.gadget !== "balloon" || !newlyPressed(owner, "gadget", true) ||
      owner.balloons <= 0 || state.tick < owner.nextGadgetTick || state.projectiles.length >= MAX_PROJECTILES) return null;
  const yaw = safeAngle(input.aimYaw, safeAngle(player.heading));
  const pitch = Number.isFinite(input.aimPitch) ? clamp(input.aimPitch!, -0.3, 0.65) : 0;
  const fx = dsin(yaw), fz = -dcos(yaw);
  const projectile: Projectile = {
    id: state.nextId++, kind: "balloon", ownerId: player.id,
    x: player.x, y: player.y + 1.2, z: player.z,
    vx: fx * dcos(pitch) * 13, vy: 4 + dsin(pitch) * 13, vz: fz * dcos(pitch) * 13,
    distance: 0, range: DEVICE_TUNING.balloonRange, bornTick: state.tick,
    volume: 0, salt: false, vehicle: player.mount === "vehicle" || player.mount === "roof", rustRate: DEVICE_TUNING.balloonRust,
  };
  owner.balloons -= 1;
  owner.nextGadgetTick = state.tick + DEVICE_TUNING.balloonReuseTicks;
  emit(state, "balloon.thrown", player.id);
  return projectile;
}

/** Splash only affects bad firmware; landing on any person or animal removes the balloon. */
export function applyBalloon(state: CombatState, ctx: CombatContext, projectile: Projectile, point: Vec3): void {
  if (projectile.kind !== "balloon" || !finitePoint(point)) return;
  if (ctx.actors.some(actor => (actor.kind === "person" || actor.kind === "animal" || actor.kind === "player" && actor.robotBody !== true) &&
      segmentActorFraction(point, point, actor) !== null)) {
    emit(state, "balloon.removed", projectile.ownerId, "", 0, "protected landing");
    return;
  }
  // An impact exactly on an opaque face must still splash the exposed side.
  // Keep the radius centred on impact, but start visibility rays just behind it.
  const speed = Math.sqrt(projectile.vx * projectile.vx + projectile.vz * projectile.vz);
  const source = {
    x: point.x - (speed > 0 ? projectile.vx / speed * 0.01 : 0),
    y: point.y + 0.01,
    z: point.z - (speed > 0 ? projectile.vz / speed * 0.01 : 0),
  };
  let affected = 0;
  for (const actor of sortedActors(ctx)) {
    if (!activeBad(state, actor) || spatialDistance2(point, actor) > DEVICE_TUNING.balloonSplash * DEVICE_TUNING.balloonSplash ||
        !clearWaterPath(ctx, source, actor, projectile.ownerId)) continue;
    rust(state, actor, DEVICE_TUNING.balloonRust, projectile.ownerId, false);
    affected += 1;
  }
  emit(state, "balloon.burst", projectile.ownerId, "", affected);
}

function placeOrdinary(state: CombatState, ctx: CombatContext, player: CombatPlayer, input: Readonly<CombatInput>): void {
  const owner = state.players[player.id]!;
  const kind = input.gadget;
  if ((kind !== "sprinkler" && kind !== "speaker") || player.gadget !== kind || state.tick < owner.nextGadgetTick ||
      !newlyPressed(owner, "gadget", true)) return;
  const point = placement(player, input, ctx, DEVICE_TUNING.placementRange);
  if (!point || !safeSpot(ctx, point, 0.6) || !lineOfSight(
    { x: player.x, y: player.y + 0.7, z: player.z },
    { x: point.x, y: point.y + 0.2, z: point.z }, ctx.walls,
  )) return;
  const gadget = addGadget(state, kind, player.id, point,
    kind === "sprinkler" ? DEVICE_TUNING.sprinklerRange : DEVICE_TUNING.speakerRange,
    kind === "sprinkler" ? DEVICE_TUNING.sprinklerTicks : DEVICE_TUNING.speakerTicks);
  if (!gadget) return;
  owner.nextGadgetTick = state.tick + (kind === "sprinkler" ? DEVICE_TUNING.sprinklerReuseTicks : DEVICE_TUNING.speakerReuseTicks);
  pingPlacement(state, ctx, player, point);
  if (kind === "speaker") {
    const target = nearestBad(state, ctx, point, gadget.radius);
    if (target) {
      gadget.targetId = target.id;
      targetOf(state, target.id).distractedUntil = Math.max(targetOf(state, target.id).distractedUntil, gadget.untilTick);
      emit(state, "device.lure", player.id, target.id, 0, String(gadget.id));
    }
  }
  emit(state, "device.placed", player.id, "", gadget.id, kind);
}

function confidence(state: CombatState, ctx: CombatContext, player: CombatPlayer): boolean {
  const owner = state.players[player.id]!;
  const real: CombatActor[] = [];
  const good: CombatActor[] = [];
  for (const actor of sortedActors(ctx).slice(0, DEVICE_TUNING.maxConfidenceMarks)) {
    if (actor.id === player.id || actor.playerId === player.id || distance2(actor, player) > DEVICE_TUNING.confidenceRange * DEVICE_TUNING.confidenceRange) continue;
    if (actor.protected === true || robotActor(actor) && protectedActor(actor) ||
        state.targets[actor.id] && state.targets[actor.id]!.phase !== "active") continue;
    const rival = rivalActor(ctx, player.id, actor);
    if (actor.kind === "player" ? !rival : !robotActor(actor)) continue;
    const rivalPlayer = playerById(ctx, actor.playerId ?? actor.id);
    if (rival && (rivalPlayer?.perks?.includes("stealth") || rivalPlayer?.perks?.includes("marine") && (ctx.fog ?? 0) > 0.4)) continue;
    if (rival || actor.firmware === "bad") real.push(actor);
    else if (actor.firmware === "good") good.push(actor);
  }
  // Every false mark consumes one of five total marker slots, not 20% of the
  // ambient good population. A sparse threat scene cannot become mostly false.
  const falseCount = Math.min(good.length, Math.floor(real.length / 4));
  for (let i = 0; i < falseCount; i++) {
    const [roll, rng] = nextU32(state.rng);
    state.rng = rng;
    const selected = i + roll % (good.length - i);
    [good[i], good[selected]] = [good[selected]!, good[i]!];
  }
  owner.marks = [...real.map(actor => ({ actor, hallucination: false })),
    ...good.slice(0, falseCount).map(actor => ({ actor, hallucination: true }))]
    .map(({ actor, hallucination }) => ({ targetId: actor.id, untilTick: state.tick + DEVICE_TUNING.confidenceTicks, confidence: 98, hallucination }))
    .sort((a, b) => a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0);
  for (const mark of owner.marks) {
    emit(state, "confidence.mark", player.id, mark.targetId, DEVICE_TUNING.confidenceTicks, "98% confidence");
  }
  return true;
}

function callStreak(state: CombatState, ctx: CombatContext, player: CombatPlayer, input: Readonly<CombatInput>, kind: StreakKind): boolean {
  const owner = state.players[player.id]!;
  if (kind === "confidence") return confidence(state, ctx, player);
  if (kind === "parrots") {
    if (state.tick - owner.lastParrotsTick < DEVICE_TUNING.parrotsReuseTicks) return false;
    const point = placement(player, input, ctx, DEVICE_TUNING.parrotsPlacementRange);
    if (!point || !safeSpot(ctx, point, DEVICE_TUNING.parrotsStopRange)) return false;
    const gadget = addGadget(state, "parrots", player.id, point, DEVICE_TUNING.parrotsRange, DEVICE_TUNING.parrotsTicks);
    if (!gadget) return false;
    owner.lastParrotsTick = state.tick;
    for (const actor of sortedActors(ctx)) {
      if (!activeBad(state, actor) || distance2(point, actor) > gadget.radius * gadget.radius) continue;
      targetOf(state, actor.id).distractedUntil = Math.max(targetOf(state, actor.id).distractedUntil, gadget.untilTick);
      emit(state, "device.lure", player.id, actor.id, DEVICE_TUNING.parrotsStopRange, String(gadget.id));
    }
    return true;
  }
  if (kind === "tensor") {
    const lots = (ctx.safeLots ?? []).filter(lot => finitePoint(lot) && lot.radius >= DEVICE_TUNING.tensorLoadRange &&
      distance2(lot, player) <= DEVICE_TUNING.tensorPlacementRange * DEVICE_TUNING.tensorPlacementRange && safeSpot(ctx, lot, lot.radius))
      .sort((a, b) => distance2(a, player) - distance2(b, player) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const lot = lots[0];
    return lot !== undefined && addGadget(state, "tensor", player.id, lot, DEVICE_TUNING.tensorLoadRange, DEVICE_TUNING.tensorCrateTicks) !== null;
  }
  if (kind === "blimp") {
    const point = placement(player, input, ctx, DEVICE_TUNING.blimpRange);
    return point !== null && addGadget(state, "blimp", player.id, point, DEVICE_TUNING.blimpRange, DEVICE_TUNING.blimpTicks) !== null;
  }
  if (kind === "hydrants") {
    const sources = [...ctx.refills].filter(source => source.kind === "hydrant" && finitePoint(source) &&
      distance2(source, player) <= DEVICE_TUNING.hydrantPlacementRange * DEVICE_TUNING.hydrantPlacementRange)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (sources.length === 0 || state.gadgets.length + sources.length > MAX_GADGETS) return false;
    for (const source of sources) {
      const gadget = addGadget(state, "hydrants", player.id, source, DEVICE_TUNING.hydrantJetRange, DEVICE_TUNING.hydrantTicks)!;
      gadget.targetId = source.id;
    }
    return true;
  }
  if (kind === "agi") {
    state.pauseUntil = Math.max(state.pauseUntil, state.tick + DEVICE_TUNING.agiPauseTicks);
    for (const actor of sortedActors(ctx)) {
      if (activeBad(state, actor) && distance2(actor, player) <= DEVICE_TUNING.agiRange * DEVICE_TUNING.agiRange) rust(state, actor, DEVICE_TUNING.agiRust, player.id, false);
    }
    emit(state, "agi.pause", player.id, "", DEVICE_TUNING.agiPauseTicks, "tint-fade");
    return true;
  }
  return false;
}

function activateStreak(state: CombatState, ctx: CombatContext, player: CombatPlayer, input: Readonly<CombatInput>): void {
  const owner = state.players[player.id]!;
  const kind = input.streak;
  if (!kind || !newlyPressed(owner, "streak", true)) return;
  const grant = [...(ctx.streaks ?? [])].filter(grant => grant.playerId === player.id && grant.kind === kind &&
    Number.isSafeInteger(grant.sequence) && grant.sequence > (owner.streakSequence[kind] ?? 0))
    .sort((a, b) => a.sequence - b.sequence)[0];
  if (!grant || !callStreak(state, ctx, player, input, kind)) return;
  owner.streakSequence[kind] = grant.sequence;
  emit(state, "streak.used", player.id, "", grant.sequence, kind);
  if (!player.perks?.includes("quiet")) emit(state, "streak.announced", player.id, "", 0, kind);
}

function tickGadgets(state: CombatState, ctx: CombatContext, inputs: CombatInputs): void {
  state.gadgets = state.gadgets.filter(gadget => state.tick < gadget.untilTick && state.players[gadget.ownerId] !== undefined);
  for (const gadget of state.gadgets) {
    if (gadget.kind === "sprinkler") {
      const source = { x: gadget.x, y: gadget.y + 0.4, z: gadget.z };
      for (const actor of sortedActors(ctx)) if (activeBad(state, actor) && spatialDistance2(source, actor) <= gadget.radius * gadget.radius &&
          clearWaterPath(ctx, source, actor, gadget.ownerId)) rust(state, actor, DEVICE_TUNING.sprinklerRustPerSecond * DT, gadget.ownerId);
    } else if (gadget.kind === "hydrants") {
      const source = { x: gadget.x, y: gadget.y + 0.6, z: gadget.z };
      const target = nearestBad(state, ctx, source, gadget.radius, true, gadget.ownerId);
      if (target) rust(state, target, DEVICE_TUNING.hydrantRustPerSecond * DT, gadget.ownerId);
    } else if (gadget.kind === "speaker" && gadget.targetId === "") {
      const target = nearestBad(state, ctx, gadget, gadget.radius);
      if (target) {
        gadget.targetId = target.id;
        targetOf(state, target.id).distractedUntil = Math.max(targetOf(state, target.id).distractedUntil, gadget.untilTick);
        emit(state, "device.lure", gadget.ownerId, target.id, 0, String(gadget.id));
      }
    } else if (gadget.kind === "parrots" && safeSpot(ctx, gadget, DEVICE_TUNING.parrotsStopRange)) {
      for (const actor of sortedActors(ctx)) {
        if (!activeBad(state, actor) || distance2(actor, gadget) > gadget.radius * gadget.radius) continue;
        const target = targetOf(state, actor.id);
        if (target.distractedUntil >= gadget.untilTick) continue;
        target.distractedUntil = gadget.untilTick;
        emit(state, "device.lure", gadget.ownerId, actor.id, DEVICE_TUNING.parrotsStopRange, String(gadget.id));
      }
    } else if (gadget.kind === "tensor") {
      const player = playerById(ctx, gadget.ownerId);
      const input = inputs[gadget.ownerId];
      const boost = input?.boost;
      if (!player || (boost !== "salt" && boost !== "pressure" && boost !== "wide") ||
          distance2(player, gadget) > gadget.radius * gadget.radius || Math.abs(player.speed) > 1 ||
          !safeSpot(ctx, gadget, gadget.radius)) { gadget.progress = 0; continue; }
      if (gadget.progress > 0 && gadget.boost !== boost) gadget.progress = 0;
      gadget.boost = boost;
      gadget.progress += 1;
      if (gadget.progress >= DEVICE_TUNING.tensorLoadTicks) {
        const owner = state.players[gadget.ownerId]!;
        owner.boost = gadget.boost;
        owner.boostUntil = state.tick + ((ctx.fog ?? 0) > 0.4 ? DEVICE_TUNING.tensorFogTicks : DEVICE_TUNING.tensorSunTicks);
        gadget.untilTick = state.tick;
        emit(state, "tensor.loaded", gadget.ownerId, "", owner.boostUntil - state.tick, owner.boost);
      }
    } else if (gadget.kind === "blimp") {
      for (const actor of sortedActors(ctx)) {
        const rival = rivalActor(ctx, gadget.ownerId, actor);
        if ((actor.kind === "player" ? !rival : !activeBad(state, actor)) ||
            distance2(actor, gadget) > gadget.radius * gadget.radius || !safeSpot(ctx, actor, actor.radius)) continue;
        const player = playerById(ctx, actor.playerId ?? actor.id);
        if (rival && player?.perks?.includes("stealth")) continue;
        const target = targetOf(state, actor.id);
        target.slowUntil = Math.max(target.slowUntil, state.tick + 1);
        target.movementScale = Math.min(target.movementScale, 0.5);
      }
    }
  }
  state.gadgets = state.gadgets.filter(gadget => state.tick < gadget.untilTick);
}

/** Called inside the cloned combat reducer; shared input/world objects are never mutated. */
export function stepDevices(state: CombatState, ctx: CombatContext, inputs: CombatInputs): void {
  if ((ctx.wave ?? 2) < 4) return;
  const actorIds = new Set(ctx.actors.map(actor => actor.id));
  for (const player of sortedPlayers(ctx)) {
    const owner = state.players[player.id];
    if (!owner) continue;
    owner.marks = owner.marks.filter(mark => mark.untilTick > state.tick && actorIds.has(mark.targetId))
      .slice(0, DEVICE_TUNING.maxConfidenceMarks);
    if (state.tick >= owner.gearUntil) owner.gear = "none";
    if (state.tick >= owner.boostUntil) owner.boost = "none";
    const input = inputs[player.id] ?? {};
    if (input.gear === true && player.gear && player.gear !== "none" && newlyPressed(owner, "gear", true) && state.tick >= owner.nextGearTick) {
      owner.gear = player.gear;
      owner.gearUntil = state.tick + DEVICE_TUNING.gearTicks;
      owner.nextGearTick = state.tick + DEVICE_TUNING.gearReuseTicks;
      emit(state, "gear.activated", player.id, "", DEVICE_TUNING.gearTicks, player.gear);
    }
    placeOrdinary(state, ctx, player, input);
    activateStreak(state, ctx, player, input);
  }
  tickGadgets(state, ctx, inputs);
}
