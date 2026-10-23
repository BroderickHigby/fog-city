import type { CombatActor, CombatContext, CombatInput, CombatInputs, CombatPlayer, StreakKind } from "../../../src/sim/combat/types.ts";

type CombatRuntime = Pick<typeof import("../../../src/sim/combat/index.ts"), "createCombatState" | "stepCombat">;
type Serializer = Pick<typeof import("../../../src/sim/serialize.ts"), "hashState" | "canonicalJson">;

export const COMBAT_PARITY_TICKS = 2000;

function floor(x: number, _z: number): number { return x >= 25 ? 0.1 : 0; }

function player(id: string, x: number, z: number): CombatPlayer {
  return { id, x, y: floor(x, z), z, heading: 0, speed: 0, mount: "foot", tankTier: 2, flowTier: 0,
    scannerTier: 3, nozzle: "pressure", gear: "boots", gadget: "sprinkler", trunk: true, roofCannon: true };
}

function robot(id: string, x: number, z: number, patch: Partial<CombatActor> = {}): CombatActor {
  return { id, kind: "robot", firmware: "bad", model: "footman", x, y: floor(x, z), z,
    radius: 0.45, height: 1.8, heading: 0, speed: 0, subtlety: 2, ...patch };
}

function scene(tick: number): { ctx: CombatContext; inputs: CombatInputs } {
  const p1 = player("p1", tick <= 360 ? 0 : tick <= 665 ? -8 : tick <= 775 ? 4 : tick <= 1150 ? 0 : 30, 0);
  const p2 = player("p2", tick <= 900 ? 20 : tick <= 1150 ? 0 : 40, tick > 900 && tick <= 1150 ? -5 : 0);
  if (tick === 1250) p2.gadget = "balloon";
  const actors: CombatActor[] = [
    robot("good-helper", 4, -4, { firmware: "good" }),
    robot("protected-child", -8, -2, { kind: "person", firmware: "none", child: true, radius: 0.7 }),
    robot("behind-child", -8, -7),
    robot("taxi", 0, -6, { model: "robotaxi", heading: 3.141592653589793, obeysTraffic: true }),
    robot("scanner-bot", 20, -3),
    robot("sprinkler-bot", 30, -3),
    robot("balloon-bot", 40, -14),
    robot("fan-bot", 42, 0),
    robot("patrol", 52, 20, { model: "patrol" }),
    robot("body:p1", p1.x, p1.z, { kind: "player", firmware: "none", playerId: "p1", robotBody: false }),
    robot("body:p2", p2.x, p2.z, { kind: "player", firmware: "none", playerId: "p2", robotBody: false }),
  ];
  if (tick <= 775) actors.push(robot("front-bot", 0, -4));
  if (tick > 900 && tick <= 1150) actors.push(robot("flower-bystander", 0, -2, { kind: "person", firmware: "none" }));
  const grants: Partial<Record<number, StreakKind>> = {
    1450: "confidence", 1500: "parrots", 1550: "tensor", 1600: "hydrants", 1650: "blimp", 1800: "agi",
  };
  const grant = grants[tick];
  const one: CombatInput = { aimYaw: 0, aimPitch: 0 };
  const two: CombatInput = { aimYaw: 0, aimPitch: 0 };
  if (tick <= 60) one.scan = true;
  if (tick <= 120) two.scan = true;
  if (tick > 60 && tick <= 360 || tick > 360 && tick <= 480 || tick > 665 && tick <= 775) one.fire = true;
  if (tick > 480 && tick <= 665) one.refill = "bay";
  if (tick === 780) one.cone = true;
  if (tick > 900 && tick <= 1150) one.altFire = true;
  if (tick === 1160) { one.gadget = "sprinkler"; one.targetX = 30; one.targetZ = 0; }
  if (tick === 1250) { two.gadget = "balloon"; two.aimPitch = 0; }
  if (tick === 1360) one.gear = true;
  if (grant) { one.streak = grant; one.targetX = 50; one.targetZ = 20; }
  if (tick > 1550 && tick <= 1735) one.boost = "wide";
  if (tick > 1735 && tick < 1800) { one.fire = true; one.aimYaw = 1.5707963267948966; one.aimPitch = 0.3; }
  return {
    ctx: {
      wave: 5, mode: "clean-streets", players: tick % 2 ? [p1, p2] : [p2, p1],
      actors: tick % 2 ? actors : actors.reverse(),
      walls: [{ id: "thin-wall", minX: -9, maxX: -7, minY: 0, maxY: 3, minZ: -6.01, maxZ: -6 }],
      refills: [
        { id: "bay", kind: "bay", x: -8, y: 0, z: 0, radius: 2, salt: true },
        { id: "hydrant", kind: "hydrant", x: 30, y: 0.1, z: 0, radius: 2, salt: false },
      ],
      safeLots: [{ id: "supply-lot", x: 31, y: 0.1, z: 0, radius: 3 }],
      ...(grant ? { streaks: [{ sequence: 1, playerId: "p1", kind: grant }] } : {}),
      rivalPlayerIds: { p1: ["p2"], p2: ["p1"] },
      groundHeight: floor, conversionCap: 12,
    },
    inputs: { p1: one, p2: two },
  };
}

/** Shared by Node and browser runners; no clock, IO, or ambient randomness. */
export function runCombatParity(runtime: CombatRuntime, serializer: Serializer) {
  let state = runtime.createCombatState(90210, scene(0).ctx);
  const hashes: Array<{ tick: number; hash: string }> = [];
  const eventCounts: Record<string, number> = {};
  let shieldSnapshot: { protectedWetUntil: number; behindRust: number } | null = null;
  let maxProjectiles = 0;
  for (let tick = 1; tick <= COMBAT_PARITY_TICKS; tick++) {
    const next = scene(tick);
    state = runtime.stepCombat(state, next.ctx, next.inputs);
    maxProjectiles = Math.max(maxProjectiles, state.projectiles.length);
    for (const event of state.events) eventCounts[event.kind] = (eventCounts[event.kind] ?? 0) + 1;
    if (tick === 480) shieldSnapshot = { protectedWetUntil: state.targets["protected-child"]!.wetUntil,
      behindRust: state.targets["behind-child"]!.rust };
    if (tick % 60 === 0) hashes.push({ tick, hash: serializer.hashState(state) });
  }
  return {
    ticks: state.tick,
    hashes,
    finalHash: serializer.hashState(state),
    finalJSON: serializer.canonicalJson(state),
    eventCounts: Object.fromEntries(Object.keys(eventCounts).sort().map(key => [key, eventCounts[key]!])),
    shieldSnapshot,
    maxProjectiles,
  };
}
