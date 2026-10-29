/** SIM21 physical flower lob; owner/rival authority is rechecked at swept contact. */
import { clamp, dcos, dsin, dtan } from "../dmath.ts";
import { MAX_PROJECTILES, emit, initialTarget, playerById, safeAngle, sortedPlayers } from "./shared.ts";
import type { CombatActor, CombatContext, CombatInputs, CombatState, Projectile, TargetCombat } from "./types.ts";

export const FLOWER_TUNING = {
  cooldownTicks: 90,
  range: 20,
  horizontalSpeed: 12,
  muzzleHeight: 1.35,
  defaultPitch: 0.2,
  minimumPitch: -0.35,
  maximumPitch: 0.85,
  distractionTicks: 90,
  cleanStreetsPoints: 25,
  royalePoints: 150,
  royaleRunwayCost: 1,
} as const;

/** A match owns its combat state. Reset it between matches to remove hair flowers. */
export const FLOWERS_UNTIL_MATCH_RESET = Number.MAX_SAFE_INTEGER;
export const FLOWER_EVENT = {
  launch: "weapon.flower",
  hit: "pvp.flower-hit",
  hair: "player.flowers",
  distracted: "player.distracted",
  score: "pvp.score",
  runway: "player.runway",
} as const;

function enabled(ctx: CombatContext): boolean {
  return (ctx.simVersion??27)>=27&&((ctx.wave??2)>=4&&ctx.mode==="clean-streets"||(ctx.wave??2)>=5&&(ctx.mode==="fog-royale"||ctx.mode==="other-pvp"));
}
function authorizedRival(ctx: CombatContext, ownerId: string, targetId: string): boolean {
  const rivals = ctx.rivalPlayerIds && Object.hasOwn(ctx.rivalPlayerIds, ownerId) ? ctx.rivalPlayerIds[ownerId] : undefined;
  return targetId !== ownerId && Array.isArray(rivals) && rivals.includes(targetId) && playerById(ctx, targetId) !== undefined;
}
function ownedTarget(state: CombatState, id: string): TargetCombat {
  if (!Object.hasOwn(state.targets, id)) {
    Object.defineProperty(state.targets, id, { value: initialTarget(), enumerable: true, writable: true, configurable: true });
  }
  return state.targets[id]!;
}

/**
 * Held alt-fire launches a slow ballistic lob at most every 90 fixed ticks.
 * Authority is supplied by the mode lane; absent rival assignments fail closed.
 * Range is horizontal travel, clipped by the ordinary projectile sweep.
 */
export function launchFlowers(state: CombatState, ctx: CombatContext, inputs: CombatInputs): void {
  if (!enabled(ctx)||state.pauseUntil>state.tick) return;
  for (const player of sortedPlayers(ctx)) {
    const input = inputs[player.id];
    if (!input?.altFire || input.refill || !Object.hasOwn(state.players, player.id)) continue;
    const own = state.players[player.id]!;
    if (state.tick < own.nextFlowerTick || state.projectiles.length >= MAX_PROJECTILES) continue;
    const rivals = ctx.rivalPlayerIds && Object.hasOwn(ctx.rivalPlayerIds, player.id) ? ctx.rivalPlayerIds[player.id] : undefined;
    if (!Array.isArray(rivals) || !rivals.some(id => authorizedRival(ctx, player.id, id))) continue;
    const constraints = [state.targets[player.id], ...ctx.actors.filter(actor => actor.kind === "player" && actor.playerId === player.id).map(actor => state.targets[actor.id])];
    if (constraints.some(target => target !== undefined && (target.phase !== "active" || target.distractedUntil > state.tick))) continue;
    const yaw = safeAngle(input.aimYaw, player.heading);
    const pitch = clamp(Number.isFinite(input.aimPitch) ? input.aimPitch! : FLOWER_TUNING.defaultPitch, FLOWER_TUNING.minimumPitch, FLOWER_TUNING.maximumPitch);
    const id = state.nextId++;
    state.projectiles.push({
      id, kind: "flower", ownerId: player.id,
      x: player.x, y: player.y + FLOWER_TUNING.muzzleHeight, z: player.z,
      vx: dsin(yaw) * FLOWER_TUNING.horizontalSpeed,
      vy: dtan(pitch) * FLOWER_TUNING.horizontalSpeed,
      vz: -dcos(yaw) * FLOWER_TUNING.horizontalSpeed,
      bornTick: state.tick, distance: 0, range: FLOWER_TUNING.range,
      volume: 0, salt: false, vehicle: player.mount !== "foot", rustRate: 0,
    });
    own.nextFlowerTick = state.tick + FLOWER_TUNING.cooldownTicks;
    emit(state, FLOWER_EVENT.launch, player.id, "", id, ctx.mode!);
  }
}

/**
 * Called only for a swept flower contact. Recheck the current mode and rival
 * authority: a team change or mode transition while a lob is in flight cannot
 * damage a teammate. Human and robot NPCs are never valid recipients.
 */
export function applyFlowerHit(state: CombatState, ctx: CombatContext, projectile: Projectile, actor: CombatActor): void {
  if (!enabled(ctx) || projectile.kind !== "flower" || actor.kind !== "player" || actor.protected===true || actor.child===true || actor.mobilityAid===true || actor.posture==="seated" || actor.posture==="lying" ||
      !Number.isSafeInteger(projectile.id)||projectile.id<1||!Number.isSafeInteger(projectile.bornTick)||projectile.bornTick>state.tick||state.tick-projectile.bornTick>240||
      !Number.isFinite(projectile.distance) || projectile.distance < 0 || projectile.distance > FLOWER_TUNING.range + 1e-9 ||
      !Object.hasOwn(state.players, projectile.ownerId) || !playerById(ctx, projectile.ownerId)) return;
  const playerId = actor.playerId ?? actor.id;
  if (!Object.hasOwn(state.players, playerId) || !authorizedRival(ctx, projectile.ownerId, playerId)) return;
  const oldActor = Object.hasOwn(state.targets, actor.id) ? state.targets[actor.id] : undefined;
  const oldPlayer = Object.hasOwn(state.targets, playerId) ? state.targets[playerId] : undefined;
  if (oldActor && oldActor.phase !== "active" || oldPlayer && oldPlayer.phase !== "active") return;
  const receipts=(state.flowerReceipts??[]).filter(receipt=>receipt.untilTick>state.tick&&Object.hasOwn(state.players,receipt.ownerId));
  if(receipts.some(receipt=>receipt.projectileId===projectile.id&&receipt.ownerId===projectile.ownerId)||receipts.length>=MAX_PROJECTILES)return;
  state.flowerReceipts=[...receipts,{projectileId:projectile.id,ownerId:projectile.ownerId,untilTick:projectile.bornTick+241}].sort((a,b)=>a.projectileId-b.projectileId||(a.ownerId<b.ownerId?-1:a.ownerId>b.ownerId?1:0));
  const targets = [ownedTarget(state, playerId)];
  if (actor.id !== playerId) targets.push(ownedTarget(state, actor.id));
  for (const target of targets) {
    target.flowersUntil = FLOWERS_UNTIL_MATCH_RESET;
    if (ctx.mode === "clean-streets") target.distractedUntil = Math.max(target.distractedUntil, state.tick + FLOWER_TUNING.distractionTicks);
  }
  emit(state, FLOWER_EVENT.hit, projectile.ownerId, playerId, projectile.id, ctx.mode!);
  emit(state, FLOWER_EVENT.hair, projectile.ownerId, playerId, FLOWERS_UNTIL_MATCH_RESET, "until-match-reset");
  if (ctx.mode === "clean-streets") {
    emit(state, FLOWER_EVENT.distracted, projectile.ownerId, playerId, FLOWER_TUNING.distractionTicks, "spray-and-scan");
    emit(state, FLOWER_EVENT.score, projectile.ownerId, projectile.ownerId, FLOWER_TUNING.cleanStreetsPoints, "flower");
  } else if (ctx.mode === "fog-royale") {
    emit(state, FLOWER_EVENT.runway, projectile.ownerId, playerId, -FLOWER_TUNING.royaleRunwayCost, "flower");
    emit(state, FLOWER_EVENT.score, projectile.ownerId, projectile.ownerId, FLOWER_TUNING.royalePoints, "flower");
  }
}
