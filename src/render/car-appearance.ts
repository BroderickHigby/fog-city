import * as THREE from "three";

/** Original city palettes: no vehicle brands, decals, text or downloaded artwork. */
export const CAR_PALETTES = [
  [0xe86836, 0xffedb5], [0x217aa5, 0x75e7dc], [0xeba92f, 0x473c7b],
  [0x319778, 0xf9d08b], [0xf1e6cf, 0xef664b], [0x7857a7, 0xf3a4c5],
  [0xc74758, 0xffd17c], [0x3d4c6f, 0xa2dce1], [0x73afbf, 0xfff0d0],
  [0xb1ba64, 0x305f64], [0xeb9c9c, 0x733d75], [0xe5d64e, 0x327b98],
] as const;
export interface CarAppearance { paint: THREE.Color; accent: THREE.Color; style: number }
const appearances = new Map<string,CarAppearance>();
export function carAppearance(id: number, taxi = false): CarAppearance {
  const n = Math.abs(Math.trunc(id));
  const key = `${n%12}:${taxi}`;
  const hit = appearances.get(key); if(hit) return hit;
  const palette = CAR_PALETTES[n % CAR_PALETTES.length]!;
  const appearance = { paint: new THREE.Color(palette[0]), accent: new THREE.Color(palette[1]), style: taxi ? 1 + n % 3 : n % 4 };
  appearances.set(key,appearance); return appearance;
}

/** Broad painted ribbons, rising-sun arcs and diagonal coast shapes, in model coordinates. */
export const CAR_ART_GLSL = /* glsl */ `
float fcCarArt(vec3 p, float style) {
  if (style < 0.5) return 0.0;
  float side = max(smoothstep(0.55, 0.78, abs(p.x)),smoothstep(1.55,1.9,abs(p.z)));
  float body = (1.0-smoothstep(1.02,1.15,p.y))*smoothstep(0.40,0.52,p.y);
  float ribbon = 1.0-smoothstep(0.075,0.11,abs(p.y-0.70-0.12*sin(p.z*2.2)));
  vec2 sun = vec2(p.z+0.35,p.y-0.48);
  float rings = 1.0-smoothstep(0.055,0.085,abs(length(sun)-0.52));
  float coast = step(0.5,fract((p.z+p.y*3.1)*0.58));
  float shape = style < 1.5 ? ribbon : style < 2.5 ? max(rings,step(length(sun),0.25)) : coast;
  float roof = smoothstep(1.45,1.60,p.y);
  float roofArt = 1.0-smoothstep(0.16,0.24,abs(p.x-0.25*sin(p.z*1.8)));
  return max(side*body*shape,roof*roofArt);
}
`;

/** Clone only paint; windows, tyres, lamps, sensor bands and model geometry stay shared. */
export function paintCar(root: THREE.Object3D, appearance: CarAppearance): THREE.Material[] {
  const clones = new Map<THREE.Material, THREE.Material>();
  root.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (material: THREE.Material): THREE.Material => {
      if (!/^paint(?:_|\.|$)/.test(material.name)) return material;
      let clone = clones.get(material);
      if (!clone) {
        const paint = material.clone() as THREE.MeshStandardMaterial;
        paint.color.copy(appearance.paint);
        const before = material.onBeforeCompile;
        paint.onBeforeCompile = (shader, renderer) => {
          before.call(paint, shader, renderer);
          shader.uniforms.fcCarAccent = { value: appearance.accent };
          shader.uniforms.fcCarStyle = { value: appearance.style };
          shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vFcCarPosition;")
            .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFcCarPosition = position;");
          shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\nvarying vec3 vFcCarPosition;\nuniform vec3 fcCarAccent;\nuniform float fcCarStyle;\n${CAR_ART_GLSL}`)
            .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, fcCarAccent, fcCarArt(vFcCarPosition,fcCarStyle));");
        };
        paint.customProgramCacheKey = () => "fc:car-art:v1";
        clone = paint;
        clones.set(material, clone);
      }
      return clone;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  return [...clones.values()];
}
