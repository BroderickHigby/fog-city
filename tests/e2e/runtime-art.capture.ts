import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const OUTPUT = join(import.meta.dirname, "..", "..", "test-results", "hd-art-review");

test("native 1080p runtime asset contact sheet", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", error => problems.push(error.message));
  page.on("console", message => { if (message.type() === "error") problems.push(message.text()); });
  await page.route("**/art-review.html", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>body{margin:0;background:#172027;color:#e5eeef;font:14px system-ui}canvas{position:absolute}#labels{position:absolute;inset:0;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(5,1fr);pointer-events:none}#labels div{border:1px solid #50626a55;padding:12px;box-sizing:border-box;text-shadow:0 1px #000}</style><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js"}}</script></head><body><canvas></canvas><div id="labels"></div></body></html>` }));
  await page.goto("/art-review.html");
  const result = await page.evaluate(async () => {
    const paths = ["/node_modules/three/build/three.module.js", "/node_modules/three/examples/jsm/loaders/GLTFLoader.js", "/src/render/model-registry.ts", "/src/render/agent-runtime.ts"];
    const THREE = await import(paths[0]!);
    const { GLTFLoader } = await import(paths[1]!);
    const { ModelRegistry } = await import(paths[2]!);
    const { createRuntimeAgentRenderer } = await import(paths[3]!);
    const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector("canvas"), antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1920, 1080); renderer.setPixelRatio(1); renderer.setScissorTest(true);
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#172027");
    scene.add(new THREE.HemisphereLight(0xe0f2ff, 0x736348, 2));
    const key = new THREE.DirectionalLight(0xfff1d7, 3); key.position.set(8, 10, 5); scene.add(key);
    const fill = new THREE.DirectionalLight(0x78a9cf, 1); fill.position.set(-5, 3, -8); scene.add(fill);
    const loader = new GLTFLoader();
    const registry = new ModelRegistry({ load: async (url: string) => (await loader.loadAsync("/" + url)).scene,
      fallback: () => new THREE.Group(), clone: (root: any) => root.clone(true) });
    const layer = createRuntimeAgentRenderer(scene, { registry, shadows: false });
    const kinds = ["pigeon", "dog", "parrot", "van", "bus", "robotaxi", "drone", "footman", "trundle", "patrol", "tidy", "sign-spinner", "associate", "walker", "finale", "heap", "puddle", "weak-point", "leash", "lanyard"];
    const make = (kind: string) => ({ id: kind, kind, x: 0, y: 0, z: 0, heading: 0.35, speed: 1,
      mode: kind === "parrot" ? "fly" : "active", emote: kind === "footman" ? "wave" : "none" });
    layer.update({ actors: kinds.map(make) }, 180);
    await Promise.all(["bus", "van", "robotaxi", "dog", "pigeon", "heap"].map(kind => registry.get("runtime:" + kind)));
    await Promise.all([registry.get("robot"), registry.get("sidewalk-bot")]);
    const stats: { kind: string; fileKinds: string[] }[] = [];
    for (let index = 0; index < kinds.length; index++) {
      const kind = kinds[index]!;
      layer.update({ actors: [make(kind)] }, 180);
      layer.group.updateMatrixWorld(true);
      const bounds = new THREE.Box3();
      for (const child of layer.group.children) if (child.isInstancedMesh && child.visible) {
        // Packed joints are applied in the vertex shader, so raw geometry bounds omit
        // their pivots. Fit the rest-pose vertices, then leave room for animation.
        const positions = child.geometry.getAttribute("position"), joints = child.geometry.getAttribute("fcJoint");
        const matrix = new THREE.Matrix4(), point = new THREE.Vector3(); child.getMatrixAt(0, matrix);
        matrix.premultiply(child.matrixWorld);
        for (let vertex = 0; vertex < positions.count; vertex++) {
          point.fromBufferAttribute(positions, vertex);
          if (joints) point.add(new THREE.Vector3(joints.getX(vertex), joints.getY(vertex), joints.getZ(vertex)));
          bounds.expandByPoint(point.applyMatrix4(matrix));
        }
      }
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const radius = Math.max(size.y, size.x / (480 / 216), size.z, 0.5) * 0.75;
      const camera = new THREE.OrthographicCamera(-radius * 480 / 216, radius * 480 / 216, radius, -radius, 0.01, radius * 30 + 10);
      camera.position.copy(center).add(new THREE.Vector3(radius * 2.1, radius * 0.8, -radius * 2.8)); camera.lookAt(center);
      const col = index % 4, row = Math.floor(index / 4), y = 1080 - (row + 1) * 216;
      renderer.setViewport(col * 480, y, 480, 216); renderer.setScissor(col * 480, y, 480, 216);
      renderer.render(scene, camera);
      const label = document.createElement("div"); label.textContent = kind === "finale" ? "finale (camera fitted to scale)" : kind; document.querySelector("#labels")!.append(label);
      stats.push({ kind, bounds: size.toArray(), ...layer.info(), actualDrawCalls: renderer.info.render.calls });
    }
    return { stats, width: renderer.domElement.width, height: renderer.domElement.height };
  });
  expect(result.width).toBe(1920); expect(result.height).toBe(1080);
  expect(problems).toEqual([]);
  for (const kind of ["bus", "van", "robotaxi", "dog", "pigeon", "footman", "trundle", "sign-spinner", "heap"]) expect(result.stats.find(item => item.kind === kind)?.fileKinds).toContain(kind);
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(join(OUTPUT, "runtime-gallery.json"), JSON.stringify(result, null, 2));
  await page.screenshot({ path: join(OUTPUT, "runtime-gallery-1080p.png") });
});
