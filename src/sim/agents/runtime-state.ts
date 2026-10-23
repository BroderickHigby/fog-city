import type { DodgeState, SimState } from "../contract.ts";
import type { JsonObject } from "../extensions.ts";
import { runtimeOwnedSafehouses } from "./runtime-economy.ts";

export type AgentRuntimeWave = 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Extra physical actors use the same final clearance pass as legacy road agents. */
export interface RuntimePhysicalBody {
  id: string;
  numericId: number;
  kind: "person" | "animal" | "robot" | "vehicle";
  model: string;
  firmware?: "good" | "bad" | "none";
  operational?: boolean;
  district?: string;
  x: number;
  y: number;
  z: number;
  previousX: number;
  previousZ: number;
  heading: number;
  previousHeading: number;
  speed: number;
  radius: number;
  halfLength: number;
  halfWidth: number;
  height: number;
  dodge: DodgeState | null;
}

export interface AgentRuntimeSession {
  /** Opt-in deterministic 100 m square/visit-epoch ambient population. */
  ambientMode?: "squares-v1";
  /** Explicit loader identity; absent in legacy/synthetic sessions. */
  worldName?: string;
  enabled: true;
  version: 1;
  wave: AgentRuntimeWave;
  startGameMinute: number;
  startWeekday: number;
}

/** Runtime activation is serialized so Node, browser and restored replays agree. */
export function agentRuntimeSession(state: Readonly<SimState>): AgentRuntimeSession | null {
  const value = state.ext.robots;
  if (!value || typeof value !== "object" || value.enabled !== true || value.version !== 1) return null;
  const wave = value.wave;
  if (!Number.isInteger(wave) || Number(wave) < 2 || Number(wave) > 8) return null;
  const startGameMinute = value.startGameMinute;
  const startWeekday = value.startWeekday;
  if (typeof startGameMinute !== "number" || !Number.isFinite(startGameMinute) || startGameMinute < 0 ||
      typeof startWeekday !== "number" || !Number.isInteger(startWeekday) || startWeekday < 0 || startWeekday > 6) return null;
  if (value.worldName !== undefined && !validWorldName(value.worldName)) return null;
  if (value.ambientMode !== undefined && value.ambientMode !== "squares-v1") return null;
  return { ...(value.ambientMode === "squares-v1" ? { ambientMode: "squares-v1" } : {}), ...(value.worldName !== undefined ? { worldName: value.worldName as string } : {}), enabled: true, version: 1, wave: wave as AgentRuntimeWave, startGameMinute, startWeekday };
}

function validWorldName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

export interface RuntimeRestoreSafehouse {
  id: string;
  x: number;
  z: number;
  radiusM?: number;
}

/** Actual owned catalog safehouses plus explicit caller-authored restoration sites. */
export function runtimeRestoreSafehouses(state: Readonly<SimState>): RuntimeRestoreSafehouse[] {
  const source = state.ext.robots?.restoreSafehouses;
  if (source !== undefined && (!Array.isArray(source) || source.length > 64)) throw new RangeError("Invalid restore safehouse count");
  const result: RuntimeRestoreSafehouse[] = [];
  for (const item of source ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id || item.id.length > 128 ||
        typeof item.x !== "number" || !Number.isFinite(item.x) || Math.abs(item.x) > 1e7 ||
        typeof item.z !== "number" || !Number.isFinite(item.z) || Math.abs(item.z) > 1e7 ||
        (item.radiusM !== undefined && (typeof item.radiusM !== "number" || !Number.isFinite(item.radiusM) || item.radiusM < 1 || item.radiusM > 30)) ||
        result.some(site => site.id === item.id)) throw new RangeError("Invalid restore safehouse");
    result.push({ id: item.id, x: item.x, z: item.z, ...(item.radiusM !== undefined ? { radiusM: item.radiusM } : {}) });
  }
  const session = agentRuntimeSession(state);
  if (session) for (const site of runtimeOwnedSafehouses(state, session.wave)) {
    const index = result.findIndex(item => item.id === site.id);
    if (index < 0) result.push(site);
    else result[index] = site;
  }
  return result.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Old replays remain unchanged until their caller explicitly starts agent gameplay. */
export function enableAgentRuntime(state: Readonly<SimState>, options: {
  ambientMode?: "squares-v1";
  wave?: AgentRuntimeWave;
  worldName?: string;
  startGameMinute?: number;
  startWeekday?: number;
  restoreSafehouses?: readonly RuntimeRestoreSafehouse[];
} = {}): SimState {
  const session: AgentRuntimeSession = {
    enabled: true, version: 1, wave: options.wave ?? 8,
    ...(options.ambientMode !== undefined ? { ambientMode: options.ambientMode } : {}),
    ...(options.worldName !== undefined ? { worldName: options.worldName } : {}),
    startGameMinute: options.startGameMinute ?? 12 * 60,
    startWeekday: options.startWeekday ?? 0,
  };
  if (session.ambientMode !== undefined && session.ambientMode !== "squares-v1") throw new RangeError("Invalid ambient mode");
  if (session.worldName !== undefined && !validWorldName(session.worldName)) throw new RangeError("Invalid runtime world name");
  if (!Number.isInteger(session.wave) || session.wave < 2 || session.wave > 8 ||
      !Number.isFinite(session.startGameMinute) || session.startGameMinute < 0 ||
      !Number.isInteger(session.startWeekday) || session.startWeekday < 0 || session.startWeekday > 6) {
    throw new RangeError("Invalid agent runtime session");
  }
  const next = {
    ...state,
    ext: { ...state.ext, robots: { ...(state.ext.robots ?? {}), ...session, ...(options.restoreSafehouses ? { restoreSafehouses: options.restoreSafehouses.map(site => ({ ...site })) } : {}) } as JsonObject },
  };
  runtimeRestoreSafehouses(next);
  return next;
}

/** Shared game scale: one real second advances one game minute. */
export function runtimeGameMinute(state: Readonly<SimState>): number {
  const session = agentRuntimeSession(state);
  return (session?.startGameMinute ?? 12 * 60) + state.tick / 60;
}
