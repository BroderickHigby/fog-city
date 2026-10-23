import { describe, expect, it } from "vitest";
import { createCombatState, stepCombat } from "../../../src/sim/combat/system.ts";
import { activeFogZones, microclimateBlocksSight } from "../../../src/sim/combat/microclimate.ts";
import { sightRange } from "../../../src/sim/combat/perception.ts";
import { waterShot } from "../../../src/sim/combat/weapons.ts";
import type { CombatActor, CombatContext, CombatPlayer, CombatState } from "../../../src/sim/combat/types.ts";

const player = (patch: Partial<CombatPlayer> = {}): CombatPlayer => ({ id: "p", x: 0, y: 0, z: 0, heading: 0, speed: 0, mount: "foot", tankTier: 0, flowTier: 0, scannerTier: 1, gear: "microclimate", ...patch });
const robot = (id: string, x = 4, patch: Partial<CombatActor> = {}): CombatActor => ({ id, kind: "robot", model: "footman", firmware: "bad", x, y: 0, z: 0, heading: 0, speed: 0, height: 1.8, radius: 0.4, ...patch });
const context = (patch: Partial<CombatContext> = {}): CombatContext => ({ wave: 4, players: [player()], actors: [], refills: [], walls: [], ...patch });
function run(state: CombatState, ctx: CombatContext, count: number): CombatState { for (let i = 0; i < count; i++) state = stepCombat(state, ctx); return state; }

describe("persistent wide nozzle", () => {
  it("uses a three-pellet fan without increasing water or total rust and stacks pressure boost", () => {
    const p = player({ nozzle: "wide" }), ctx = context({ players: [p] }), state = createCombatState(1, ctx);
    const shot = waterShot(state, p, { fire: true }, ctx)!;
    expect(shot).toMatchObject({ pellets: 3, volume: 0.08, rustRate: 0.025, range: 12 });
    expect(shot.spreadRadians).toBeGreaterThan(0);
    state.players.p!.boost = "pressure"; state.players.p!.boostUntil = 100;
    expect(waterShot(state, p, { fire: true }, ctx)).toMatchObject({ pellets: 3, range: 18 });
    const next = stepCombat(state, ctx, { p: { fire: true } });
    expect(next.projectiles).toHaveLength(3);
    expect(next.projectiles.reduce((total, p) => total + p.volume, 0)).toBeCloseTo(0.08);
    expect(next.players.p!.water).toBeCloseTo(7.92);
  });
});

describe("Microclimate-as-a-Service", () => {
  it("creates one 8m zone for20s, follows the owner, and enforces90s reuse", () => {
    const ctx = context(); let state = stepCombat(createCombatState(1, ctx), ctx, { p: { gear: true } });
    expect(activeFogZones(state)).toHaveLength(1); expect(activeFogZones(state)[0]).toMatchObject({ radius: 8, untilTick: 1201 });
    expect(state.players.p!.nextGearTick).toBe(5401);
    state = stepCombat(state, context({ players: [player({ x: 10 })] }), { p: { gear: true } });
    expect(activeFogZones(state)[0]!.x).toBe(10);
    state = run(state, ctx, 1199); expect(activeFogZones(state)).toEqual([]);
    state = stepCombat(state, ctx, { p: { gear: true } }); expect(activeFogZones(state)).toEqual([]);
    state = run(state, ctx, 4200);
    state = stepCombat(state, ctx, { p: { gear: true } }); expect(activeFogZones(state)).toHaveLength(1);
  });

  it("rusts only bad robots at0.03/s and blocks robot sight through the sphere", () => {
    const bad = robot("bad"), good = robot("good", 3, { firmware: "good" }), outside = robot("outside", 9), sheltered = robot("inside", 2, { sheltered: true });
    const ctx = context({ actors: [bad, good, outside, sheltered] });
    let state = stepCombat(createCombatState(1, ctx), ctx, { p: { gear: true } }); state = run(state, ctx, 59);
    expect(state.targets.bad!.rust).toBeCloseTo(0.03, 10); expect(state.targets.inside!.rust).toBeCloseTo(0.03, 10);
    expect(state.targets.good!.rust).toBe(0); expect(state.targets.outside!.rust).toBe(0);
    expect(sightRange(state, ctx, bad)).toBe(0);
    expect(microclimateBlocksSight(state, { x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 })).toBe(true);
    expect(microclimateBlocksSight(state, { x: -20, y: 0, z: 20 }, { x: 20, y: 0, z: 20 })).toBe(false);
  });

  it("requires equipped gear and preserves duration across AGI pause", () => {
    const ctx = context({ players: [player({ gear: "none" })] });
    expect(activeFogZones(stepCombat(createCombatState(1, ctx), ctx, { p: { gear: true } }))).toEqual([]);
    const equipped = context(); let state = stepCombat(createCombatState(1, equipped), equipped, { p: { gear: true } });
    state.pauseUntil = state.tick + 30; state = run(state, equipped, 30);
    expect(activeFogZones(state)[0]!.untilTick).toBe(1231);
  });
});
