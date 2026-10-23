import type { RngState } from "./contract.ts";

/** Shared combat adapter and persisted state contract. Implementations live in combat/. */
export type CombatWave = 2 | 3 | 4 | 5;
export type RobotModel = "footman" | "trundle" | "robotaxi" | "patrol" | "drone" | "sign-spinner" | "tidy" | "walker";
export interface Vec3 { x: number; y: number; z: number }
export interface CombatActor extends Vec3 {
  id: string;
  kind: "robot" | "person" | "animal" | "player";
  radius: number;
  height: number;
  heading: number;
  speed: number;
  firmware: "good" | "bad" | "none";
  model?: RobotModel;
  playerId?: string;
  robotBody?: boolean;
  child?: boolean;
  protected?: boolean;
  posture?: "standing" | "seated" | "lying";
  mobilityAid?: boolean;
  subtlety?: number;
  obeysTraffic?: boolean;
  occupied?: boolean;
  sheltered?: boolean;
  pursuing?: boolean;
  inFidelity?: boolean;
  /** Optional explicit resistance rate overriding the model default; finite, greater than 0 through 1. */
  rustScale?: number;
}
export type Mount = "foot" | "vehicle" | "running-board" | "roof";
export interface CombatPlayer extends Vec3 {
  id: string;
  heading: number;
  speed: number;
  mount: Mount;
  tankTier: 0 | 1 | 2;
  flowTier: 0 | 1;
  scannerTier: 1 | 2 | 3 | 4;
  nozzle?: "standard" | "pressure";
  gear?: "boots" | "airplane" | "none";
  gadget?: "balloon" | "sprinkler" | "speaker";
  perks?: readonly ("quiet" | "stealth" | "marine" | "brackish" | "whisperer" | "lean")[];
  trunk?: boolean;
  roofCannon?: boolean;
}
export interface Wall { id: string; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
export interface RefillSource extends Vec3 { id: string; kind: "hydrant" | "fountain" | "bay" | "puddle" | "trunk"; radius: number; salt: boolean; ownerId?: string }
export type AttackKind = "shove" | "snatch" | "ad-blast" | "phone-hack" | "handshake" | "forced-update";
export interface AttackRequest { id: string; sequence: number; attackerId: string; targetId: string; kind: AttackKind }
export interface StreakGrant { sequence: number; playerId: string; kind: StreakKind }
export type StreakKind = "confidence" | "parrots" | "tensor" | "blimp" | "hydrants" | "agi";
export interface CombatInput {
  fire?: boolean;
  scan?: boolean;
  refill?: string;
  cone?: boolean;
  altFire?: boolean;
  aimYaw?: number;
  aimPitch?: number;
  gadget?: "balloon" | "sprinkler" | "speaker";
  gear?: boolean;
  breakFree?: boolean;
  closeAd?: boolean;
  streak?: StreakKind;
  targetX?: number;
  targetZ?: number;
  boost?: "salt" | "pressure" | "wide";
}
export type CombatInputs = Readonly<Record<string, Readonly<CombatInput>>>;
/** Every containing scope must have room before a good robot can be converted. */
export interface ConversionScope {
  readonly id: string;
  readonly actorIds: readonly string[];
  readonly cap: number;
}
export interface CombatContext {
  wave?: CombatWave;
  actors: readonly CombatActor[];
  players: readonly CombatPlayer[];
  refills: readonly RefillSource[];
  walls: readonly Wall[];
  attacks?: readonly AttackRequest[];
  groundHeight?: (x: number, z: number) => number;
  safeLots?: readonly (Vec3 & { id: string; radius: number })[];
  streaks?: readonly StreakGrant[];
  night?: boolean;
  fog?: number;
  rain?: number;
  conversionCap?: number;
  /** Absent preserves the legacy scalar cap; an explicit empty list denies conversion. */
  conversionScopes?: readonly ConversionScope[];
  rivalPlayerIds?: Readonly<Record<string, readonly string[]>>;
  mode?: "free-roam" | "clean-streets" | "fog-royale" | "other-pvp";
}
export interface ScanResult { targetId: string; bad: boolean; confidence: number; tick: number }
export interface PlayerCombat {
  water: number;
  salt: boolean;
  reserve: number;
  cones: number;
  balloons: number;
  nextWaterTick: number;
  nextConeTick: number;
  nextFlowerTick: number;
  nextGadgetTick: number;
  nextGearTick: number;
  gearUntil: number;
  gear: "boots" | "airplane" | "none";
  refillId: string;
  refillTicks: number;
  scanId: string;
  scanTicks: number;
  nextScanTick: number;
  scan: ScanResult | null;
  previousMount: Mount;
  held: string[];
  boost: "none" | "salt" | "pressure" | "wide";
  boostUntil: number;
  lastParrotsTick: number;
  streakSequence: Partial<Record<StreakKind, number>>;
  marks: { targetId: string; untilTick: number; confidence: number; hallucination: boolean }[];
}
export interface TargetCombat {
  rust: number;
  phase: "active" | "seized" | "slumping" | "heap" | "disabled" | "cleared";
  phaseTick: number;
  lastWaterTick: number;
  heightScale: number;
  puddle: boolean;
  repair: boolean;
  penalized: boolean;
  wetHits: number[];
  wetUntil: number;
  blindUntil: number;
  waryUntil: number;
  alerted: boolean;
  pullOverTick: number;
  pullOverSpeed: number;
  stoppedUntil: number;
  flowersUntil: number;
  slowUntil: number;
  distractedUntil: number;
  sourceId: string;
  movementScale: number;
  windupScale: number;
}
export interface Projectile extends Vec3 {
  id: number;
  kind: "water" | "cone" | "balloon" | "flower";
  ownerId: string;
  vx: number;
  vy: number;
  vz: number;
  distance: number;
  range: number;
  bornTick: number;
  volume: number;
  salt: boolean;
  vehicle: boolean;
  rustRate: number;
}
export interface Gadget extends Vec3 {
  id: number;
  kind: "sprinkler" | "speaker" | "parrots" | "tensor" | "blimp" | "hydrants";
  ownerId: string;
  untilTick: number;
  targetId: string;
  radius: number;
  progress: number;
  boost: "salt" | "pressure" | "wide";
}
export interface PendingAttack { id: string; kind: AttackKind; attackerId: string; targetId: string; startTick: number; resolveTick: number; endTick: number; presses: number; active: boolean }
export interface CombatEvent { id: number; tick: number; kind: string; sourceId: string; targetId: string; amount: number; detail: string }
export interface CombatState {
  version: 1;
  tick: number;
  rng: RngState;
  nextId: number;
  players: Record<string, PlayerCombat>;
  targets: Record<string, TargetCombat>;
  projectiles: Projectile[];
  gadgets: Gadget[];
  attacks: PendingAttack[];
  attackSequence: Record<string, number>;
  events: CombatEvent[];
  pauseUntil: number;
}
