// What the relay remembers between matches: finished matches, per-identity stats and the
// leaderboards built from them. Behind this interface so the backing store can change (SQLite on a
// Fly volume today: sqlite.ts). Identities are the SHA-256 of a device's guest token; the only
// personal-ish data is the generated display name (never free text). Retention: server/README.md.
import type { NetModeId } from "../../src/net/protocol.ts";

export interface MatchPlayerRecord {
  /** SHA-256 of the device token, hex. */
  device: string;
  name: string;
  look: number;
  team: number;
  score: number;
  won: boolean;
}
export interface MatchRecord {
  id: string;
  mode: NetModeId;
  world: string;
  startedAt: number;
  endedAt: number;
  reason: string;
  /** People only: bots are never recorded. */
  players: MatchPlayerRecord[];
}
export type LeaderboardPeriod = "week" | "all";
export interface LeaderboardEntry { rank: number; name: string; look: number; best: number; matches: number; wins: number }
export interface PlayerStats { name: string; matches: number; wins: number; modes: Partial<Record<NetModeId, { matches: number; wins: number; best: number; total: number }>> }

export interface RelayStore {
  /** Idempotent: a match id already recorded is ignored. Returns whether it was new. */
  recordMatch(match: MatchRecord): boolean;
  stats(device: string): PlayerStats | null;
  leaderboard(mode: NetModeId, period: LeaderboardPeriod, now: number, limit?: number): LeaderboardEntry[];
  /** Drop what the retention policy no longer keeps. Returns rows removed. */
  prune(now: number): number;
  close(): void;
}

/** Retention (server/README.md, Data and retention). */
export const RETENTION = {
  /** Match history (and therefore weekly boards) older than this is deleted. */
  matchMs: 90 * 24 * 3600_000,
  /** A player not seen for this long is deleted with their all-time stats. */
  playerMs: 365 * 24 * 3600_000,
} as const;

/** Monday 00:00 UTC of the week containing `now`: weekly boards reset then. */
export function weekStart(now: number): number {
  const day = new Date(now);
  const offset = (day.getUTCDay() + 6) % 7;
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - offset);
}
