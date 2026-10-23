// The combat presentation (render-only): rust, wetness and the topple a target reads as
// (runtime-actors.ts combatLook), the agent shader's rust and wet terms, and the splash a
// retired water projectile leaves (combat-layer.ts).
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CombatLayer, SPLASH_DROPS, SPLASH_MAX, SPLASH_S } from "../../src/render/combat-layer.ts";
import { visualCombat } from "../../src/render/agent-layer.ts";
import { packedMaterial } from "../../src/render/agent-packing.ts";
import { PERSON_WET_FADE_TICKS, ROBOT_WET_TICKS, combatLook } from "../../src/render/runtime-actors.ts";
import type { CombatState, Projectile, TargetCombat } from "../../src/sim/combat-contract.ts";
import { EFFECTS } from "../../src/sim/combat/effects.ts";
import type { AgentState } from "../../src/sim/agents.ts";

const target = (over: Partial<TargetCombat>): TargetCombat =>
  ({
    rust: 0, phase: "active", phaseTick: 0, lastWaterTick: -1000, heightScale: 1, puddle: false, repair: false, penalized: false,
    wetHits: [], wetUntil: 0, blindUntil: 0, waryUntil: 0, alerted: false, pullOverTick: 0, pullOverSpeed: 0, stoppedUntil: 0,
    flowersUntil: 0, slowUntil: 0, distractedUntil: 0, sourceId: "", movementScale: 1, windupScale: 1, ...over,
  }) as TargetCombat;

describe("combatLook", () => {
  it("is nothing without a target", () => {
    expect(combatLook(undefined, 100, false)).toEqual({ rust: 0, wet: 0, topple: 0 });
  });

  it("carries the sim's rust on robots, never on people", () => {
    expect(combatLook(target({ rust: 0.4 }), 1000, false).rust).toBeCloseTo(0.4);
    expect(combatLook(target({ rust: 0.4 }), 1000, true).rust).toBe(0);
  });

  it("topples only once seized: from the end of the seizure over the slump, whole as a heap", () => {
    const at = (phase: TargetCombat["phase"], age: number): number => combatLook(target({ rust: 1, phase, phaseTick: 1000 }), 1000 + age, false).topple;
    expect(at("seized", 10)).toBe(0);
    expect(at("slumping", EFFECTS.seizedTicks)).toBe(0);
    expect(at("slumping", (EFFECTS.seizedTicks + EFFECTS.collapseTicks) / 2)).toBeCloseTo(0.5);
    expect(at("heap", EFFECTS.collapseTicks + 5)).toBe(1);
    expect(at("active", 0)).toBe(0);
  });

  it("reads a robot wet just after water hits it, drying over ROBOT_WET_TICKS", () => {
    const t = target({ lastWaterTick: 500 });
    expect(combatLook(t, 500, false).wet).toBe(1);
    expect(combatLook(t, 500 + ROBOT_WET_TICKS / 2, false).wet).toBeCloseTo(0.5);
    expect(combatLook(t, 500 + ROBOT_WET_TICKS + 1, false).wet).toBe(0);
  });

  it("reads a person wet while the sim says so, fading over the last PERSON_WET_FADE_TICKS", () => {
    const t = target({ wetUntil: 2000 });
    expect(combatLook(t, 1000, true).wet).toBe(1);
    expect(combatLook(t, 2000 - PERSON_WET_FADE_TICKS / 2, true).wet).toBeCloseTo(0.5);
    expect(combatLook(t, 2000, true).wet).toBe(0);
  });
});

describe("visualCombat", () => {
  it("reads the decorated fields, clamped, and zero when undecorated", () => {
    const a = { id: 3 } as AgentState;
    expect({ ...visualCombat(a) }).toEqual({ rust: 0, wet: 0, topple: 0 });
    const b = { id: 3, visualRust: 2, visualWet: 0.25, visualTopple: -1 } as unknown as AgentState;
    expect({ ...visualCombat(b) }).toEqual({ rust: 1, wet: 0.25, topple: 0 });
  });
});

describe("the agent shader's combat terms", () => {
  it("patches rust and wetness into the colour, roughness and metalness", () => {
    for (const slots of [false, true]) {
      const m = packedMaterial(slots);
      const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      };
      m.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
      expect(shader.vertexShader).toContain("attribute vec4 fcCue;");
      expect(shader.vertexShader).toContain("vFcCombat = fcCue.zw;");
      expect(shader.fragmentShader).toContain("fcRustCover");
      expect(shader.fragmentShader).toMatch(/roughnessFactor = mix\( mix\( vFcPbr\.x, 0\.92, fcRustCover \)/);
      expect(shader.fragmentShader).toContain("metalnessFactor = mix( vFcPbr.y, 0.1, fcRustCover );");
      expect(m.customProgramCacheKey()).toMatch(/:v2$/);
    }
  });
});

describe("splashes", () => {
  const water = (id: number, x: number): Projectile =>
    ({ id, kind: "water", ownerId: "p", x, y: 1, z: 0, vx: 10, vy: 0, vz: 0, distance: 0, range: 20, bornTick: 0, volume: 0.1, salt: false, vehicle: false, rustRate: 0.1 }) as Projectile;
  const state = (projectiles: Projectile[]): CombatState => ({ projectiles } as unknown as CombatState);

  it("a water projectile the sim retires leaves one splash, which runs its course and is gone", () => {
    const layer = new CombatLayer(new THREE.Scene());
    const a = state([water(1, 0), water(2, 5)]);
    const b = state([water(2, 6)]);
    layer.update(undefined, a, 0, 1 / 60);
    layer.update(a, b, 0, 1 / 60);
    expect(layer.splashCount).toBe(1);
    const drops = layer.root.getObjectByName("gameplay-splashes") as THREE.InstancedMesh;
    expect(drops.count).toBe(SPLASH_DROPS);
    // The same pair of states again (a frame between ticks) adds nothing.
    layer.update(a, b, 0.5, 1 / 60);
    expect(layer.splashCount).toBe(1);
    layer.update(a, b, 0.5, SPLASH_S + 0.01);
    expect(layer.splashCount).toBe(0);
    expect(drops.count).toBe(0);
    layer.dispose();
  });

  it("never holds more than SPLASH_MAX splashes", () => {
    const layer = new CombatLayer(new THREE.Scene());
    const many = state(Array.from({ length: SPLASH_MAX + 10 }, (_, i) => water(i + 1, i)));
    layer.update(undefined, many, 0, 0);
    layer.update(many, state([]), 0, 0);
    expect(layer.splashCount).toBe(SPLASH_MAX);
    layer.dispose();
  });
});
