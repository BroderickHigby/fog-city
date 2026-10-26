// Loopback relay harness: a real ws server on 127.0.0.1 with a hand-made arena world, driven tick
// by tick, and real RelayClients (Node's global WebSocket) as the browsers. No network beyond
// loopback.
import { buildWorld, type World } from "../../../src/sim/world.ts";
import { createRelay, type RelayLimits, type Relay } from "../../../server/net/server.ts";
import type { RoomLimits } from "../../../server/net/room.ts";
import type { WorldBundle } from "../../../server/net/world.ts";
import { RelayClient, type ClientInfo, type Seat } from "../../../src/net/client.ts";
import type { WorldName } from "../../../src/net/protocol.ts";
import { WebSocket as WsSocket } from "ws";

export const FINGERPRINT = "f1e7a3e0";
export function fixtureWorld(): World {
  return buildWorld([], null, null, { version: 1, world: "fixture", sourceSnapshot: "test", refills: [{ id: "water", kind: "hydrant", x: 0, y: 0, z: 10, radius: 3, salt: false }], anchors: [], tiles: [], territories: [] });
}
export const WORLD = fixtureWorld();
export const ARENA = { x: 0, z: 0, heading: 0 };

export interface Harness { relay: Relay; url: string; clock: { t: number }; close(): Promise<void>; tick(n?: number): void }

export async function startRelay(opts: { limits?: Partial<RelayLimits>; room?: Partial<RoomLimits>; world?: WorldName; store?: import("../../../server/store/store.ts").RelayStore; logger?: import("../../../server/ops/log.ts").Logger; metricsToken?: string } = {}): Promise<Harness> {
  const clock = { t: 1_000_000 };
  const bundle = { name: opts.world ?? "dev", fingerprint: FINGERPRINT, world: WORLD, files: null as never } as WorldBundle;
  const relay = createRelay({ worlds: new Map([[bundle.name, bundle]]), arenas: new Map([[bundle.name, [ARENA]]]), automaticTicks: false, now: () => clock.t, limits: opts.limits, room: opts.room, ...(opts.store ? { store: opts.store } : {}), ...(opts.logger ? { logger: opts.logger } : {}), ...(opts.metricsToken ? { metricsToken: opts.metricsToken } : {}) });
  const port = await relay.listen(0);
  return { relay, clock, url: `ws://127.0.0.1:${port}/relay`, close: () => relay.close(), tick: (n = 1) => { for (let i = 0; i < n; i++) { clock.t += 1000 / 60; relay.tick(); } } };
}

let counter = 1;
const NAMES: Array<[string, string]> = [["quiet", "heron"], ["salty", "pumice"], ["dreamy", "tern"], ["hyped", "crane"]];
export interface TestClient { client: RelayClient; infos: ClientInfo[]; seat: { value: Seat | null }; results: number }
export function client(h: Harness, overrides: { fingerprint?: string; world?: WorldName; name?: [string, string]; look?: number } = {}): TestClient {
  const out: TestClient = { client: null as unknown as RelayClient, infos: [], seat: { value: null }, results: 0 };
  const identity = { token: (counter++).toString(16).padStart(32, "0"), name: overrides.name ?? NAMES[counter % NAMES.length]!, look: overrides.look ?? counter % 6 };
  out.client = new RelayClient({ url: h.url, identity: () => identity, world: WORLD, worldName: overrides.world ?? "dev", fingerprint: overrides.fingerprint ?? FINGERPRINT, reconnectAttempts: 0,
    onChange: (info) => out.infos.push(info), onSeat: (seat) => { out.seat.value = seat; }, onResults: () => { out.results++; }, now: () => h.clock.t });
  return out;
}

export async function until(check: () => boolean, label = "condition", ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
/** Let in-flight socket messages land. */
export const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A raw socket for abuse tests: records server messages and the close code/reason. */
export interface RawSocket { ws: WsSocket; messages: Array<Record<string, unknown>>; closed: { code: number; reason: string } | null; send(value: unknown): void }
export function raw(url: string, headers: Record<string, string> = {}): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WsSocket(url, { headers });
    const out: RawSocket = { ws, messages: [], closed: null, send: (value) => ws.send(typeof value === "string" ? value : JSON.stringify(value)) };
    ws.on("message", (data) => out.messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    ws.on("close", (code, reason) => { out.closed = { code, reason: reason.toString() }; });
    ws.on("open", () => resolve(out));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    ws.on("error", (error) => reject(error));
  });
}
