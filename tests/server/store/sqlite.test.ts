import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteStore } from "../../../server/store/sqlite.ts";
import { RETENTION, weekStart, type MatchRecord, type RelayStore } from "../../../server/store/store.ts";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const MON = Date.UTC(2026, 9, 19); // Monday 19 October 2026
const match = (id: string, endedAt: number, players: MatchRecord["players"], mode: MatchRecord["mode"] = "botSweep"): MatchRecord =>
  ({ id, mode, world: "sf", startedAt: endedAt - 60_000, endedAt, reason: "time", players });
const p = (device: string, name: string, score: number, won = false, look = 0, team = 0) => ({ device, name, look, team, score, won });

let store: RelayStore | null = null;
afterEach(() => { store?.close(); store = null; });

describe("relay store (SQLite)", () => {
  it("records each match once and aggregates per-identity stats per mode", () => {
    store = openSqliteStore(":memory:");
    expect(store.recordMatch(match("m1", MON + 1000, [p(A, "Quiet Heron", 300, true), p(B, "Salty Pumice", 100)]))).toBe(true);
    expect(store.recordMatch(match("m1", MON + 1000, [p(A, "Quiet Heron", 300, true)]))).toBe(false);
    store.recordMatch(match("m2", MON + 2000, [p(A, "Quiet Heron", 500, false)]));
    store.recordMatch(match("m3", MON + 3000, [p(A, "Quiet Heron", 50, true, 0, 1)], "cleanStreets"));
    expect(store.stats(A)).toEqual({ name: "Quiet Heron", matches: 3, wins: 2, modes: {
      botSweep: { matches: 2, wins: 1, best: 500, total: 800 }, cleanStreets: { matches: 1, wins: 1, best: 50, total: 50 } } });
    expect(store.stats(C)).toBeNull();
    expect(store.stats("not-a-hash")).toBeNull();
  });

  it("counts a shared device once when multiple seats finish the same match", () => {
    store = openSqliteStore(":memory:");
    store.recordMatch(match("multi-tab", MON + 1000, [p(A, "Quiet Heron", 10, true), p(A, "Quiet Heron 2", 20, true)]));
    expect(store.stats(A)).toEqual({ name: "Quiet Heron", matches: 1, wins: 1, modes: {
      botSweep: { matches: 1, wins: 1, best: 10, total: 10 } } });
    expect(store.leaderboard("botSweep", "week", MON + 2000)).toEqual(store.leaderboard("botSweep", "all", MON + 2000));
  });

  it("ranks the week and all time by best score, shows names only, and resets weekly on Monday UTC", () => {
    store = openSqliteStore(":memory:");
    store.recordMatch(match("old", MON - 1000, [p(B, "Salty Pumice", 900, true, 3)]));
    store.recordMatch(match("new", MON + 1000, [p(A, "Quiet Heron", 400, true, 5), p(C, "Dreamy Tern", 200)]));
    const week = store.leaderboard("botSweep", "week", MON + 5000);
    expect(week).toEqual([{ rank: 1, name: "Quiet Heron", look: 5, best: 400, matches: 1, wins: 1 }, { rank: 2, name: "Dreamy Tern", look: 0, best: 200, matches: 1, wins: 0 }]);
    expect(store.leaderboard("botSweep", "all", MON + 5000).map((r) => [r.name, r.best])).toEqual([["Salty Pumice", 900], ["Quiet Heron", 400], ["Dreamy Tern", 200]]);
    expect(JSON.stringify(store.leaderboard("botSweep", "all", MON))).not.toContain("aaaa");
    expect(store.leaderboard("cleanStreets", "all", MON)).toEqual([]);
    expect(weekStart(Date.UTC(2026, 9, 25, 23))).toBe(MON);
    expect(weekStart(MON)).toBe(MON);
  });

  it("forgets match history after 90 days and inactive players after a year", () => {
    store = openSqliteStore(":memory:");
    store.recordMatch(match("m1", MON, [p(A, "Quiet Heron", 100), p(B, "Salty Pumice", 50)]));
    store.recordMatch(match("m2", MON + RETENTION.matchMs, [p(A, "Quiet Heron", 70)]));
    expect(store.prune(MON + RETENTION.matchMs + 1)).toBe(1);
    expect(store.leaderboard("botSweep", "week", MON + RETENTION.matchMs + 1).map((r) => r.name)).toEqual(["Quiet Heron"]);
    expect(store.stats(B)).not.toBeNull();
    store.prune(MON + RETENTION.playerMs + 1);
    expect(store.stats(B)).toBeNull();
    expect(store.stats(A)).not.toBeNull();
  });

  it("keeps everything in a file across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "fog-store-"));
    try {
      const path = join(dir, "relay.sqlite");
      let s = openSqliteStore(path);
      s.recordMatch(match("m1", MON, [p(A, "Quiet Heron", 100, true)]));
      s.close();
      s = openSqliteStore(path);
      expect(s.stats(A)?.matches).toBe(1);
      expect(s.recordMatch(match("m1", MON, [p(A, "Quiet Heron", 100, true)]))).toBe(false);
      s.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
