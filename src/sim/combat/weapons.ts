import { clamp, dcos, dsin, HALF_PI, PI, wrapAngle } from "../dmath.ts";
import { safeAngle } from "./shared.ts";
import type { CombatContext, CombatInput, CombatPlayer, CombatState, Vec3 } from "./types.ts";

export interface WaterShot {
  yaw: number;
  pitch: number;
  direction: Vec3;
  speed: number;
  range: number;
  /** Rust added by this particle before target resistance or salt multipliers. */
  rustRate: number;
  /** Litres represented by one particle. */
  volume: number;
  rateTicks: number;
  /** Absolute source height, in world metres. */
  spawnHeight: number;
  supply: "water" | "reserve";
  salt: boolean;
  vehicle: boolean;
  /** Total fan width; evenly space pellets from -width/2 through +width/2. */
  spreadRadians: number;
  pellets: number;
}

/**
 * Select a valid water shot without changing ammo, cooldowns or any other state.
 * Mounted fire is wave-gated, and the caller consumes the indicated supply only
 * after it has room to spawn the particle.
 */
export function waterShot(
  state: Readonly<CombatState>,
  player: Readonly<CombatPlayer>,
  input: Readonly<CombatInput>,
  ctx: Readonly<CombatContext>,
): WaterShot | null {
  if (!Object.hasOwn(state.players, player.id)) return null;
  const own = state.players[player.id]!;
  if (input.fire !== true || input.refill || state.tick < own.nextWaterTick || state.pauseUntil > state.tick) return null;
  if (![player.x, player.y, player.z, player.heading, player.speed].every(Number.isFinite)) return null;
  const aliases = ctx.actors.filter(actor => actor.id === player.id || actor.playerId === player.id);
  const canonical = state.targets[player.id];
  if (canonical && canonical.phase !== "active" ||
      aliases.some(actor => state.targets[actor.id] && state.targets[actor.id]!.phase !== "active")) return null;
  if ((state.targets[player.id]?.distractedUntil ?? 0) > state.tick ||
      aliases.some(actor => (state.targets[actor.id]?.distractedUntil ?? 0) > state.tick)) return null;

  const wave = ctx.wave ?? 2;
  const heading = safeAngle(player.heading);
  const desiredYaw = safeAngle(input.aimYaw, heading);
  const relativeYaw = wrapAngle(desiredYaw - heading);
  let yaw = wrapAngle(desiredYaw);
  const pitch = clamp(Number.isFinite(input.aimPitch) ? input.aimPitch! : 0.2, -1.2, 1.2);
  let range = player.nozzle === "pressure" ? 18 : 12;
  let volumeScale = 1;
  let rustScale = 1;
  let spawnHeight = player.y + 1.2;
  let supply: WaterShot["supply"] = "water";

  if (player.mount === "vehicle") {
    if (wave < 3 || Math.abs(player.speed) > 7) return null;
    // A driver shoots out of the nearest side, never through the windscreen.
    yaw = wrapAngle(heading + (relativeYaw < 0 ? -HALF_PI : HALF_PI));
    range = 8;
    volumeScale = 0.6;
    rustScale = 0.6;
  } else if (player.mount === "running-board") {
    if (wave < 3) return null;
  } else if (player.mount === "roof") {
    if (wave < 4 || player.trunk !== true || player.roofCannon !== true) return null;
    // A thirty-degree arc means fifteen degrees to either side of the bonnet.
    yaw = wrapAngle(heading + clamp(relativeYaw, -PI / 12, PI / 12));
    range = 15;
    rustScale = 0.5;
    spawnHeight = player.y + 2;
    supply = "reserve";
  } else if (player.mount !== "foot") return null;

  const boosted = wave >= 4 && own.boostUntil > state.tick;
  if (boosted && own.boost === "pressure") range *= 1.5;
  const volume = (player.flowTier === 1 ? 1.2 : 0.8) / 10 * volumeScale;
  const available = supply === "reserve" ? own.reserve : own.water;
  if (!Number.isFinite(available) || available + 1e-10 < volume) return null;
  const salt = supply === "reserve" ? false : own.salt || boosted && own.boost === "salt";
  const horizontal = dcos(pitch);
  return {
    yaw,
    pitch,
    direction: { x: dsin(yaw) * horizontal, y: dsin(pitch), z: -dcos(yaw) * horizontal },
    speed: player.flowTier === 1 ? 16 : 13,
    range,
    rustRate: (player.flowTier === 1 ? 0.035 : 0.025) * rustScale,
    volume,
    rateTicks: 6,
    spawnHeight,
    supply,
    salt,
    vehicle: player.mount !== "foot",
    spreadRadians: boosted && own.boost === "wide" ? PI / 15 : 0,
    pellets: boosted && own.boost === "wide" ? 3 : 1,
  };
}
