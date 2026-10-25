// The relay store on SQLite (Node's built-in node:sqlite: no native dependency). One file, e.g.
// /data/relay.sqlite on a Fly volume; ":memory:" for tests and for a relay run without a volume.
import { DatabaseSync } from "node:sqlite";
import { MODES, type NetModeId } from "../../src/net/protocol.ts";
import { RETENTION, weekStart, type LeaderboardEntry, type LeaderboardPeriod, type MatchRecord, type PlayerStats, type RelayStore } from "./store.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, world TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_mode_ended ON matches(mode, ended_at);
CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  device TEXT NOT NULL, name TEXT NOT NULL, look INTEGER NOT NULL, team INTEGER NOT NULL,
  score INTEGER NOT NULL, won INTEGER NOT NULL,
  PRIMARY KEY (match_id, device)
);
CREATE INDEX IF NOT EXISTS match_players_device ON match_players(device);
CREATE TABLE IF NOT EXISTS players (
  device TEXT PRIMARY KEY, name TEXT NOT NULL, look INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS player_modes (
  device TEXT NOT NULL REFERENCES players(device) ON DELETE CASCADE, mode TEXT NOT NULL,
  matches INTEGER NOT NULL, wins INTEGER NOT NULL, best INTEGER NOT NULL, total INTEGER NOT NULL,
  PRIMARY KEY (device, mode)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '1');
`;

const DEVICE = /^[a-f0-9]{64}$/;

export function openSqliteStore(path: string): RelayStore {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const insertMatch = db.prepare("INSERT OR IGNORE INTO matches(id, mode, world, started_at, ended_at, reason) VALUES (?, ?, ?, ?, ?, ?)");
  const insertPlayer = db.prepare("INSERT OR IGNORE INTO match_players(match_id, device, name, look, team, score, won) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const upsertPlayer = db.prepare("INSERT INTO players(device, name, look, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(device) DO UPDATE SET name = excluded.name, look = excluded.look, last_seen = MAX(players.last_seen, excluded.last_seen)");
  const upsertMode = db.prepare(`INSERT INTO player_modes(device, mode, matches, wins, best, total) VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(device, mode) DO UPDATE SET matches = matches + 1, wins = wins + excluded.wins, best = MAX(best, excluded.best), total = total + excluded.total`);
  const playerRow = db.prepare("SELECT name FROM players WHERE device = ?");
  const modeRows = db.prepare("SELECT mode, matches, wins, best, total FROM player_modes WHERE device = ?");
  const weekly = db.prepare(`SELECT p.name AS name, p.look AS look, MAX(mp.score) AS best, COUNT(*) AS matches, SUM(mp.won) AS wins
    FROM match_players mp JOIN matches m ON m.id = mp.match_id JOIN players p ON p.device = mp.device
    WHERE m.mode = ? AND m.ended_at >= ? GROUP BY mp.device ORDER BY best DESC, wins DESC, p.name ASC LIMIT ?`);
  const allTime = db.prepare(`SELECT p.name AS name, p.look AS look, pm.best AS best, pm.matches AS matches, pm.wins AS wins
    FROM player_modes pm JOIN players p ON p.device = pm.device WHERE pm.mode = ? ORDER BY best DESC, wins DESC, p.name ASC LIMIT ?`);
  const pruneMatches = db.prepare("DELETE FROM matches WHERE ended_at < ?");
  const prunePlayers = db.prepare("DELETE FROM players WHERE last_seen < ?");
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const board = (rows: unknown[]): LeaderboardEntry[] => (rows as Array<{ name: string; look: number; best: number; matches: number; wins: number }>)
    .map((r, i) => ({ rank: i + 1, name: r.name, look: Number(r.look), best: Number(r.best), matches: Number(r.matches), wins: Number(r.wins ?? 0) }));

  return {
    recordMatch(match) {
      if (!MODES.includes(match.mode)) throw new Error("unknown mode");
      return tx(() => {
        const inserted = Number(insertMatch.run(match.id, match.mode, match.world, match.startedAt, match.endedAt, match.reason).changes) > 0;
        if (!inserted) return false;
        for (const p of match.players) {
          if (!DEVICE.test(p.device)) continue;
          const score = Math.max(0, Math.trunc(p.score));
          // One identity may occupy multiple tabs/seats. The history key is one row per match
          // and identity, so its aggregate must advance only when that row was inserted.
          if (Number(insertPlayer.run(match.id, p.device, p.name, p.look, p.team, score, p.won ? 1 : 0).changes) === 0) continue;
          upsertPlayer.run(p.device, p.name, p.look, match.endedAt);
          upsertMode.run(p.device, match.mode, p.won ? 1 : 0, score, score);
        }
        return true;
      });
    },
    stats(device) {
      if (!DEVICE.test(device)) return null;
      const row = playerRow.get(device) as { name: string } | undefined;
      if (!row) return null;
      const out: PlayerStats = { name: row.name, matches: 0, wins: 0, modes: {} };
      for (const r of modeRows.all(device) as Array<{ mode: NetModeId; matches: number; wins: number; best: number; total: number }>) {
        out.modes[r.mode] = { matches: Number(r.matches), wins: Number(r.wins), best: Number(r.best), total: Number(r.total) };
        out.matches += Number(r.matches); out.wins += Number(r.wins);
      }
      return out;
    },
    leaderboard(mode, period: LeaderboardPeriod, now, limit = 10) {
      const n = Math.max(1, Math.min(50, Math.trunc(limit)));
      return board(period === "week" ? weekly.all(mode, weekStart(now), n) : allTime.all(mode, n));
    },
    prune(now) {
      return tx(() => Number(pruneMatches.run(now - RETENTION.matchMs).changes) + Number(prunePlayers.run(now - RETENTION.playerMs).changes));
    },
    close() { db.close(); },
  };
}
