import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { AgentLayer } from "../../src/render/agent-layer.ts";
import { packedMaterial } from "../../src/render/agent-packing.ts";
import { installRobotStatusLights, robotTellFrame } from "../../src/render/robot-tells.ts";
import type { ModelRegistry } from "../../src/render/model-registry.ts";
import type { SimState } from "../../src/sim/contract.ts";

function state(presentation: Record<string, unknown>, firmware = "good"): SimState {
  return { tick: 1, players: {}, ext: { agents: { nextId: 3, list: [
    { id: 1, kind: "errandRobot", x: -2, y: 0, z: -6, heading: 0, pitch: 0, speed: 0, mode: "go", dodge: null },
    { id: 2, kind: "errandRobot", x: 2, y: 0, z: -6, heading: 0, pitch: 0, speed: 0, mode: "go", dodge: null },
  ] }, robots: { enabled: true, metadata: [{ agentId: 1, phase: "active", firmware, presentation }] } } } as unknown as SimState;
}

describe("ordinary bot tell presentation", () => {
  it("reads per-ID presentation independently of firmware, interpolating only head angles", () => {
    const before = state({ headYaw: 0, bagFull: true, faceLight: 1 });
    const current = state({ headYaw: 1, bagFull: false, bagSwing: 1.8, faceLight: 0 }, "bad");
    expect(robotTellFrame(before, current, 0.25).get(1)).toEqual({ headYaw: 0.25, bagFull: false, bagSwing: 1.8, faceLight: 0 });
    expect(robotTellFrame(before, current, 0.25)).toEqual(robotTellFrame(before, state({ headYaw: 1, bagFull: false, bagSwing: 1.8, faceLight: 0 }), 0.25));
    current.ext.combat = { targets: { "agent:1": { phase: "heap" } } } as unknown as SimState["ext"]["combat"];
    expect(robotTellFrame(before, current, 1).size).toBe(0);
  });

  it("patches only the status channel, preserving body color and the head/brake channels", () => {
    const material = packedMaterial(false); installRobotStatusLights(material);
    const source = THREE.ShaderLib.standard;
    const shader = { uniforms: THREE.UniformsUtils.clone(source.uniforms), vertexShader: source.vertexShader,
      fragmentShader: source.fragmentShader, defines: {} } as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("(ch > 2.5 ? fcStatusLight : 1.0)");
    expect(shader.vertexShader).toContain("if (ch > 2.5) vColor.rgb *= fcStatusLight;");
    material.dispose();
  });

  it("uses the authored bag and head geometry per robot and clears cues cleanly", async () => {
    const load = async (name: string): Promise<THREE.Object3D> => {
      const bytes = readFileSync(new URL(`../../public/models/${name}.glb`, import.meta.url));
      return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "")).scene;
    };
    const [robot, taxi, trundle] = await Promise.all([load("errand-robot"), load("robotaxi"), load("sidewalk-bot")]);
    const models: Record<string, THREE.Object3D> = { robot, robotaxi: taxi, "sidewalk-bot": trundle };
    const registry = { get: async (id: string) => ({ source: "file", model: models[id] }) } as unknown as ModelRegistry<THREE.Object3D>;
    const layer = new AgentLayer(registry); await Promise.resolve();
    const current = state({ headYaw: 0.8, bagFull: false, bagSwing: 1.8, faceLight: 0 });
    layer.setTellCues(robotTellFrame(current, current, 1));
    layer.update(current, current, 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
    const meshes = layer.group.children as THREE.InstancedMesh[];
    const head = meshes.find(mesh => mesh.name === "agents:errandRobot:head")!;
    const bag = meshes.find(mesh => mesh.name === "agents:errandRobot:bagContents")!;
    expect(head.count).toBe(2); expect(bag.count).toBe(1);
    const first = new THREE.Matrix4(), second = new THREE.Matrix4(); head.getMatrixAt(0, first); head.getMatrixAt(1, second);
    expect(first.elements[0]).not.toBeCloseTo(second.elements[0]!);
    expect(head.geometry.getAttribute("fcStatusLight").getX(0)).toBe(0);
    expect(head.geometry.getAttribute("fcStatusLight").getX(1)).toBe(1);
    layer.setTellCues(new Map()); layer.update(current, current, 1, { x: 0, z: 0, fx: 0, fz: -1 }, 1 / 60, 0);
    expect(bag.count).toBe(2); expect(head.geometry.getAttribute("fcStatusLight").getX(0)).toBe(1);
    layer.dispose();
  });
});
