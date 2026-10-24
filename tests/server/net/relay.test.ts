import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashState, SIM_VERSION, type SimState } from "../../../src/sim/index.ts";
import { NET_VERSION } from "../../../src/net/protocol.ts";
import { botSweepView } from "../../../src/sim/modes/botsweep.ts";
import { client, FINGERPRINT, raw, settle, startRelay, until, type Harness, type TestClient } from "./harness.ts";

let harness: Harness | null = null;
const open: TestClient[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) c.client.dispose();
  await harness?.close();
  harness = null;
});
async function relay(opts?: Parameters<typeof startRelay>[0]): Promise<Harness> { harness = await startRelay(opts); return harness; }
function make(h: Harness, overrides?: Parameters<typeof client>[1]): TestClient { const c = client(h, overrides); open.push(c); return c; }
const last = (c: TestClient) => c.infos.at(-1)!;
const room = (h: Harness) => [...h.relay.rooms.values()][0]!;

/** Two players in a started match. */
async function match(h: Harness): Promise<[TestClient, TestClient]> {
  const a = make(h), b = make(h);
  a.client.create();
  await until(() => !!last(a)?.code, "room code");
  b.client.join(last(a).code);
  await until(() => last(a).members.length === 2 && last(b).members.length === 2, "both in lobby");
  a.client.ready(true); b.client.ready(true);
  await until(() => last(a).members.every((m) => m.ready), "ready");
  a.client.start();
  await until(() => !!a.client.match && !!b.client.match, "match snapshots");
  return [a, b];
}
/** Relay ticks with both clients sending and consuming, like two browsers at 60 Hz. */
async function play(h: Harness, players: TestClient[], ticks: number, throttle = 0.6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    for (const p of players) p.client.sample({ throttle, steer: p === players[0] ? 0.2 : -0.2, brake: 0, actions: 0 });
    await settle(1);
    h.tick();
    await settle(1);
    for (const p of players) p.client.advance(1);
  }
  await settle(40);
  for (const p of players) p.client.advance(60);
}

describe("relay lobby", () => {
  it("creates a private room, joins by invite code and gives each seat its own id and generated name", async () => {
    const h = await relay(), a = make(h), b = make(h);
    a.client.create();
    await until(() => !!last(a)?.code);
    expect(last(a).code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    b.client.join(last(a).code);
    await until(() => last(b).members.length === 2);
    expect(last(a).playerId).toBe("p1"); expect(last(b).playerId).toBe("p2");
    expect(last(b).members.map((m) => [m.id, m.host])).toEqual([["p1", true], ["p2", false]]);
    expect(new Set(last(b).members.map((m) => m.name)).size).toBe(2);
    expect(a.seat.value?.token).toMatch(/^[a-f0-9]{32}$/);
    expect(a.seat.value?.token).not.toBe(b.seat.value?.token);
  });

  it("shows each player's vetted profile name and look, numbering a repeated name, and keeps device tokens private", async () => {
    const h = await relay(), a = make(h, { name: ["quiet", "heron"], look: 4 }), b = make(h, { name: ["quiet", "heron"], look: 1 });
    a.client.create(); await until(() => !!last(a)?.code);
    b.client.join(last(a).code); await until(() => last(a).members.length === 2);
    expect(last(a).members.map((m) => [m.name, m.look])).toEqual([["Quiet Heron", 4], ["Quiet Heron 2", 1]]);
    // Members carry no device token or its hash; seats keep only the hash, for stats.
    expect(Object.keys(last(b).members[0]!).sort()).toEqual(["connected", "host", "id", "look", "name", "ready", "spectator"]);
  });

  it("only the host starts, and only when everyone is ready", async () => {
    const h = await relay(), a = make(h), b = make(h);
    a.client.create(); await until(() => !!last(a)?.code);
    b.client.join(last(a).code); await until(() => last(a).members.length === 2);
    b.client.ready(true); await until(() => last(a).members.some((m) => m.ready));
    b.client.start(); await until(() => last(b).message === "Only the host can do that.");
    a.client.start(); await until(() => last(a).message === "Everyone must be ready first.");
    expect(room(h).phase).toBe("lobby");
    a.client.ready(true); await until(() => last(a).members.every((m) => m.ready));
    a.client.start(); await until(() => last(b).phase === "match");
    expect(a.client.match!.matchId).toBe(b.client.match!.matchId);
  });

  it("refuses joining a finished match and unknown codes", async () => {
    const h = await relay(), [a, b] = await match(h);
    a.client.end(); await play(h, [a, b], 3);
    const late = make(h); late.client.join(last(a).code);
    await until(() => last(late)?.status === "error");
    expect(last(late).message).toMatch(/already started/);
    const missing = make(h); missing.client.join("ABCDEFGH");
    await until(() => last(missing)?.status === "error");
    expect(last(missing).message).toMatch(/Room not found/);
  });

  it("cancels: leaving the lobby frees the seat and the last player closes the room", async () => {
    const h = await relay(), a = make(h), b = make(h);
    a.client.create(); await until(() => !!last(a)?.code);
    b.client.join(last(a).code); await until(() => last(a).members.length === 2);
    b.client.leave(); await until(() => last(a).members.length === 1);
    expect(b.seat.value).toBeNull();
    a.client.leave(); await settle(); h.tick();
    expect(h.relay.rooms.size).toBe(0);
  });
});

describe("relay quick play", () => {
  it("puts quick-play players in the fullest open public room, never in a private room", async () => {
    const h = await relay();
    const priv = make(h); priv.client.create(); await until(() => last(priv)?.phase === "lobby");
    const a = make(h), b = make(h), c = make(h);
    a.client.quick(); await until(() => last(a)?.phase === "lobby");
    expect(last(a).visibility).toBe("public");
    expect(last(a).code).not.toBe(last(priv).code);
    b.client.quick(); await until(() => last(b)?.phase === "lobby");
    c.client.quick(); await until(() => last(c)?.phase === "lobby");
    expect(new Set([last(a).code, last(b).code, last(c).code]).size).toBe(1);
    await until(() => last(a).members.length === 3);
    expect(last(priv).members).toHaveLength(1);
  });

  it("lists public rooms with player counts over GET /rooms, with CORS only for allowed origins", async () => {
    const h = await relay();
    const a = make(h); a.client.quick(); await until(() => last(a)?.phase === "lobby");
    const p = make(h); p.client.create(); await until(() => last(p)?.phase === "lobby");
    const { listRooms } = await import("../../../src/net/client.ts");
    const list = (await listRooms(h.url, "dev"))!;
    expect(list.rooms).toEqual([{ code: last(a).code, mode: "botSweep", phase: "lobby", players: 1, bots: 0, max: 4, world: "dev" }]);
    expect(list.online).toBe(2);
    expect((await listRooms(h.url, "sf"))!.rooms).toEqual([]);
    const base = h.url.replace("ws:", "http:").replace("/relay", "");
    expect((await fetch(`${base}/rooms`, { headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/rooms`, { headers: { origin: "http://localhost:5173" } })).headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("lets the host add bot teammates, gives people precedence for seats, and starts with the bots in the match", async () => {
    const h = await relay(), a = make(h), b = make(h);
    a.client.quick(); await until(() => last(a)?.phase === "lobby");
    a.client.setBots(3); await until(() => last(a).bots === 3);
    b.client.quick(); await until(() => last(a).members.length === 2);
    await until(() => last(a).bots === 2);
    b.client.setBots(0); await until(() => last(b).message === "Only the host can do that.");
    a.client.ready(true); b.client.ready(true); await until(() => last(a).members.every((m) => m.ready));
    a.client.start(); await until(() => !!a.client.match && !!b.client.match);
    expect(Object.keys(room(h).state!.players).sort()).toEqual(["bot-1", "bot-2", "p1", "p2"]);
    await play(h, [a, b], 121);
    expect(hashState(a.client.match!.confirmed)).toBe(hashState(room(h).state!));
    expect(room(h).stats.mismatches).toBe(0);
  });

  it("starts a solo practice with one player", async () => {
    const h = await relay(), a = make(h);
    a.client.quick(); await until(() => last(a)?.phase === "lobby");
    a.client.ready(true); await until(() => last(a).members[0]!.ready);
    a.client.start(); await until(() => !!a.client.match);
    expect(Object.keys(room(h).state!.players)).toEqual(["p1"]);
    expect(room(h).open()).toBe(false);
  });
});

describe("relay Clean Streets", () => {
  it("gives a solo Clean Streets player a bot on the opposing team", async () => {
    const h = await relay(), a = make(h);
    a.client.create(); await until(() => last(a)?.phase === "lobby");
    a.client.setMode("cleanStreets"); await until(() => last(a).mode === "cleanStreets");
    expect(last(a).bots).toBe(0);
    a.client.ready(true); await until(() => last(a).members[0]!.ready);
    a.client.start(); await until(() => !!a.client.match);
    const { modeSessionOf } = await import("../../../src/sim/modes/session.ts");
    const match = modeSessionOf(room(h).state!)!.match;
    expect(Object.keys(room(h).state!.players).sort()).toEqual(["bot-1", "p1"]);
    expect([match.players.p1!.team, match.players["bot-1"]!.team]).toEqual([0, 1]);
    expect(last(a).bots).toBe(1);
  });

  it("lets only the host pick the mode and starts a two-team match whose flower lobs agree on every peer", async () => {
    const h = await relay(), a = make(h), b = make(h);
    a.client.create(); await until(() => last(a)?.phase === "lobby");
    b.client.join(last(a).code); await until(() => last(a).members.length === 2);
    b.client.setMode("cleanStreets"); await until(() => last(b).message === "Only the host can do that.");
    a.client.setMode("cleanStreets"); await until(() => last(b).mode === "cleanStreets");
    a.client.ready(true); b.client.ready(true); await until(() => last(a).members.every((m) => m.ready));
    a.client.start(); await until(() => !!a.client.match && !!b.client.match);
    const { modeSessionOf } = await import("../../../src/sim/modes/session.ts");
    const match = modeSessionOf(room(h).state!)!.match;
    expect(match.mode).toBe("cleanStreets");
    expect([match.players.p1!.team, match.players.p2!.team]).toEqual([0, 1]);
    expect(last(a).bots).toBe(0);
    // p1 lobs east at p2 (spawned 4 m east), through the real input path.
    for (let i = 0; i < 3; i++) { a.client.sample({ throttle: 0, steer: 0, brake: 0, actions: 1 << 10, aimYaw: Math.PI / 2 }); b.client.sample({ throttle: 0, steer: 0, brake: 0, actions: 0 }); await settle(1); h.tick(); await settle(1); a.client.advance(1); b.client.advance(1); }
    await play(h, [a, b], 60, 0);
    expect(modeSessionOf(room(h).state!)!.match.players.p1!.score).toBe(25);
    expect(hashState(b.client.match!.confirmed)).toBe(hashState(room(h).state!));
    expect(room(h).stats.mismatches).toBe(0);
  });
});

describe("relay persistence", () => {
  it("records a finished match once and serves the leaderboard (names only) and each device's own stats", async () => {
    const { openSqliteStore } = await import("../../../server/store/sqlite.ts");
    const store = openSqliteStore(":memory:");
    try {
      const h = await relay({ store }), [a, b] = await match(h);
      await play(h, [a, b], 10);
      a.client.end(); await play(h, [a, b], 3);
      expect(room(h).phase).toBe("results");
      const base = h.url.replace("ws:", "http:").replace("/relay", "");
      const board = await (await fetch(`${base}/leaderboard?mode=botSweep&period=week`)).json() as { entries: Array<{ name: string; matches: number }> };
      expect(board.entries.map((e) => e.name).sort()).toEqual(last(a).members.map((m) => m.name).sort());
      expect(JSON.stringify(board)).not.toMatch(/[a-f0-9]{32}/);
      const token = (a.client as unknown as { options: { identity(): { token: string } } }).options.identity().token;
      const me = await (await fetch(`${base}/me`, { headers: { "x-fogcity-device": token } })).json() as { stats: { matches: number } };
      expect(me.stats.matches).toBe(1);
      expect((await fetch(`${base}/me`)).status).toBe(400);
      expect((await fetch(`${base}/leaderboard?mode=nope`)).status).toBe(400);
      // Results stay up; ticking on never records the match again.
      await play(h, [a, b], 5);
      expect(store.stats(createHash("sha256").update(token).digest("hex"))!.matches).toBe(1);
    } finally { store.close(); }
  });

  it("caps leaderboard requests per IP", async () => {
    const { openSqliteStore } = await import("../../../server/store/sqlite.ts");
    const store = openSqliteStore(":memory:");
    try {
      const h = await relay({ store }), base = h.url.replace("ws:", "http:").replace("/relay", "");
      const codes: number[] = [];
      for (let i = 0; i < 32; i++) codes.push((await fetch(`${base}/leaderboard?mode=botSweep`)).status);
      expect(codes.filter((c) => c === 200)).toHaveLength(30);
      expect(codes.at(-1)).toBe(429);
    } finally { store.close(); }
  });
});

describe("relay social", () => {
  it("relays preset quick-chat phrases only, at most one per 1.5 s per player", async () => {
    const h = await relay(), a = make(h), b = make(h);
    const heard: Array<[string, number]> = [];
    (b.client as unknown as { options: { onChat(from: string, phrase: number): void } }).options.onChat = (from, phrase) => heard.push([from, phrase]);
    a.client.create(); await until(() => !!last(a)?.code);
    b.client.join(last(a).code); await until(() => last(a).members.length === 2);
    a.client.quickChat(0); a.client.quickChat(1); await settle(60);
    expect(heard).toEqual([["p1", 0]]);
    h.clock.t += 1500; a.client.quickChat(5); await until(() => heard.length === 2);
    expect(heard[1]).toEqual(["p1", 5]);
    const s = await raw(h.url); s.send({ type: "chat", text: "free text" }); await until(() => !!s.closed);
    expect(s.messages.at(-1)).toMatchObject({ code: "invalid_message" });
  });

  it("lets a player join a running match and adds them to it on every peer", async () => {
    const h = await relay(), [a, b] = await match(h);
    await play(h, [a, b], 20);
    const c = make(h); c.client.join(last(a).code);
    await until(() => !!c.client.match, "join-in-progress snapshot");
    expect(last(c).playerId).toBe("p3");
    await play(h, [a, b, c], 61);
    const { modeSessionOf } = await import("../../../src/sim/modes/session.ts");
    expect(Object.keys(modeSessionOf(room(h).state!)!.match.players)).toEqual(["p1", "p2", "p3"]);
    expect(room(h).state!.players.p3).toBeDefined();
    for (const p of [a, b, c]) expect(hashState(p.client.match!.confirmed)).toBe(hashState(room(h).state!));
    // A fourth fits; a fifth does not.
    const d = make(h); d.client.join(last(a).code); await until(() => !!d.client.match);
    const e = make(h); e.client.join(last(a).code); await until(() => last(e)?.status === "error");
    expect(last(e).message).toMatch(/four players/);
  });

  it("lets spectators watch without a body, input or seat, and rematches back to the lobby", async () => {
    const h = await relay(), [a, b] = await match(h);
    const s = make(h); s.client.spectate(last(a).code);
    await until(() => !!s.client.match, "spectator snapshot");
    expect(last(s).playerId).toBe("s1");
    expect(last(a).members.find((m) => m.id === "s1")).toMatchObject({ spectator: true });
    s.client.sample({ throttle: 1, steer: 0, brake: 0, actions: 2 });
    await play(h, [a, b], 61);
    while (s.client.match!.queued) s.client.advance(60);
    expect(room(h).state!.players.s1).toBeUndefined();
    expect(hashState(s.client.match!.confirmed)).toBe(hashState(room(h).state!));
    expect(room(h).size).toBe(2);
    a.client.end(); await play(h, [a, b], 3);
    await until(() => last(s).results !== null);
    b.client.rematch(); await until(() => last(b).message === "Only the host can do that.");
    a.client.rematch(); await until(() => last(b).phase === "lobby");
    expect(last(a).members.filter((m) => !m.spectator).every((m) => !m.ready)).toBe(true);
    a.client.ready(true); b.client.ready(true); await until(() => last(a).members.filter((m) => !m.spectator).every((m) => m.ready));
    a.client.start(); await until(() => last(a).phase === "match" && a.client.match!.matchId !== last(a).results?.matchId);
    expect(Object.keys(room(h).state!.players).sort()).toEqual(["p1", "p2"]);
  });
});

describe("relay transport seam", () => {
  it("runs the lobby over any transport with WebSocket semantics (here the ws package's client)", async () => {
    const h = await relay();
    const { WebSocket: WsSocket } = await import("ws");
    const { RelayClient } = await import("../../../src/net/client.ts");
    const { WORLD } = await import("./harness.ts");
    const sent: string[] = [];
    const infos: Array<{ phase: string; code: string }> = [];
    const custom = new RelayClient({ url: h.url, identity: () => ({ token: "cd".repeat(16), name: ["salty", "pumice"], look: 2 }), world: WORLD, worldName: "dev", fingerprint: FINGERPRINT, reconnectAttempts: 0, onChange: (i) => infos.push(i), onSeat: () => {},
      transport: (url, handlers) => {
        const ws = new WsSocket(url);
        ws.on("open", () => handlers.onOpen()); ws.on("message", (d) => handlers.onMessage(String(d))); ws.on("close", () => handlers.onClose());
        return { get open() { return ws.readyState === WsSocket.OPEN; }, send: (t) => { sent.push(t); ws.send(t); }, close: () => ws.close() };
      } });
    open.push({ client: custom, infos: [], seat: { value: null }, results: 0 });
    custom.create();
    await until(() => infos.at(-1)?.phase === "lobby");
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: "hello", action: "create" });
    expect(infos.at(-1)!.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    custom.leave();
    await until(() => h.relay.rooms.size === 0 || [...h.relay.rooms.values()].every((r) => r.closed));
  });
});

describe("relay versions", () => {
  it("refuses a client whose SIM_VERSION or protocol differs, naming the reason", async () => {
    const h = await relay();
    for (const hello of [{ sim: SIM_VERSION - 1, net: NET_VERSION }, { sim: SIM_VERSION, net: NET_VERSION + 1 }]) {
      const s = await raw(h.url);
      s.send({ type: "hello", action: "create", world: "dev", fingerprint: FINGERPRINT, profile: { name: ["quiet", "heron"], look: 0 }, device: "ab".repeat(16), ...hello });
      await until(() => !!s.closed);
      expect(s.messages[0]).toMatchObject({ type: "error", code: "version_mismatch" });
    }
    expect(h.relay.rooms.size).toBe(0);
  });
  it("refuses a different world build and a world the relay does not serve", async () => {
    const h = await relay(), wrong = make(h, { fingerprint: "deadbeef" });
    wrong.client.create(); await until(() => last(wrong)?.status === "error");
    expect(last(wrong).message).toMatch(/world differs/);
    const other = make(h, { world: "sf" }); other.client.create(); await until(() => last(other)?.status === "error");
    expect(last(other).message).toMatch(/not available/);
  });
});

describe("relay match", () => {
  it("relays inputs keyed by player id and every client's confirmed state matches the relay's hash exactly", async () => {
    const h = await relay(), [a, b] = await match(h);
    await play(h, [a, b], 130);
    const server = room(h).state!;
    expect(a.client.match!.tick).toBe(server.tick); expect(b.client.match!.tick).toBe(server.tick);
    expect(hashState(a.client.match!.confirmed)).toBe(hashState(server));
    expect(hashState(b.client.match!.confirmed)).toBe(hashState(server));
    // Both bodies moved under their own controls.
    expect(server.players.p1!.car.speed).toBeGreaterThan(0.5); expect(server.players.p2!.car.speed).toBeGreaterThan(0.5);
    // Snapshots only at start: no mismatch, no periodic state broadcast.
    expect(room(h).stats).toMatchObject({ mismatches: 0, snapshots: 2 });
    expect(a.client.match!.stats).toMatchObject({ mismatches: 0, snapshots: 0 });
  });

  it("sends a snapshot only to the client that diverged, exactly once per injected divergence", async () => {
    const h = await relay(), [a, b] = await match(h);
    await play(h, [a, b], 30);
    // Inject one divergence into a's copy (as a determinism bug would).
    const bad = structuredClone(a.client.match!.confirmed) as SimState;
    bad.players.p1!.car.x += 0.25;
    a.client.match!.confirmed = bad;
    await play(h, [a, b], 60);
    await play(h, [a, b], 70);
    expect(room(h).stats.mismatches).toBe(1);
    expect(room(h).stats.snapshots).toBe(3);
    expect(a.client.match!.stats).toMatchObject({ mismatches: 1, snapshots: 1 });
    expect(b.client.match!.stats).toMatchObject({ mismatches: 0, snapshots: 0 });
    expect(hashState(a.client.match!.confirmed)).toBe(hashState(room(h).state!));
  });

  it("keeps a disconnected player's seat and ownership, and rejoins them with a snapshot", async () => {
    const h = await relay(), [a, b] = await match(h);
    await play(h, [a, b], 20);
    const seat = b.seat.value!;
    b.client.dispose(); await settle();
    expect(last(a).members.find((m) => m.id === "p2")?.connected).toBe(false);
    await play(h, [a], 30);
    expect(room(h).state!.players.p2).toBeDefined();
    const again = make(h); again.client.rejoin(seat);
    await until(() => !!again.client.match, "rejoin snapshot");
    expect(last(again).playerId).toBe("p2");
    await play(h, [a, again], 61);
    expect(hashState(again.client.match!.confirmed)).toBe(hashState(room(h).state!));
    expect(room(h).stats.mismatches).toBe(0);
    // The rejoined seat drives its own body.
    expect(room(h).state!.players.p2!.car.speed).toBeGreaterThan(0.2);
  });

  it("gives up a seat whose player does not return within the grace period, recorded as a leave event", async () => {
    const h = await relay({ room: { rejoinGraceMs: 1000 } }), [a, b] = await match(h);
    b.client.dispose(); await settle();
    await play(h, [a], 70);
    expect(room(h).state!.players.p2).toBeUndefined();
    expect(last(a).members.map((m) => m.id)).toEqual(["p1"]);
    const rejoin = make(h); rejoin.client.rejoin(b.seat.value ?? { url: h.url, world: "dev", code: last(a).code, token: "0".repeat(32), playerId: "p2" });
    await until(() => last(rejoin)?.status === "error");
  });

  it("ends on the host's decision and pays every player once, keeping payouts on the settled session", async () => {
    const h = await relay(), [a, b] = await match(h);
    await play(h, [a, b], 20);
    b.client.end(); await settle(); h.tick(); await settle();
    expect(room(h).phase).toBe("match");
    a.client.end(); await play(h, [a, b], 3);
    expect(room(h).phase).toBe("results");
    await until(() => a.results === 1 && b.results === 1, "results");
    const results = last(a).results!;
    expect(results.result.reason).toBe("ended");
    expect(results.payouts.map((p) => p.id)).toEqual([`${results.matchId}:p1`, `${results.matchId}:p2`]);
    // Payouts persist on the session after the settlement tick (they are not a one-tick blip).
    expect(botSweepView(room(h).state!)!.payouts).toHaveLength(2);
    // A reload rejoins into results and is told again; the settlement id makes paying idempotent.
    const again = make(h); again.client.rejoin(a.seat.value!);
    await until(() => again.results === 1);
    expect(last(again).results!.payouts).toEqual(results.payouts);
  });

  it("finishes on the clock and records leaves by player id", async () => {
    const h = await relay({ room: { matchTicks: 90 } }), [a, b] = await match(h);
    await play(h, [a, b], 10);
    b.client.leave(); await settle(); await play(h, [a], 2);
    expect(room(h).state!.players.p2).toBeUndefined();
    await play(h, [a], 85);
    expect(room(h).phase).toBe("results");
    expect(botSweepView(room(h).state!)!.result!.reason).toBe("relay-update");
  });

  it("disconnects a match player who stops sending input, keeping the seat", async () => {
    const h = await relay({ room: { matchIdleMs: 500 } }), [a, b] = await match(h);
    await play(h, [a], 40);
    expect(last(b).status).toBe("error");
    expect(last(b).message).toMatch(/inactivity/);
    expect(last(a).members.find((m) => m.id === "p2")).toMatchObject({ connected: false });
  });
});

describe("relay abuse limits", () => {
  it("caps sockets per IP", async () => {
    const h = await relay({ limits: { maxConnectionsPerIp: 3 } });
    const kept = [await raw(h.url), await raw(h.url), await raw(h.url)];
    await expect(raw(h.url)).rejects.toThrow("refused 429");
    kept[0]!.ws.close(); await until(() => !!kept[0]!.closed); await settle();
    await expect(raw(h.url)).resolves.toBeTruthy();
  });

  it("caps rooms per IP and rooms per relay", async () => {
    const h = await relay({ limits: { maxRoomsPerIp: 2, maxRooms: 3 } });
    const hello = { type: "hello", action: "create", world: "dev", fingerprint: FINGERPRINT, sim: SIM_VERSION, net: NET_VERSION, profile: { name: ["quiet", "heron"], look: 0 }, device: "ab".repeat(16) };
    const sockets = [await raw(h.url), await raw(h.url), await raw(h.url)];
    for (const s of sockets) s.send(hello);
    await until(() => !!sockets[2]!.closed);
    expect(sockets[2]!.messages.at(-1)).toMatchObject({ code: "too_many_rooms" });
    expect(h.relay.rooms.size).toBe(2);
    // A second address is still capped by the relay-wide limit (headers trusted only when configured).
    await h.close();
    harness = await startRelay({ limits: { maxRooms: 1 } });
    const one = await raw(harness.url), two = await raw(harness.url);
    one.send(hello); await until(() => one.messages.length > 0);
    two.send(hello); await until(() => !!two.closed);
    expect(two.messages.at(-1)).toMatchObject({ code: "server_full" });
  });

  it("rate-limits message floods per socket", async () => {
    const h = await relay({ limits: { maxMessagesPerSecond: 20 } }), s = await raw(h.url);
    for (let i = 0; i < 40; i++) s.send({ type: "ping", t: i });
    await until(() => !!s.closed);
    expect(s.messages.at(-1)).toMatchObject({ code: "rate_limit" });
    expect(h.relay.counters.rateLimited).toBe(1);
  });

  it("closes oversized, binary and malformed messages, and messages that try to set a player id or state", async () => {
    const h = await relay();
    const big = await raw(h.url); big.send("x".repeat(5000)); await until(() => !!big.closed);
    expect(big.closed!.code).toBe(1009);
    for (const bad of ["not json", JSON.stringify({ type: "input", seq: 1, input: { throttle: 0, steer: 0, brake: 0, actions: 0 }, playerId: "p1" }),
      JSON.stringify({ type: "snapshot", state: {} }), JSON.stringify({ type: "hello", action: "create", world: "../etc", fingerprint: FINGERPRINT, sim: SIM_VERSION, net: NET_VERSION })]) {
      const s = await raw(h.url); s.send(bad); await until(() => !!s.closed);
      expect(s.messages.at(-1)).toMatchObject({ code: "invalid_message" });
    }
    const bin = await raw(h.url); bin.ws.send(Buffer.from([1, 2, 3])); await until(() => !!bin.closed);
    expect(bin.messages.at(-1)).toMatchObject({ code: "invalid_message" });
  });

  it("limits invite-code guessing per IP", async () => {
    const h = await relay({ limits: { maxFailedJoinsPerIpPerMinute: 3 } });
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await raw(h.url);
      s.send({ type: "hello", action: "join", code: "ABCDEFGH", world: "dev", fingerprint: FINGERPRINT, sim: SIM_VERSION, net: NET_VERSION, profile: { name: ["quiet", "heron"], look: 0 }, device: "ab".repeat(16) });
      await until(() => !!s.closed);
      codes.push(String(s.messages.at(-1)?.code));
    }
    expect(codes).toEqual(["room_missing", "room_missing", "room_missing", "rate_limit"]);
  });

  it("refuses foreign browser origins and the wrong path, and allows configured origins", async () => {
    const h = await relay();
    await expect(raw(h.url, { origin: "https://evil.example" })).rejects.toThrow("refused 403");
    await expect(raw(h.url.replace("/relay", "/other"))).rejects.toThrow("refused 403");
    await expect(raw(h.url, { origin: "http://localhost:5173" })).resolves.toBeTruthy();
    await h.close();
    harness = await startRelay();
    const configured = await (async () => {
      const { createRelay } = await import("../../../server/net/server.ts");
      const r = createRelay({ worlds: new Map(), arenas: new Map(), automaticTicks: false, allowedOrigins: ["https://play.example"] });
      const port = await r.listen(0);
      try { return await raw(`ws://127.0.0.1:${port}/relay`, { origin: "https://play.example" }).then(() => true, () => false); } finally { await r.close(); }
    })();
    expect(configured).toBe(true);
  });
});
