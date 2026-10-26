import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { CAR_PALETTES, carAppearance, paintCar } from "../../src/render/car-appearance.ts";
import { AGENT_SPEC, ROBOTAXI_BODY } from "../../src/sim/agents.ts";
import { civilianModelScale } from "../../src/render/agent-layer.ts";
import { surfaceOf, packGeometry, packedMaterial } from "../../src/render/agent-packing.ts";

async function load(file: string) {
  const bytes=readFileSync(new URL(`../../public/models/${file}`,import.meta.url));
  const data=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
  return new Promise<THREE.Object3D>((resolve,reject)=>new GLTFLoader().parse(data,"",g=>resolve(g.scene),reject));
}

describe("original vehicle paint and artwork",()=>{
  it("gives twelve genuinely different paint palettes and three original wrap shapes",()=>{
    expect(new Set(CAR_PALETTES.map(([paint])=>paint)).size).toBe(12);
    expect(new Set(Array.from({length:12},(_,id)=>carAppearance(id,true).style))).toEqual(new Set([1,2,3]));
    expect(carAppearance(7,true)).toBe(carAppearance(7,true));
  });
  it("paints the actual civilian and robotaxi GLBs without touching glass, wheels, lamps or geometry",async()=>{
    for(const file of ["civilian-car.glb","robotaxi.glb"]){
      const model=await load(file),before=new Map<THREE.Mesh,{geometry:THREE.BufferGeometry;material:THREE.Material}>();
      model.traverse(o=>{const mesh=o as THREE.Mesh;if(mesh.isMesh)before.set(mesh,{geometry:mesh.geometry,material:mesh.material as THREE.Material});});
      if(file === "civilian-car.glb") {
        const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3());
        const scale=civilianModelScale({width:size.x,length:size.z});
        size.multiplyScalar(scale);
        expect(size.x).toBeLessThanOrEqual(ROBOTAXI_BODY.halfWidth*2);
        expect(size.z).toBeLessThanOrEqual(ROBOTAXI_BODY.halfLength*2);
        expect(size.x).toBeLessThanOrEqual(AGENT_SPEC.robotaxi.halfWidth*2);
        expect(size.z).toBeLessThanOrEqual(AGENT_SPEC.robotaxi.halfLength*2);
      }
      const appearance=carAppearance(2,true),owned=paintCar(model,appearance);
      expect(owned.length,file).toBeGreaterThan(0);
      for(const [mesh,old] of before){
        expect(mesh.geometry).toBe(old.geometry);
        const paint=/^paint(?:_|\.|$)/.test(old.material.name);
        if(!paint) expect(mesh.material,old.material.name).toBe(old.material);
        else {
          const m=mesh.material as THREE.MeshStandardMaterial;
          expect(m).not.toBe(old.material);expect(m.color.equals(appearance.paint)).toBe(true);
          const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
          m.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms,{} as THREE.WebGLRenderer);
          expect(shader.fragmentShader).toContain("fcCarArt(vFcCarPosition,fcCarStyle)");
          expect(shader.uniforms).toHaveProperty("fcCarAccent");
        }
      }
      for(const material of owned) material.dispose();
    }
  });
  it("marks only packed vehicle paint and keeps wheel animation in one instanced shader",()=>{
    for(const name of ["paint","paint_white","glass","sensor_black","tire","light_headlight"]){
      const source=new THREE.MeshStandardMaterial({name}),surface=surfaceOf(source);
      const geometry=packGeometry(new THREE.BoxGeometry(1,1,1),surface,null,false);
      expect(geometry.getAttribute("fcPaint").getX(0)).toBe(name.startsWith("paint")?1:0);
      geometry.dispose();source.dispose();
    }
    const material=packedMaterial(false,true),shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
    material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms,{} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("fcCarMotion.x");
    expect(shader.fragmentShader).toContain("if (vFcPaint > 0.5)");
    material.dispose();
  });
});
