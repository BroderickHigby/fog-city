import type { DodgeState, SimState } from "../contract.ts";
import type { JsonObject } from "../extensions.ts";

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
  return { enabled: true, version: 1, wave: wave as AgentRuntimeWave, startGameMinute, startWeekday };
}

export interface RuntimeRestoreSafehouse {
  id: string;
  x: number;
  z: number;
  radiusM?: number;
}

/** Only authored or purchased sites supplied by the caller can restore recruits. */
export function runtimeRestoreSafehouses(state: Readonly<SimState>): RuntimeRestoreSafehouse[] {
  const source = state.ext.robots?.restoreSafehouses;
  if (source === undefined) return [];
  if (!Array.isArray(source) || source.length > 64) throw new RangeError("Invalid restore safehouse count");
  const result: RuntimeRestoreSafehouse[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id || item.id.length > 128 ||
        typeof item.x !== "number" || !Number.isFinite(item.x) || Math.abs(item.x) > 1e7 ||
        typeof item.z !== "number" || !Number.isFinite(item.z) || Math.abs(item.z) > 1e7 ||
        (item.radiusM !== undefined && (typeof item.radiusM !== "number" || !Number.isFinite(item.radiusM) || item.radiusM < 1 || item.radiusM > 30)) ||
        result.some(site => site.id === item.id)) throw new RangeError("Invalid restore safehouse");
    result.push({ id: item.id, x: item.x, z: item.z, ...(item.radiusM !== undefined ? { radiusM: item.radiusM } : {}) });
  }
  return result.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Old replays remain unchanged until their caller explicitly starts agent gameplay. */
export function enableAgentRuntime(state: Readonly<SimState>, options: {
  wave?: AgentRuntimeWave;
  startGameMinute?: number;
  startWeekday?: number;
  restoreSafehouses?: readonly RuntimeRestoreSafehouse[];
} = {}): SimState {
  const session: AgentRuntimeSession = {
    enabled: true, version: 1, wave: options.wave ?? 8,
    startGameMinute: options.startGameMinute ?? 12 * 60,
    startWeekday: options.startWeekday ?? 0,
  };
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
