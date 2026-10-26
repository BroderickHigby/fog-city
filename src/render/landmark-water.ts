// A small authored inland surface uses the sea's existing water material, sky and waves.
// Its shore follows the committed terrain basin; it does not replace simulation ground.
import * as THREE from "three";
import lagoon from "../../content/palace-lagoon.json" with { type: "json" };

export const PALACE_LAGOON = lagoon;

export function createLandmarkWater(world: string, waterMaterial: THREE.Material): THREE.Mesh | null {
  if (world !== lagoon.world) return null;
  const shape = new THREE.Shape(lagoon.ring.map(([x, z]) => new THREE.Vector2(x!, -z!)));
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, lagoon.level, 0);
  const material = waterMaterial.clone();
  // The sea drops its depth beneath coastal land. This inland polygon already has a
  // measured shore, so keep it just above the basin on the legacy backend too.
  if (material instanceof THREE.ShaderMaterial && waterMaterial instanceof THREE.ShaderMaterial) {
    // Clone owns its depth bias, while clock, sky and day/night uniforms keep following
    // the sea. ShaderMaterial.clone() alone would freeze those uniform wrappers.
    material.uniforms = { ...waterMaterial.uniforms, uDepthDrop: { value: .005 } };
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = lagoon.id;
  mesh.matrixAutoUpdate = false;
  mesh.receiveShadow = true;
  return mesh;
}
