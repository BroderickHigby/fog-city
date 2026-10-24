import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayClient } from "../../src/net/client.ts";
import { NET_VERSION, type ClientMessage, type ServerMessage } from "../../src/net/protocol.ts";
import type { RelayTransport, TransportHandlers } from "../../src/net/transport.ts";
import { Action, SIM_VERSION, buildWorld, hashState, NEUTRAL_INPUT } from "../../src/sim/index.ts";
import { createBotSweep } from "../../src/sim/modes/botsweep.ts";

const world = buildWorld([], null, null, {
  version: 1, world: "fixture", sourceSnapshot: "test", anchors: [], tiles: [], territories: [],
  refills: [{ id: "water", kind: "hydrant", x: 0, y: 0, z: 10, radius: 3, salt: false }],
});
const state = createBotSweep(world, { id: "match-1", seed: 3, players: ["p1"], spawn: { x: 0, z: 0, heading: 0 } });
const welcome: ServerMessage = { type: "welcome", net: NET_VERSION, sim: SIM_VERSION, code: "ABCDEFGH", playerId: "p1", token: "a".repeat(32), expiresAt: 1_000_000 };
const room: ServerMessage = { type: "room", phase: "match", mode: "botSweep", members: [{ id: "p1", name: "Misty Otter", look: 0, ready: true, connected: true, host: true }], matchId: "match-1", visibility: "private", bots: 0 };
const snapshot = (reason: "start" | "rejoin" | "mismatch" | "behind", ack: number): ServerMessage =>
  ({ type: "snapshot", matchId: "match-1", reason, state, hash: hashState(state), ack });

interface Connection { handlers: TransportHandlers; transport: RelayTransport; sent: ClientMessage[]; open(): void; drop(): void; receive(message: ServerMessage): void }
const clients: RelayClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); });

function harness(): { client: RelayClient; connections: Connection[] } {
  const connections: Connection[] = [];
  const client = new RelayClient({ url: "ws://localhost/relay", identity: () => ({ token: "cd".repeat(16), name: ["salty", "pumice"], look: 2 }), world, worldName: "dev", fingerprint: "abcd1234", onChange: () => {}, onSeat: () => {},
    transport: (_url, handlers) => {
      let open = false;
      const sent: ClientMessage[] = [];
      const transport: RelayTransport = { get open() { return open; }, send: text => sent.push(JSON.parse(text) as ClientMessage), close: () => { if (open) { open = false; handlers.onClose(); } } };
      connections.push({ handlers, transport, sent, open: () => { open = true; handlers.onOpen(); }, drop: () => { open = false; handlers.onClose(); }, receive: message => handlers.onMessage(JSON.stringify(message)) });
      return transport;
    },
  });
  clients.push(client);
  client.create();
  const connection = connections[0]!;
  connection.open(); connection.receive(welcome); connection.receive(room); connection.receive(snapshot("start", 0));
  return { client, connections };
}

const inputs = (connection: Connection) => connection.sent.filter((message): message is Extract<ClientMessage, { type: "input" }> => message.type === "input");

describe("relay client connection input ownership", () => {
  it("retains the displayed match but waits for the rejoin snapshot before sending inputs on a new connection", async () => {
    vi.useFakeTimers();
    const { client, connections } = harness();
    client.sample({ ...NEUTRAL_INPUT }); client.sample({ ...NEUTRAL_INPUT });
    expect(inputs(connections[0]!).map(input => input.seq)).toEqual([1, 2]);
    const displayed = client.match;
    connections[0]!.drop();
    await vi.advanceTimersByTimeAsync(500);
    const rejoined = connections[1]!;
    rejoined.open();
    expect(rejoined.sent[0]).toMatchObject({ type: "hello", action: "rejoin" });
    client.sample({ ...NEUTRAL_INPUT, actions: Action.fire });
    expect(client.match).toBe(displayed);
    expect(inputs(rejoined), "no old sequence before welcome").toEqual([]);
    rejoined.receive(welcome);
    client.sample({ ...NEUTRAL_INPUT, actions: Action.enterExit });
    expect(inputs(rejoined), "welcome does not yet establish the new input sequence").toEqual([]);
    // The relay discarded the old socket's unconsumed controls and resets its next sequence
    // to ack + 1 on rejoin. Lost-connection one-shot actions must not leak into this input.
    rejoined.receive(snapshot("rejoin", 0)); rejoined.receive(room);
    client.sample({ ...NEUTRAL_INPUT });
    expect(inputs(rejoined)).toEqual([{ type: "input", seq: 1, input: { ...NEUTRAL_INPUT } }]);
  });

  it("keeps sending the ordered input sequence across snapshots on the same connection", () => {
    const { client, connections } = harness();
    const connection = connections[0]!;
    client.sample({ ...NEUTRAL_INPUT }); client.sample({ ...NEUTRAL_INPUT });
    connection.receive(snapshot("mismatch", 0));
    client.sample({ ...NEUTRAL_INPUT });
    connection.receive(snapshot("behind", 1));
    client.sample({ ...NEUTRAL_INPUT });
    expect(inputs(connection).map(input => input.seq)).toEqual([1, 2, 3, 4]);
    expect(client.match!.stats.snapshots).toBe(2);
  });
});
