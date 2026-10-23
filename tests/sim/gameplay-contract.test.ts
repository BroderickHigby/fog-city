import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { buildWorld, canonicalJson, gameplayCommandFromEvent, type GameplayWorldData, type SimEvent } from "../../src/sim/index.ts";
import { deepFreeze } from "../helpers.ts";

describe("recorded gameplay command boundary", () => {
  it("takes the player from the event and accepts catalog IDs without mutating the log", () => {
    const event = deepFreeze({ tick: 1, kind: "gameplay.command", playerId: "p1", payload: { sequence: 9, kind: "buy", itemId: "tank-1" } });
    expect(gameplayCommandFromEvent(event)).toEqual({ sequence: 9, playerId: "p1", kind: "buy", itemId: "tank-1" });
    expect(canonicalJson(event)).toContain('"tank-1"');
  });
  it("rejects free text, forged player IDs, unknown fields and invalid sequences", () => {
    const event = { tick: 1, kind: "gameplay.command", playerId: "p1", payload: { sequence: 1, kind: "buy", itemId: "tank-1" } };
    for (const patch of [{ sequence: -1 }, { sequence: 1.1 }, { itemId: "typed words" }, { kind: "arbitrary" }, { playerId: "p2" }, { itemId: "constructor" }, { text: "hello" }]) {
      expect(gameplayCommandFromEvent({ ...event, payload: { ...event.payload, ...patch } })).toBeNull();
    }
    expect(gameplayCommandFromEvent({ ...event, tick: NaN })).toBeNull();
    expect(gameplayCommandFromEvent({ ...event, payload: [] })).toBeNull();
  });
  it("retains the shared command kinds needed by UI and player reducers", () => {
    for (const kind of ["mission-answer", "startup-define", "loadout", "streak-call", "close-ad", "break-free"]) {
      expect(gameplayCommandFromEvent({ tick: 1, kind: "gameplay.command", playerId: "p1", payload: { sequence: 1, kind } } as SimEvent)?.kind).toBe(kind);
    }
  });
});

describe("static gameplay world contract", () => {
  const data: GameplayWorldData = { version: 1, world: "dev", sourceSnapshot: "unversioned", refills: [{ id: "h1", kind: "hydrant", x: 1, y: 0, z: 2, radius: 2, salt: false }], anchors: [], tiles: [], territories: [] };
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(new URL("../../schemas/tile-gameplay.schema.json", import.meta.url), "utf8")));
  it("preserves an immutable optional layer and accepts its declared schema", () => {
    const frozen = deepFreeze(data);
    expect(buildWorld([], null, null, frozen).gameplay).toBe(frozen);
    expect(validate(data)).toBe(true);
    expect(buildWorld([]).gameplay).toBeUndefined();
  });
  it("rejects unsupported metadata and malformed refill radii", () => {
    expect(validate({ ...data, version: 2 })).toBe(false);
    expect(validate({ ...data, refills: [{ ...data.refills[0], radius: -1 }] })).toBe(false);
    expect(validate({ ...data, arbitrary: true })).toBe(false);
  });
});
