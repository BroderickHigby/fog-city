import * as THREE from "three";

/** Clone only finishes; `full=false` retains the standard material path on CPU renderers. */
export function dressPlayerCar(car: THREE.Object3D, paintColor: number | null, full = true): THREE.Material[] {
  const finishes = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  car.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const dress = (source: THREE.Material): THREE.Material => {
      const name = source.name.replace(/\.\d+$/, "");
      if (!(source as THREE.MeshStandardMaterial).isMeshStandardMaterial || !["paint", "glass", "tire", "rim", "trim_black"].includes(name)) return source;
      let material = finishes.get(source);
      if (material) return material;
      material = full && (name === "paint" || name === "glass") ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
      THREE.MeshStandardMaterial.prototype.copy.call(material, source as THREE.MeshStandardMaterial);
      if ((material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) material.defines = { STANDARD: "", PHYSICAL: "" };
      if (name === "paint") {
        if (paintColor !== null) material.color.setHex(paintColor);
        material.roughness = 0.26; material.metalness = 0.22;
        if (full) { (material as THREE.MeshPhysicalMaterial).clearcoat = 1; (material as THREE.MeshPhysicalMaterial).clearcoatRoughness = 0.11; }
      } else if (name === "glass") {
        material.color.setHex(0x455d70);
        material.metalness = 0.35; material.roughness = 0.11;
        if (full) { (material as THREE.MeshPhysicalMaterial).clearcoat = 1; (material as THREE.MeshPhysicalMaterial).clearcoatRoughness = 0.04; }
        material.envMapIntensity = 1.35;
      } else if (name === "rim") {
        material.roughness = 0.19; material.metalness = 0.9;
      } else if (name === "tire") {
        material.roughness = 0.94; material.metalness = 0;
      } else material.roughness = 0.65;
      finishes.set(source, material);
      return material;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(dress) : dress(mesh.material);
  });
  return [...finishes.values()];
}
