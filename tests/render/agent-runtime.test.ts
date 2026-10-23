import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createRuntimeAgentRenderer, RUNTIME_LIVERY_HEIGHT, RUNTIME_LIVERY_WIDTH, type RuntimeVisualActor, type RuntimeVisualKind } from "../../src/render/agent-runtime.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";

const actor = (id: string, kind: string, x = 0): RuntimeVisualActor => ({ id, kind, x, y: 0, z: 0, heading: 0, speed: 1 });
const meshes = (group: THREE.Group): THREE.InstancedMesh[] => group.children as THREE.InstancedMesh[];

describe("runtime agent visuals", () => {
  it("covers every supplied runtime kind with finite, indexed geometry", () => {
    const scene = new THREE.Scene(), render = createRuntimeAgentRenderer(scene);
    const kinds: RuntimeVisualKind[] = ["pigeon", "parrot", "dog", "van", "bus", "drone", "footman", "trundle", "patrol", "tidy", "sign-spinner", "associate", "walker", "finale"];
    render.update({ actors: kinds.map(kind => actor(kind, kind)) }, 120);
    expect(render.info().drawn).toBe(kinds.length);
    expect(render.info().kinds).toEqual([...kinds].sort());
    for (const mesh of meshes(render.group)) {
      expect(mesh.geometry.index!.count).toBeGreaterThan(0);
      expect(Array.from(mesh.geometry.getAttribute("position").array).every(Number.isFinite)).toBe(true);
      expect(Array.from(mesh.instanceMatrix.array).every(Number.isFinite)).toBe(true);
    }
    render.dispose();
  });

  it("pools one animated draw across actors and reuses buffers on later frames", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    const actors = Array.from({ length: 30 }, (_, n) => actor(`dog:${n}`, "dog", n));
    render.update({ actors }, 10);
    const before = [...render.group.children];
    expect(render.info().drawn).toBe(30);
    expect(render.info().drawCalls).toBe(1);
    render.update({ actors }, 20);
    expect(render.group.children).toEqual(before);
    expect(meshes(render.group).every(mesh => mesh.count === 30)).toBe(true);
    render.dispose();
  });

  it("preserves independent gaits and flight state inside a single shared animated draw", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    render.update({ actors: [{ ...actor("bird:ground", "pigeon"), speed: 0 }, { ...actor("bird:air", "pigeon"), speed: 2, mode: "fly" }] }, 30);
    expect(render.info()).toMatchObject({ drawn: 2, drawCalls: 1 });
    const geometry = meshes(render.group)[0]!.geometry, rig = geometry.getAttribute("fcRig");
    expect(new Set([rig.getW(0), rig.getW(1)])).toEqual(new Set([0, 1]));
    expect(new Set([rig.getY(0), rig.getY(1)])).toEqual(new Set([0, 1]));
    const joints = geometry.getAttribute("fcJoint");
    expect(new Set(Array.from({ length: joints.count }, (_, index) => joints.getW(index)))).toEqual(new Set([0, 3, 4]));
    render.dispose();
  });

  it("renders controlled-robot wave joints and battery tells without extra draws", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    render.update({ actors: [{ ...actor("player:robot", "footman"), emote: "wave", tells: ["battery-overdraw"] }] }, 30);
    expect(render.info().drawCalls).toBe(1);
    const geometry = meshes(render.group)[0]!.geometry;
    expect(geometry.getAttribute("fcGesture").getX(0)).toBe(1);
    expect(geometry.getAttribute("fcCue").getY(0)).toBeGreaterThan(0);
    const joints = geometry.getAttribute("fcJoint");
    expect(new Set(Array.from({ length: joints.count }, (_, index) => joints.getW(index)))).toEqual(new Set([0, 1, 2, 8, 9]));
    render.dispose();
  });

  it("selects nearest actors deterministically under the global cap", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene(), { maxActors: 1 });
    render.update({ actors: [actor("far", "dog", 80), actor("near", "pigeon", 5)], viewer: { x: 0, z: 0 } }, 0);
    expect(render.info()).toMatchObject({ drawn: 1, dropped: 1, kinds: ["pigeon"] });
    render.dispose();
  });

  it("uses less detailed geometry beyond the actor detail radius", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    render.update({ actors: [actor("bus", "bus", 5)], viewer: { x: 0, z: 0 } }, 0);
    const close = render.info().triangles;
    render.update({ actors: [actor("bus", "bus", 500)], viewer: { x: 0, z: 0 } }, 0);
    expect(render.info().triangles).toBeLessThan(close);
    expect(render.info().near).toBe(0);
    render.update({ actors: [actor("bus", "bus", 5000)], viewer: { x: 0, z: 0 } }, 0);
    expect(render.info().drawn).toBe(0);
    expect(meshes(render.group).every(mesh => !mesh.visible)).toBe(true);
    render.dispose();
  });

  it("batches distant rigid models into one rest-pose draw per kind", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    const kinds: RuntimeVisualKind[] = ["dog", "bus", "van", "robotaxi", "footman", "sign-spinner", "walker"];
    render.update({ actors: kinds.flatMap(kind => Array.from({ length: 20 }, (_, index) => actor(`${kind}:${index}`, kind, 350))),
      viewer: { x: 0, z: 0 } }, 0);
    expect(render.info()).toMatchObject({ drawn: 140, near: 0, drawCalls: kinds.length });
    expect(meshes(render.group).filter(mesh => mesh.visible).every(mesh => mesh.count === 20)).toBe(true);
    render.dispose();
  });

  it("pools emissive joint markers without counting them as physical actors", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    render.update({ actors: [actor("ankle:left", "weak-point"), { ...actor("knee:right", "weak-point"), y: 100, rust: 0.8, scale: 12 }] }, 180);
    expect(render.info()).toMatchObject({ drawn: 2, bodiesDrawn: 0, bodiesNear: 0, drawCalls: 1, kinds: ["weak-point"] });
    const part = meshes(render.group)[0]!;
    expect(part.geometry.getAttribute("fcEmit").count).toBeGreaterThan(0);
    expect(part.instanceColor!.getY(1)).toBeLessThan(part.instanceColor!.getY(0));
    expect(part.instanceMatrix.array.every(Number.isFinite)).toBe(true);
    render.dispose();
  });

  it("draws the exact boss and rogue-taxi model keys emitted by the routine runtime", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    render.update({ actors: [actor("boss", "elizabeth"), actor("rogue", "robotaxi")] }, 0);
    expect(render.info()).toMatchObject({ drawn: 2, invalid: 0, kinds: ["finale", "robotaxi"] });
    const taxi = meshes(render.group).find(mesh => mesh.name.startsWith("runtime:robotaxi:near:fixed"))!;
    taxi.geometry.computeBoundingBox();
    expect(taxi.geometry.boundingBox!.max.y).toBeLessThan(1.8);
    render.dispose();
  });

  it("places boss ankle and knee geometry at the authoritative joint offsets", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    render.update({ actors: [actor("boss", "elizabeth")] }, 0);
    const closeVertex = (center: THREE.Vector3, color: THREE.Color, radius: number): boolean => meshes(render.group).some(mesh => {
      const p = mesh.geometry.getAttribute("position"), c = mesh.geometry.getAttribute("color");
      for (let i = 0; i < p.count; i++) {
        if (Math.abs(c.getX(i) - color.r) < 1e-5 && Math.abs(c.getY(i) - color.g) < 1e-5 && Math.abs(c.getZ(i) - color.b) < 1e-5 &&
            center.distanceTo(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i))) <= radius) return true;
      }
      return false;
    });
    for (const side of [-1, 1]) {
      expect(closeVertex(new THREE.Vector3(side * 0.12, 0.05, 0), new THREE.Color(0x39c4c5), 0.041)).toBe(true);
      expect(closeVertex(new THREE.Vector3(side * 0.12, 1, 0), new THREE.Color(0xf4b13f), 0.061)).toBe(true);
    }
    render.dispose();
  });

  it("adopts loaded authored meshes while sharing their geometry buffers and textures", async () => {
    const texture = new THREE.Texture(), sourceMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture });
    const sourceGeometry = new THREE.BoxGeometry(2, 3, 8), source = new THREE.Group();
    const body = new THREE.Mesh(sourceGeometry, sourceMaterial); body.name = "body"; body.position.y = 1.5; source.add(body);
    let loads = 0, sourceDisposed = 0, textureDisposed = 0;
    sourceGeometry.addEventListener("dispose", () => sourceDisposed++);
    texture.addEventListener("dispose", () => textureDisposed++);
    const registry = new ModelRegistry<THREE.Object3D>({ load: async () => { loads++; return source; }, clone: root => root.clone(true), fallback: () => new THREE.Group() });
    const render = createRuntimeAgentRenderer(new THREE.Scene(), { registry });
    render.update({ actors: [actor("bus:1", "bus"), actor("bus:2", "bus", 10)] }, 0);
    expect(render.info().fileKinds).toEqual([]);
    await registry.get("runtime:bus");
    render.update({ actors: [actor("bus:1", "bus"), actor("bus:2", "bus", 10)] }, 1);
    expect(render.info()).toMatchObject({ drawn: 2, fileKinds: ["bus"], drawCalls: 1 });
    const loaded = meshes(render.group).find(mesh => mesh.visible)!;
    expect(loaded.geometry.getAttribute("position")).toBe(sourceGeometry.getAttribute("position"));
    expect((loaded.material as THREE.MeshStandardMaterial).map).toBe(texture);
    expect(loaded.material).not.toBe(sourceMaterial);
    expect(loads).toBe(1);
    render.dispose();
    expect(sourceDisposed).toBe(0); expect(textureDisposed).toBe(0);
    sourceGeometry.dispose(); sourceMaterial.dispose(); texture.dispose();
  });

  it("keeps procedural fallbacks when the packed asset listing excludes a model", async () => {
    let loads = 0;
    const registry = new ModelRegistry<THREE.Object3D>({ available: new Set(), load: async () => { loads++; return new THREE.Group(); },
      clone: root => root.clone(true), fallback: () => new THREE.Group() });
    const render = createRuntimeAgentRenderer(new THREE.Scene(), { registry });
    render.update({ actors: [actor("dog", "dog")] }, 0);
    await registry.get("runtime:dog");
    render.update({ actors: [actor("dog", "dog")] }, 1);
    expect(render.info()).toMatchObject({ drawn: 1, fileKinds: [] }); expect(loads).toBe(0);
    render.dispose();
  });

  it("draws leash geometry between actual endpoints without counting another actor", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    const from = new THREE.Vector3(1, 0.5, 2), to = new THREE.Vector3(3, 1.5, 2);
    render.update({ actors: [], links: [{ id: "dog:leash", from, to }] }, 0);
    expect(render.info()).toMatchObject({ drawn: 1, bodiesDrawn: 0, kinds: ["leash"] });
    const matrix = new THREE.Matrix4(); meshes(render.group)[0]!.getMatrixAt(0, matrix);
    expect(new THREE.Vector3().applyMatrix4(matrix).distanceTo(from)).toBeLessThan(1e-5);
    expect(new THREE.Vector3(0, 1, 0).applyMatrix4(matrix).distanceTo(to)).toBeLessThan(1e-5);
    render.dispose();
  });

  it("natively generates and shares a 2048-pixel runtime bus wrap", async () => {
    const sourceMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff }); sourceMaterial.name = "livery";
    const source = new THREE.Group(), geometry = new THREE.PlaneGeometry(4.22, 0.74);
    source.add(new THREE.Mesh(geometry, sourceMaterial));
    const registry = new ModelRegistry<THREE.Object3D>({ load: async () => source, clone: root => root.clone(true), fallback: () => new THREE.Group() });
    const render = createRuntimeAgentRenderer(new THREE.Scene(), { registry });
    render.update({ actors: [actor("bus", "bus")] }, 0); await registry.get("runtime:bus");
    render.update({ actors: [actor("bus", "bus"), actor("bus:2", "bus", 10)] }, 1);
    const material = meshes(render.group).find(mesh => mesh.visible)!.material as THREE.MeshStandardMaterial;
    const texture = material.map as THREE.DataTexture;
    expect(texture.isDataTexture).toBe(true);
    expect(texture.image.width).toBe(2048); expect(texture.image.width).toBe(RUNTIME_LIVERY_WIDTH);
    expect(texture.image.height).toBe(RUNTIME_LIVERY_HEIGHT);
    const pixels = texture.image.data;
    if (pixels === null) throw new Error("Runtime livery has no pixel data");
    expect(pixels.length).toBe(2048 * RUNTIME_LIVERY_HEIGHT * 4);
    const x = 112, y = 100; // interior of the first original vector-letter stroke
    expect(Array.from(pixels.slice((y * 2048 + x) * 4, (y * 2048 + x) * 4 + 4))).toEqual([238, 243, 236, 255]);
    expect(sourceMaterial.map).toBeNull();
    render.dispose(); geometry.dispose(); sourceMaterial.dispose();
  });

  it("rejects invalid bodies and duplicate identities without corrupting transforms", () => {
    const render = createRuntimeAgentRenderer(new THREE.Scene());
    render.update({ actors: [actor("one", "bus"), actor("one", "bus"), actor("unknown", "not-an-agent"),
      { ...actor("nan", "bus"), x: NaN }, { ...actor("speed", "bus"), speed: Infinity }] }, 60);
    expect(render.info()).toMatchObject({ drawn: 2, invalid: 3 });
    expect(meshes(render.group).every(mesh => Array.from(mesh.instanceMatrix.array).every(Number.isFinite))).toBe(true);
    expect(() => render.update({ actors: [] }, Infinity)).toThrow(RangeError);
    render.dispose();
  });

  it("leaves snapshots frozen, animates by tick alone, and disposes idempotently", () => {
    const scene = new THREE.Scene(), render = createRuntimeAgentRenderer(scene);
    const actors = Object.freeze([Object.freeze({ ...actor("bird", "pigeon"), mode: "fly" })]);
    const snapshot = Object.freeze({ actors });
    render.update(snapshot, 0);
    const part = meshes(render.group)[0]!, material = part.material as THREE.Material;
    const library = THREE.ShaderLib.standard;
    const shader = { uniforms: THREE.UniformsUtils.clone(library.uniforms), vertexShader: library.vertexShader,
      fragmentShader: library.fragmentShader, defines: {} } as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    // The shared draw keeps base matrices stable; the actual bound shader uniform advances
    // the independent wing joints using each instance's phase and flight flag.
    const time = shader.uniforms.fcRuntimeTime!;
    expect(shader.vertexShader).toContain("sin(fcRuntimeTime * 28.0 + fcRig.x)");
    expect(part.geometry.getAttribute("fcRig").getW(0)).toBe(1);
    const animationState = () => ({ time: time.value as number,
      matrices: meshes(render.group).map(mesh => Array.from(mesh.instanceMatrix.array)),
      instances: meshes(render.group).map(mesh => Array.from(mesh.geometry.getAttribute("fcRig").array)) });
    const initial = animationState();
    render.update(snapshot, 10);
    expect(time.value).toBe(10 / 60);
    expect(animationState()).not.toEqual(initial);
    render.update(snapshot, 0);
    expect(animationState()).toEqual(initial);
    expect(actors[0]!.x).toBe(0);
    render.dispose(); render.dispose();
    expect(scene.children).toHaveLength(0);
    expect(render.group.children).toHaveLength(0);
    expect(() => render.update(snapshot, 0)).toThrow("disposed");
  });
});
