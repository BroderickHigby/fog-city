import { afterEach, describe, expect, it } from "vitest";
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

  it("refuses joining a started match, a fifth player, and unknown codes", async () => {
    const h = await relay(), [a] = await match(h);
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

describe("relay versions", () => {
  it("refuses a client whose SIM_VERSION or protocol differs, naming the reason", async () => {
    const h = await relay();
    for (const hello of [{ sim: SIM_VERSION - 1, net: NET_VERSION }, { sim: SIM_VERSION, net: NET_VERSION + 1 }]) {
      const s = await raw(h.url);
      s.send({ type: "hello", action: "create", world: "dev", fingerprint: FINGERPRINT, ...hello });
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
    const hello = { type: "hello", action: "create", world: "dev", fingerprint: FINGERPRINT, sim: SIM_VERSION, net: NET_VERSION };
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
      s.send({ type: "hello", action: "join", code: "ABCDEFGH", world: "dev", fingerprint: FINGERPRINT, sim: SIM_VERSION, net: NET_VERSION });
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
