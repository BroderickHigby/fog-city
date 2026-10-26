import { describe, expect, it } from "vitest";
import { buildWorld, canonicalJson, createGameSystems, createInitialState, makeFoot, step } from "../../src/sim/index.ts";
import type { GameplayCommandEvent } from "../../src/sim/gameplay-contract.ts";
import { uiText } from "../../src/content/ui.ts";
import { gameplayCallbacks } from "../../src/ui/commands.ts";
import { uiProjection } from "../../src/ui/projection.ts";

function activePopup() {
  const world = buildWorld([]);
  const registry = createGameSystems({ wave: 3, protectedArea: () => false, agents: () => ({ services: false,
    spawns: [{ id: "popup-bot", numericId: 10, model: "footman", firmware: "bad", x: 0, y: 0, z: 0,
      heading: 0, radius: .4, height: 1.8 }] }) });
  let state = createInitialState(world, 1, ["p1", "p2"], { x: 30, z: 30, heading: 0 });
  state.players.p1 = { ...state.players.p1!, mode: "foot", foot: makeFoot(0, 0, -4, Math.PI) };
  for (let tick = 0; tick < 60; tick++) state = step(world, state, {}, [], registry);
  const attack = state.ext.combat!.attacks.find(a => a.active && a.kind === "ad-blast" && a.targetId === "p1")!;
  expect(attack).toBeDefined();
  return { state, attack, world, registry };
}

describe("live ad-blast UI projection", () => {
  it("shows the actual player's popup and preserves its attack ID for the close command", () => {
    const { state, attack, world, registry } = activePopup(), before = canonicalJson(state);
    const view = uiProjection(state, "p1", null);
    expect(view.popups).toEqual([{ id: attack.id, title: uiText("ui.ad.label"), detail: uiText("ui.ad.disclaimer") }]);
    expect(uiProjection(state, "p2", null).popups).toEqual([]);
    const events: GameplayCommandEvent[] = [];
    gameplayCallbacks({ playerId: "p1", tick: () => state.tick + 1, emit: event => events.push(event) }).closeAd!(view.popups![0]!.id);
    expect(events).toEqual([{ tick: state.tick + 1, kind: "gameplay.command", playerId: "p1",
      payload: { kind: "close-ad", targetId: attack.id, sequence: 1 } }]);
    expect(uiProjection(step(world, state, {}, events, registry), "p1", null).popups).toEqual([]);
    expect(canonicalJson(state)).toBe(before);
  });

  it("excludes inactive, expired, future, foreign-player and non-popup attack records", () => {
    const { state, attack } = activePopup();
    state.ext.combat = { ...state.ext.combat!, attacks: [
      { ...attack, id: "inactive", active: false },
      { ...attack, id: "expired", endTick: state.tick },
      { ...attack, id: "future", resolveTick: state.tick + 10 },
      { ...attack, id: "other-player", targetId: "p2" },
      { ...attack, id: "phone", kind: "phone-hack" },
      attack,
    ] };
    expect(uiProjection(state, "p1", null).popups?.map(popup => popup.id)).toEqual([attack.id]);
    const removed = { ...state, ext: { ...state.ext, combat: { ...state.ext.combat!, attacks: [] } } };
    expect(uiProjection(removed, "p1", null).popups).toEqual([]);
  });
});
