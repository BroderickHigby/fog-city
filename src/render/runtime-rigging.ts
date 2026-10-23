import * as THREE from "three";
import { mergePacked } from "./agent-packing.ts";
import type { RuntimeRigidAnimation, RuntimeRigidPart } from "./runtime-packing.ts";

const MOTION: Readonly<Record<RuntimeRigidAnimation, number>> = {
  fixed: 0, "left-leg": 1, "right-leg": 2, "left-wing": 3, "right-wing": 4, rotor: 5, wheel: 6, sign: 7,
  "left-arm": 8, "right-arm": 9,
};

/** Merge packed rigid joints without changing a vertex or dropping a moving part. */
export function mergeRuntimeAnimatedParts(parts: readonly RuntimeRigidPart[]): RuntimeRigidPart[] {
  const geometries: THREE.BufferGeometry[] = [], preserved: RuntimeRigidPart[] = [];
  for (const part of parts) {
    if (part.material) { preserved.push(part); continue; }
    const geometry = part.geometry.clone();
    if (part.rest) geometry.applyMatrix4(part.rest);
    const count = geometry.getAttribute("position").count, joints = new Float32Array(count * 4);
    for (let index = 0; index < count; index++) {
      joints[index * 4] = part.pivot[0]; joints[index * 4 + 1] = part.pivot[1];
      joints[index * 4 + 2] = part.pivot[2]; joints[index * 4 + 3] = MOTION[part.animation];
    }
    geometry.setAttribute("fcJoint", new THREE.BufferAttribute(joints, 4)); geometries.push(geometry);
  }
  if (geometries.length) {
    const geometry = mergePacked(geometries);
    for (const source of geometries) source.dispose();
    preserved.push({ geometry, pivot: [0, 0, 0], animation: "fixed", draws: 1 });
  }
  return preserved;
}

const RIG_PARS = /* glsl */ `
attribute vec4 fcJoint;
attribute vec4 fcRig;
attribute float fcGesture;
uniform float fcRuntimeTime;
mat3 fcJointRotation() {
  float motion = fcJoint.w;
  float angle = 0.0;
  if (motion > 0.5 && motion < 2.5) {
    angle = sin(fcRuntimeTime * 7.0 + fcRig.x) * 0.45 * fcRig.y;
    if (motion > 1.5) angle = -angle;
  } else if (motion > 2.5 && motion < 4.5) {
    if (fcRig.w > 0.5) angle = sin(fcRuntimeTime * 28.0 + fcRig.x) * 1.1 - 0.35;
    if (motion > 3.5) angle = -angle;
  } else if (motion > 4.5 && motion < 5.5) angle = fcRuntimeTime * 43.0 + fcRig.x;
  else if (motion > 5.5 && motion < 6.5) angle = -fcRuntimeTime * fcRig.z / 0.46;
  else if (motion > 6.5 && motion < 7.5) angle = sin(fcRuntimeTime * 1.8 + fcRig.x) * 0.55;
  else if (motion > 7.5) {
    if (motion > 8.5 && fcGesture > 0.5) {
      angle = 2.3 + sin(fcRuntimeTime * 6.0 + fcRig.x) * 0.25;
      float c = cos(angle), s = sin(angle);
      return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
    }
    angle = sin(fcRuntimeTime * 7.0 + fcRig.x) * 0.18 * fcRig.y * (motion < 8.5 ? -1.0 : 1.0);
  }
  float c = cos(angle), s = sin(angle);
  if (motion > 2.5 && motion < 4.5) return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
  if ((motion > 4.5 && motion < 5.5) || (motion > 6.5 && motion < 7.5)) return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}
`;

/** Identical joint deformation for the visible material and both shadow passes. */
export function installRuntimeRigging(material: THREE.Material, clock: { value: number }): void {
  const original = material.onBeforeCompile.bind(material), originalKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    original(shader, renderer);
    shader.uniforms.fcRuntimeTime = clock;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${RIG_PARS}`)
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = fcJointRotation() * objectNormal;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed = fcJoint.xyz + fcJointRotation() * transformed;");
  };
  material.customProgramCacheKey = () => `${originalKey()}:fc-runtime-rig:v1`;
}
