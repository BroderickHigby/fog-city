import type { PlayerId, SimEvent, SimEventKind } from "./contract.ts";
import type { JsonObject } from "./extensions.ts";

export interface Position { x: number; y: number; z: number }
export interface GameplayBody extends Position { id: string; mode: "vehicle" | "foot"; speed: number }
export interface GameplayFact { id: string; tick: number; source: "combat" | "agents" | "world" | "modes"; sequence: number; kind: string; playerId: string; actorId?: string; amount?: number; detail?: string }
export interface GameplayEvent { id: number; tick: number; kind: string; playerId: string; targetId: string; amount: number; detail: string; payload?: ThreatSpawnRequest | JsonObject }
export interface RewardActor { id: string; firmware: "good" | "bad" | "none"; armoured?: boolean; subtlety?: number; caughtInAct?: boolean; witnessedByBad?: boolean; peopleWitnesses?: number }
export interface PlayerObservation { playerId: string; seenByBad: boolean; seenByAssociate: boolean; associateWithin200: boolean; fog: number; protectedArea: boolean; watchingActorId?: string; watchedTicks?: number; atSafehouseId?: string; actorBindings?: Readonly<Record<string, string>> }

export const GAMEPLAY_COMMAND_KINDS = [
  "buy", "sleep", "repair", "mission-start", "mission-retry", "mission-ack", "mission-answer",
  "startup-define", "activity-start", "activity-complete", "bridge-accept", "loadout", "streak-call",
  "close-ad", "break-free", "coit-viewer",
] as const;
export type GameplayCommandKind = typeof GAMEPLAY_COMMAND_KINDS[number];
export interface GameplayCommand {
  sequence: number;
  playerId: PlayerId;
  kind: GameplayCommandKind;
  targetId?: string;
  itemId?: string;
  choiceId?: string;
  questionId?: string;
  kitId?: string;
}
export type GameplayCommandPayload = Omit<GameplayCommand, "playerId">;
export interface GameplayCommandEvent extends SimEvent {
  kind: typeof SimEventKind.gameplayCommand;
  playerId: PlayerId;
  payload: GameplayCommandPayload;
}

const ID_FIELDS = ["targetId", "itemId", "choiceId", "questionId", "kitId"] as const;
/** Commands contain IDs, never unfiltered UI text. Catalog membership is checked by its owner. */
export function isGameplayId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
    && !Object.hasOwn(Object.prototype, value) && value !== "prototype";
}

/** Decode only the recorded command boundary; each subsystem validates its own semantics. */
export function gameplayCommandFromEvent(event: Readonly<SimEvent>): GameplayCommand | null {
  if (event.kind !== "gameplay.command" || !Number.isSafeInteger(event.tick) || event.tick < 0 || !isGameplayId(event.playerId)) return null;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (!Number.isSafeInteger(p.sequence) || (p.sequence as number) < 1 || !GAMEPLAY_COMMAND_KINDS.includes(p.kind as GameplayCommandKind)) return null;
  for (const key of Object.keys(p)) if (key !== "sequence" && key !== "kind" && !ID_FIELDS.includes(key as typeof ID_FIELDS[number])) return null;
  for (const key of ID_FIELDS) if (p[key] !== undefined && !isGameplayId(p[key])) return null;
  if (p.kind === "coit-viewer" && (p.targetId !== "coit-recon" || !["open", "close", "tag", "flag", "skip"].includes(p.choiceId as string) ||
      Object.keys(p).some(key => !["sequence", "kind", "targetId", "choiceId"].includes(key)))) return null;
  const command: GameplayCommand = { sequence: p.sequence as number, kind: p.kind as GameplayCommandKind, playerId: event.playerId };
  for (const key of ID_FIELDS) if (p[key] !== undefined) command[key] = p[key] as string;
  return command;
}

/** Stable request identity lets service dispatch remain exactly-once across repeated observations. */
interface ThreatSpawnBase {
  id: string;
  requestTick: number;
  playerId: PlayerId;
  /**
   * Where the player was when heat rose, rounded to whole metres (threatSpawnPosition), so the
   * payload holds integers only and replays, saves and netcode carry no float bits.
   */
  player: { x: number; z: number };
}
/** The integer position a threat.spawn payload carries: whole metres, ties away from zero. */
export function threatSpawnPosition(body: Readonly<{ x: number; z: number }>): { x: number; z: number } {
  const whole = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v)) || 0;
  return { x: whole(body.x), z: whole(body.z) };
}
export type ThreatSpawnRequest = ThreatSpawnBase & (
  { kind: "van"; threat: 2; unitCount: 2 }
  | { kind: "drone" | "patrol" | "swarm" | "taxi"; threat: 3 | 4 | 5; unitCount: number }
);
