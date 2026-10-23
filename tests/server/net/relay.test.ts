import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelay } from "../../../server/net/server.ts";
import { worldLoader, type WorldBundle } from "../../../server/net/world.ts";
import { NET_VERSION, ROOM_LIFETIME_MS, type ServerMessage } from "../../../src/net/protocol.ts";
import { SIM_VERSION, type SimState } from "../../../src/sim/index.ts";
import { ROOT } from "../../helpers.ts";

type Relay = ReturnType<typeof createRelay>;
let bundle: WorldBundle;
const running: Relay[] = [];
beforeAll(async () => { bundle = await worldLoader(`${ROOT}/public`)("dev"); });
afterEach(async () => { for (const relay of running.splice(0)) await relay.close(); });
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
async function until<T>(read: () => T | undefined): Promise<T> {
  for (let n = 0; n < 300; n++) { const result = read(); if (result !== undefined) return result; await sleep(5); }
  throw new Error("network result timed out");
}
async function start(extra: Partial<Parameters<typeof createRelay>[0]> = {}): Promise<{ relay: Relay; url: string; port: number }> {
  const relay = createRelay({ loadWorld: async () => bundle, automaticTicks: false, ...extra });
  running.push(relay);
  const port = await relay.listen(0);
  return { relay, url: `ws://127.0.0.1:${port}/relay`, port };
}
async function peer(url: string, message: unknown) {
  const socket = new WebSocket(url, { origin: "http://127.0.0.1:5173" });
  const inbox: ServerMessage[] = [];
  let closeCode: number | undefined;
  socket.on("message", (data) => inbox.push(JSON.parse(data.toString()) as ServerMessage));
  socket.on("close", (code) => { closeCode = code; });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(typeof message === "string" ? message : JSON.stringify(message));
  return { socket, inbox, closed: () => closeCode, wait: (type: ServerMessage["type"]) => until(() => inbox.find((m) => m.type === type)) };
}
const hello = (code?: string) => ({ type: code ? "join" : "create", version: NET_VERSION, simVersion: SIM_VERSION, world: "dev", fingerprint: bundle.fingerprint, ...(code ? { code } : {}) });

describe("real WebSocket private relay", () => {
  it("serves health, joins two players, broadcasts authoritative movement, and records leave/rejoin", async () => {
    const { relay, url, port } = await start();
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({ ok: true });
    const a = await peer(url, hello());
    const wa = await a.wait("welcome");
    if (wa.type !== "welcome") throw new Error("missing welcome");
    const b = await peer(url, hello(wa.code));
    const wb = await b.wait("welcome");
    if (wb.type !== "welcome") throw new Error("missing welcome");
    const room = relay.rooms.get(wa.code)!;
    relay.tick();
    const z = room.state.players[wa.playerId]!.car.z;
    for (let seq = 1; seq <= 30; seq++) {
      a.socket.send(JSON.stringify({ type: "input", seq, input: { throttle: 1, steer: 0, brake: 0, actions: 0 } }));
      await until(() => room.members.get(wa.playerId)!.seq === seq ? true : undefined);
      relay.tick();
    }
    await until(() => b.inbox.some((m) => m.type === "frame" && m.tick === room.state.tick) ? true : undefined);
    expect(room.state.players[wa.playerId]!.car.z).toBeLessThan(z - 0.5);
    expect(Object.keys(room.state.players)).toHaveLength(2);
    b.socket.close();
    await until(() => room.members.size === 1 ? true : undefined);
    relay.tick();
    expect(room.state.players[wb.playerId]).toBeUndefined();
    expect(room.history.flatMap((f) => f.events).some((e) => e.kind === "player.leave" && e.playerId === wb.playerId)).toBe(true);
    const again = await peer(url, hello(wa.code));
    const joined = await again.wait("welcome");
    expect(joined.type === "welcome" && joined.playerId !== wb.playerId).toBe(true);
    relay.tick();
    // No held throttle survives an input gap or a disconnect.
    expect(room.history.at(-1)!.inputs[wa.playerId]!.throttle).toBe(0);
  });
  it("refuses a fifth player and expired room codes", async () => {
    let now = 0;
    const { url } = await start({ now: () => now });
    const first = await peer(url, hello()); const welcome = await first.wait("welcome");
    if (welcome.type !== "welcome") throw new Error("missing welcome");
    for (let i = 0; i < 3; i++) await (await peer(url, hello(welcome.code))).wait("welcome");
    expect(await (await peer(url, hello(welcome.code))).wait("error")).toMatchObject({ code: "room_full" });
    now = ROOM_LIFETIME_MS;
    expect(await (await peer(url, hello(welcome.code))).wait("error")).toMatchObject({ code: "room_expired" });
  });
  it("rejects a different world fingerprint and enforces the room limit", async () => {
    const { url } = await start({ maxRooms: 1 });
    expect(await (await peer(url, { ...hello(), fingerprint: "0".repeat(64) })).wait("error")).toMatchObject({ code: "world_mismatch" });
    await (await peer(url, hello())).wait("welcome");
    expect(await (await peer(url, hello())).wait("error")).toMatchObject({ code: "server_full" });
  });
  it("does not expose server filesystem details when a world cannot load", async () => {
    const { url } = await start({ loadWorld: async () => { throw new Error("ENOENT /private/server/data"); } });
    const result = await (await peer(url, hello())).wait("error");
    expect(result).toMatchObject({ code: "world_unavailable" });
    expect(JSON.stringify(result)).not.toContain("/private");
  });
  it.each([
    { type: "chat", text: "hello" }, { ...hello, name: "free text" },
    { type: "input", seq: 1, playerId: "p2", input: { throttle: 1, steer: 0, brake: 0, actions: 0 } },
    { type: "state", state: {} as SimState }, "{bad json",
  ])("rejects unauthorized messages without joining or mutating the room: %j", async (message) => {
    const { relay, url } = await start();
    const p = await peer(url, message);
    expect(await p.wait("error")).toMatchObject({ code: "invalid_message" });
    expect(relay.rooms.size).toBe(0);
  });
  it("closes oversized messages and flooding sockets", async () => {
    const { url } = await start();
    const large = await peer(url, "x".repeat(5000));
    expect(await until(large.closed)).toBe(1009);
    const flood = await peer(url, hello()); await flood.wait("welcome");
    for (let i = 0; i < 130; i++) flood.socket.send('{"type":"resync"}');
    expect(await flood.wait("error")).toMatchObject({ code: "rate_limit" });
    expect(await until(flood.closed)).toBe(1008);
  });
  it("rejects stale/duplicate input sequence numbers", async () => {
    const { url } = await start();
    const p = await peer(url, hello()); await p.wait("welcome");
    const message = JSON.stringify({ type: "input", seq: 1, input: { throttle: 1, steer: 0, brake: 0, actions: 0 } });
    p.socket.send(message); p.socket.send(message);
    expect(await p.wait("error")).toMatchObject({ code: "input_sequence" });
  });
  it("refuses an unapproved browser Origin at the upgrade boundary", async () => {
    const { url } = await start();
    const socket = new WebSocket(url, { origin: "https://unapproved.example" });
    const status = await new Promise<number | undefined>((resolve) => {
      socket.on("unexpected-response", (_, res) => { res.resume(); resolve(res.statusCode); socket.terminate(); });
      socket.on("error", () => {});
    });
    expect(status).toBe(403);
  });
});
