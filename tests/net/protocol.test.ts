import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, NET_VERSION, parseClientMessage } from "../../src/net/protocol.ts";
import { normalizeRelayUrl, relayUrl } from "../../src/net/config.ts";
import { worldFingerprint } from "../../src/net/world-id.ts";
import { SIM_VERSION } from "../../src/sim/index.ts";
import { loadWorldFiles } from "../helpers.ts";

const hello = { type: "hello", net: NET_VERSION, sim: SIM_VERSION, world: "sf", fingerprint: "b703eecb", action: "create" };
const parse = (v: unknown) => parseClientMessage(JSON.stringify(v));

describe("relay protocol", () => {
  it("accepts the closed message shapes", () => {
    expect(parse(hello)).toEqual(hello);
    expect(parse({ ...hello, action: "join", code: "ABCDEFGH" })).toMatchObject({ action: "join" });
    expect(parse({ ...hello, action: "rejoin", code: "ABCDEFGH", token: "a".repeat(32) })).toMatchObject({ action: "rejoin" });
    expect(parse({ type: "input", seq: 1, input: { throttle: 1, steer: -1, brake: 0, actions: 3, aimYaw: 1.5 } })).toMatchObject({ seq: 1 });
    expect(parse({ type: "ready", ready: true })).toEqual({ type: "ready", ready: true });
    expect(parse({ ...hello, action: "quick" })).toMatchObject({ action: "quick" });
    expect(parse({ type: "bots", count: 3 })).toEqual({ type: "bots", count: 3 });
    expect(parse({ type: "mode", mode: "cleanStreets" })).toEqual({ type: "mode", mode: "cleanStreets" });
    expect(parse({ type: "start", mode: "botSweep" })).toEqual({ type: "start", mode: "botSweep" });
    expect(parse({ type: "resync", tick: 60, reason: "mismatch" })).toEqual({ type: "resync", tick: 60, reason: "mismatch" });
  });
  it("names a version mismatch, and rejects everything else as invalid", () => {
    expect(() => parse({ ...hello, sim: SIM_VERSION + 1 })).toThrow("version_mismatch");
    expect(() => parse({ ...hello, net: 1 })).toThrow("version_mismatch");
    for (const bad of [
      { ...hello, world: "nyc" }, { ...hello, action: "join", code: "abcdefgh" }, { ...hello, action: "join", code: "ABCDEFG0" }, { ...hello, extra: 1 },
      { ...hello, action: "rejoin", code: "ABCDEFGH", token: "x" }, { type: "input", seq: 0, input: { throttle: 0, steer: 0, brake: 0, actions: 0 } },
      { type: "input", seq: 1, input: { throttle: 2, steer: 0, brake: 0, actions: 0 } }, { type: "input", seq: 1, input: { throttle: 0, steer: 0, brake: 0, actions: 1 << 20 } },
      { type: "input", seq: 1, input: { throttle: 0, steer: 0, brake: 0, actions: 0, x: 5 } }, { type: "input", seq: 1, playerId: "p2", input: { throttle: 0, steer: 0, brake: 0, actions: 0 } },
      { type: "start", mode: "fogRoyale" }, { type: "mode", mode: "hideInTheCrowd" }, { type: "bots", count: 4 }, { type: "bots", count: -1 }, { ...hello, action: "quick", code: "ABCDEFGH" }, { type: "chat", text: "hi" }, { type: "snapshot", state: {} }, { type: "resync", tick: 1 }, [], null,
    ]) expect(() => parse(bad), JSON.stringify(bad)).toThrow("invalid_message");
    expect(() => parseClientMessage("{")).toThrow("invalid_message");
    expect(() => parseClientMessage(" ".repeat(MAX_MESSAGE_BYTES + 1))).toThrow("invalid_message");
  });
});

describe("relay configuration", () => {
  it("uses only secure remote relays and loopback page overrides", () => {
    expect(normalizeRelayUrl("wss://relay.example.com", true)).toBe("wss://relay.example.com/relay");
    expect(normalizeRelayUrl("wss://relay.example.com/custom", true)).toBe("wss://relay.example.com/custom");
    expect(normalizeRelayUrl("ws://relay.example.com/relay", true)).toBeNull();
    expect(normalizeRelayUrl("https://relay.example.com", true)).toBeNull();
    expect(normalizeRelayUrl("ws://127.0.0.1:8787/relay", false)).toBe("ws://127.0.0.1:8787/relay");
    expect(normalizeRelayUrl("wss://evil.example/relay", false)).toBeNull();
    expect(relayUrl("?relay=wss%3A%2F%2Fevil.example%2Frelay")).toBeNull();
    expect(relayUrl("?relay=ws%3A%2F%2Flocalhost%3A9000")).toBe("ws://localhost:9000/relay");
    expect(relayUrl("")).toBeNull();
  });
  it("fingerprints the simulation inputs of a world, not its models", () => {
    const files = loadWorldFiles("dev"), base = worldFingerprint(files);
    expect(base).toMatch(/^[a-f0-9]{8}$/);
    expect(worldFingerprint(structuredClone(files))).toBe(base);
    const moved = structuredClone(files); moved.manifest.spawn.x += 1;
    expect(worldFingerprint(moved)).not.toBe(base);
  });
});
