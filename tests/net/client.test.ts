import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayClient } from "../../src/net/client.ts";
import { Room } from "../../server/net/room.ts";
import { worldLoader } from "../../server/net/world.ts";
import { ROOT } from "../helpers.ts";

afterEach(() => vi.unstubAllGlobals());
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static latest: FakeSocket;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  constructor(_url: string) { super(); FakeSocket.latest = this; }
  send(text: string): void { this.sent.push(text); }
  close(): void { this.closed = true; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

describe("client control handoff", () => {
  it("disconnects explicitly before allocating an unsendable input sequence", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const bundle = await worldLoader(`${ROOT}/public`)("dev");
    let disconnected = 0;
    const client = new RelayClient(bundle.world, "dev", bundle.fingerprint, {
      onState() {}, onStatus() {}, onDisconnect() { disconnected++; },
    });
    client.connect("ws://localhost/relay");
    const socket = FakeSocket.latest;
    const room = new Room("ABCDEFGHIJ", bundle, 0, 1);
    room.join({ close() {}, send(message) { socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); } }, 0);
    room.tick(0);
    socket.bufferedAmount = 32_768;
    client.sample({ throttle: 1, steer: 0, brake: 0, actions: 0 });
    expect(socket.closed).toBe(true);
    expect(disconnected).toBe(1);
    expect(client.prediction.pending).toHaveLength(0);
    expect(socket.sent.some((m) => JSON.parse(m).type === "input")).toBe(false);
    expect(client.info.message).toContain("fell behind");
  });

});
