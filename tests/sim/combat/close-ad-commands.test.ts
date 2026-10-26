import { describe, expect, it } from "vitest";
import { buildWorld, canonicalJson, createGameSystems, createInitialState, makeFoot, step, type SimState } from "../../../src/sim/index.ts";
import { agentsCombatOptions } from "../../../src/sim/agents/systems.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { createCombatSystem } from "../../../src/sim/combat/systems.ts";
import type { GameplayCommandEvent } from "../../../src/sim/gameplay-contract.ts";

function livePopups() {
  const world = buildWorld([]);
  const systems = createGameSystems({ wave: 3, protectedArea: () => false, agents: () => ({ services: false,
    spawns: [0, 3].map((x, index) => ({ id: `popup-${index}`, numericId: 10 + index, model: "footman" as const,
      firmware: "bad" as const, x, y: 0, z: 0, heading: 0, radius: .4, height: 1.8 })) }) });
  let state = createInitialState(world, 1, ["p1", "p2"], { x: 30, z: 30, heading: 0 });
  state.players.p1 = { ...state.players.p1!, mode: "foot", foot: makeFoot(0, 0, -4, Math.PI) };
  for (let tick = 0; tick < 60; tick++) state = step(world, state, {}, [], systems);
  const ids = state.ext.combat!.attacks.filter(a => a.active && a.kind === "ad-blast" && a.targetId === "p1").map(a => a.id);
  expect(ids).toHaveLength(2);
  return { world, systems, state, ids };
}
function command(state: SimState, targetId: string, playerId = "p1", sequence = 1): GameplayCommandEvent {
  return { tick: state.tick + 1, kind: "gameplay.command", playerId, payload: { sequence, kind: "close-ad", targetId } };
}
function popups(state: SimState) { return state.ext.combat!.attacks.filter(a => a.active && a.kind === "ad-blast" && a.targetId === "p1").map(a => a.id); }

describe("recorded close-ad commands, v17", () => {
  it("dismisses the clicked popup rather than the first, including clicks on consecutive ticks", () => {
    const f = livePopups(), before = canonicalJson(f.state);
    let state = step(f.world, f.state, {}, [command(f.state, f.ids[1]!)], f.systems);
    expect(popups(state)).toEqual([f.ids[0]]);
    expect(state.ext.combat!.events.filter(e => e.kind === "player.ad-popup" && e.amount === -1)).toHaveLength(1);
    expect(state.ext.combat!.players.p1!.held).not.toContain("closeAd");
    state = step(f.world, state, {}, [command(state, f.ids[0]!, "p1", 2)], f.systems);
    expect(popups(state)).toEqual([]);
    expect(canonicalJson(f.state)).toBe(before);
  });

  it("deduplicates repeated clicks and never falls back from stale or foreign IDs to another popup", () => {
    const f = livePopups();
    let state = step(f.world, f.state, {}, [command(f.state, f.ids[1]!), command(f.state, f.ids[1]!, "p1", 2)], f.systems);
    expect(popups(state)).toEqual([f.ids[0]]);
    expect(state.ext.combat!.events.filter(e => e.kind === "player.ad-popup" && e.amount === -1)).toHaveLength(1);
    for (const [id, player] of [[f.ids[1]!, "p1"], [f.ids[0]!, "p2"], ["missing:1", "p1"], ["bad target!", "p1"]]) {
      state = step(f.world, state, {}, [command(state, id!, player!)], f.systems);
      expect(popups(state)).toEqual([f.ids[0]]);
      expect(state.ext.combat!.events.some(e => e.kind === "player.ad-popup" && e.amount === -1)).toBe(false);
    }
  });

  it("applies two distinct UI clicks delivered in the same recorded tick", () => {
    const f = livePopups();
    const state = step(f.world, f.state, {}, [command(f.state, f.ids[0]!), command(f.state, f.ids[1]!, "p1", 2)], f.systems);
    expect(popups(state)).toEqual([]);
    expect(state.ext.combat!.events.filter(e => e.kind === "player.ad-popup" && e.amount === -1)).toHaveLength(2);
  });

  it("ignores inactive and expired IDs without dismissing a live card", () => {
    const f = livePopups(), first = f.state.ext.combat!.attacks.find(a => a.id === f.ids[0])!;
    const state = { ...f.state, ext: { ...f.state.ext, combat: { ...f.state.ext.combat!, attacks: [
      ...f.state.ext.combat!.attacks, { ...first, id: "pending:1", active: false, resolveTick: f.state.tick + 100 },
      { ...first, id: "expired:1", endTick: f.state.tick },
    ] } } };
    const after = step(f.world, state, {}, [command(state, "pending:1"), command(state, "expired:1", "p1", 2)], f.systems);
    expect(popups(after)).toEqual(f.ids);
  });

  it("keeps v16 recorded commands inert", () => {
    const f = livePopups(), state = { ...f.state, version: 16 };
    expect(popups(step(f.world, state, {}, [command(state, f.ids[1]!)], f.systems))).toEqual(f.ids);
  });

  it("lets explicit provider inputs override recorded commands and retains boolean held-edge behavior", () => {
    const f = livePopups();
    const empty = f.systems.map(system => system.key === "combat" ? createCombatSystem(ctx => ({
      context: contextFromState(f.world, ctx.state, { ...agentsCombatOptions(ctx.state), wave: 3 }), inputs: {},
    })) : system);
    expect(popups(step(f.world, f.state, {}, [command(f.state, f.ids[1]!)], empty))).toEqual(f.ids);
    let held = true;
    const boolean = f.systems.map(system => system.key === "combat" ? createCombatSystem(ctx => ({
      context: contextFromState(f.world, ctx.state, { ...agentsCombatOptions(ctx.state), wave: 3 }), inputs: { p1: { closeAd: held } },
    })) : system);
    let state = step(f.world, f.state, {}, [command(f.state, f.ids[1]!)], boolean);
    expect(popups(state)).toEqual([f.ids[1]]);
    state = step(f.world, state, {}, [], boolean);
    expect(popups(state)).toEqual([f.ids[1]]);
    held = false; state = step(f.world, state, {}, [], boolean);
    held = true; state = step(f.world, state, {}, [], boolean);
    expect(popups(state)).toEqual([]);
  });
});
