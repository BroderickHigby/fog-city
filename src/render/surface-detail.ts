import * as THREE from "three";

const SIZE = 256;
function noise(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
}

/** One small, shared, generated tile: aggregate, fine cracks, bump and roughness. */
export function createSurfaceDetail(): THREE.DataTexture {
  const heights = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) heights[y * SIZE + x] = 92 + Math.floor(noise(x, y) * 72);
  // Sparse hairline repairs in the repeating tile, never road markings or navigation data.
  for (let line = 0; line < 4; line++) {
    let x = Math.floor(noise(line, 701) * SIZE), y = Math.floor(noise(line, 702) * SIZE);
    for (let step = 0; step < 105; step++) {
      heights[(y & 255) * SIZE + (x & 255)] = 35;
      x += 1;
      y += noise(line * 131 + step, 703) > 0.57 ? 1 : -1;
    }
  }
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  const at = (x: number, y: number): number => heights[(y & 255) * SIZE + (x & 255)]!;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    bytes[i] = at(x, y);
    bytes[i + 1] = 128 + (at(x - 1, y) - at(x + 1, y)) * 0.45;
    bytes[i + 2] = 128 + (at(x, y - 1) - at(x, y + 1)) * 0.45;
    bytes[i + 3] = 110 + Math.floor(noise(x >> 3, y >> 3) * 110);
  }
  const texture = new THREE.DataTexture(bytes, SIZE, SIZE, THREE.RGBAFormat);
  texture.name = "fc:generated-surface-detail";
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

export const SURFACE_DETAIL_PARS = /* glsl */ `
uniform sampler2D fcSurfaceDetail;
float fcSurfaceHash(vec2 p) {
  vec3 h = fract(vec3(p.xyx) * 0.1031);
  h += dot(h, h.yzx + 33.33);
  return fract((h.x + h.y) * h.z);
}
float fcSurfaceNoise(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fcSurfaceHash(cell), fcSurfaceHash(cell + vec2(1.0, 0.0)), f.x),
    mix(fcSurfaceHash(cell + vec2(0.0, 1.0)), fcSurfaceHash(cell + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/** Uses world metres so adjacent tiles share scale and phase. */
export function surfaceDetailColor(ground = false, full = true): string {
  return /* glsl */ `
    vec4 fcSurface = texture2D(fcSurfaceDetail, vFcWorld.xz / 8.0);
    float fcGrainFade = 1.0 - smoothstep(0.08, 0.35, max(length(dFdx(vFcWorld.xz)), length(dFdy(vFcWorld.xz))));
    diffuseColor.rgb *= mix(1.0, 0.76 + fcSurface.r * 0.54, fcGrainFade);
    ${full ? `
    float fcLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    float fcConcrete = smoothstep(0.13, 0.24, fcLuma) * (1.0 - smoothstep(0.60, 0.72, fcLuma));
    float fcGreen = max(0.0, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
    fcConcrete *= 1.0 - smoothstep(0.015, 0.06, fcGreen);
    ${ground ? `
    vec3 fcWorldNormal = normalize(cross(dFdx(vFcWorld), dFdy(vFcWorld)));
    fcConcrete *= smoothstep(0.95, 0.99, abs(fcWorldNormal.y)) * smoothstep(2.0, 3.0, vFcWorld.y);` : ""}
    vec2 fcSlab = fract(vFcWorld.xz / 1.6);
    vec2 fcEdge = min(fcSlab, 1.0 - fcSlab) * 1.6;
    float fcJoint = 1.0 - smoothstep(0.012, 0.025 + max(fwidth(vFcWorld.x), fwidth(vFcWorld.z)), min(fcEdge.x, fcEdge.y));
    float fcSlabShade = 0.94 + fcSurfaceHash(floor(vFcWorld.xz / 1.6)) * 0.12;
    diffuseColor.rgb *= mix(1.0, fcSlabShade * (1.0 - fcJoint * 0.32), fcConcrete * fcGrainFade);` : ""}
  `;
}

export const SURFACE_DETAIL_NORMAL = /* glsl */ `
  vec3 fcBump = mat3(viewMatrix) * vec3((fcSurface.g - 0.5) * 0.10, 0.0, (fcSurface.b - 0.5) * 0.10);
  normal = normalize(normal + fcBump * fcGrainFade);
`;
export const SURFACE_DETAIL_ROUGHNESS = /* glsl */ `
  roughnessFactor = clamp(roughnessFactor * (0.84 + fcSurface.a * 0.20), 0.45, 1.0);
`;
