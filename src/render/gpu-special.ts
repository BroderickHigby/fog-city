// Node-material counterparts for render layers that previously supplied raw GLSL.
import * as THREE from "three";
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial, LineBasicNodeMaterial } from "three/webgpu";
import { Fn, If, fwidth, max, uniform, texture, positionWorld, normalWorld, positionLocal, attribute, uv, vec2, vec3, float, dot, smoothstep } from "three/tsl";
import { fcUniforms } from "./materials.ts";
import { DISTANT_WINDOW_GAIN, distantWindowLight, gpuMaterialUniforms } from "./node-materials.ts";

export function createFarNodeMaterial(mask: THREE.Texture, rectangle: THREE.Vector4): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: .92, metalness: 0, name: "fc:far" });
  material.userData.skipGpuAdapter = true;
  const rect = uniform(rectangle), farUv = positionWorld.xz.sub(rect.xy).div(rect.zw);
  const outside = farUv.x.lessThan(0).or(farUv.y.lessThan(0)).or(farUv.x.greaterThanEqual(1)).or(farUv.y.greaterThanEqual(1));
  material.maskNode = outside.or(texture(mask, farUv).r.lessThanEqual(.5));
  // The skyline is a kilometre or more away: a window is a pixel or less. Lit windows are filtered
  // clusters (window-clusters.ts), not a hard-edged cell grid, which aliased into white noise. The
  // grid is 4 m x 3.2 m cells along the wall (x + z follows either axis-aligned face).
  const wall = float(1).sub(smoothstep(.25, .45, normalWorld.y.abs())).mul(positionWorld.y.greaterThan(2).select(1, 0));
  const grid = vec2(positionWorld.x.add(positionWorld.z).div(4), positionWorld.y.div(3.2)), fw = max(fwidth(grid), .0001);
  const night = uniform(0).onRenderUpdate(() => fcUniforms.fcNight.value);
  // The mean glow (p .3 x gain .5 x .9, about .14) matches the tile buildings' distant windows
  // (.32 x .5 x drape .8 x .95, about .12), so the far cells do not read brighter than the city in front.
  material.emissiveNode = Fn(() => {
    // Before the branch, as in buildingMaterial: no derivative inside the cluster work.
    const footprint = fw.toVar(), light = vec3(0).toVar();
    If(night.greaterThan(0), () => { light.assign(distantWindowLight(grid, footprint, float(.3), float(0), gpuMaterialUniforms.time)); });
    return light.mul(wall).mul(night).mul(DISTANT_WINDOW_GAIN * .9);
  })();
  return material;
}

export function createContactNodeMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ name: "fc:contact-shadow", color: 0x101522, opacity: .32, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  material.userData.skipGpuAdapter = true;
  const contact = uv().mul(2).sub(1);
  material.opacityNode = float(.32).mul(float(1).sub(smoothstep(.12, 1, dot(contact, contact))));
  return material;
}

interface RainUniforms {
  fcRainCam: { value: THREE.Vector3 }; fcRainTime: { value: number }; fcRainBox: { value: number };
  fcRainOpacity: { value: number }; fcRainColor: { value: THREE.Color };
}
export function createRainNodeMaterial(values: RainUniforms): LineBasicNodeMaterial {
  const material = new LineBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, name: "fc:rain" });
  material.userData.skipGpuAdapter = true;
  const camera = uniform(values.fcRainCam.value), time = uniform(0).onRenderUpdate(() => values.fcRainTime.value);
  const box = uniform(values.fcRainBox.value), half = box.mul(.5), end = attribute("fcEnd", "float");
  const p = positionLocal;
  material.positionNode = vec3(
    p.x.sub(camera.x).add(half).mod(box).add(camera.x).sub(half),
    p.y.sub(time.mul(9)).sub(camera.y).mod(box).add(camera.y).sub(half),
    p.z.sub(camera.z).add(half).mod(box).add(camera.z).sub(half),
  ).add(vec3(.04, -.45, .02).mul(end));
  material.colorNode = uniform(values.fcRainColor.value);
  material.opacityNode = uniform(0).onRenderUpdate(() => values.fcRainOpacity.value).mul(float(1).sub(end.mul(.6)));
  return material;
}
