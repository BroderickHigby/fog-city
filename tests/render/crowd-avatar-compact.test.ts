import { readFileSync } from "node:fs";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CROWD_FILES, CrowdHumans } from "../../src/render/crowd-humans.ts";
import { PlayerBodies } from "../../src/render/player-body.ts";

const bytes = async (path: string): Promise<Uint8Array> => new Uint8Array(readFileSync(new URL(`../../public/${path}`, import.meta.url)));
const owned: Array<{ dispose(): void }> = [];
beforeEach(() => {
  vi.stubGlobal("self", globalThis);
  // Actual GLB geometry/rig tests use decoded pixel arrays at the texture-loader seam.
  // Pixel preservation tests below exercise those real RGBA arrays, not flat appearance mocks.
  vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
    const texture = new THREE.DataTexture(new Uint8Array([255, 40, 10, 255, 12, 60, 255, 128, 20, 200, 30, 0, 250, 210, 180, 255]), 2, 2);
    const decoded = texture as unknown as THREE.Texture<HTMLImageElement>;
    queueMicrotask(() => loaded?.(decoded));
    return decoded;
  });
});
afterEach(() => { for (const item of owned.splice(0)) item.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("existing textured crowd characters in one draw", () => {
  it("reduces the real Rocketbox character's three primitives without changing its triangle count", async () => {
    const ordinary = await PlayerBodies.load(bytes, false, CROWD_FILES[0]!);
    const compact = await PlayerBodies.load(bytes, false, CROWD_FILES[0]!, { compactCrowd: true });
    owned.push(ordinary, compact);
    expect(ordinary.renderCost.drawCalls).toBe(3);
    expect(compact.renderCost.drawCalls).toBe(1);
    expect(compact.renderCost.triangles).toBe(ordinary.renderCost.triangles);
  });
});

import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { compactCrowdAvatar, type AvatarPixels } from "../../src/render/crowd-avatar-compact.ts";

function skins(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) out.push(object as THREE.SkinnedMesh); });
  return out;
}
function bufferOf(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute | THREE.InterleavedBuffer {
  return (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (attribute as THREE.InterleavedBufferAttribute).data : attribute as THREE.BufferAttribute;
}
function rawComponent(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, row: number, component: number): number {
  const interleaved = attribute as THREE.InterleavedBufferAttribute;
  return attribute.array[row * (interleaved.isInterleavedBufferAttribute ? interleaved.data.stride : attribute.itemSize) + (interleaved.isInterleavedBufferAttribute ? interleaved.offset : 0) + component]!;
}
const load = async (file = CROWD_FILES[0]!) => new GLTFLoader().parseAsync((await bytes(file)).slice().buffer as ArrayBuffer, "");
function pixel(texture: THREE.Texture, u: number, v: number): number[] {
  const image = texture.image as { width: number; height: number; data: Uint8Array | Float32Array };
  const x = Math.max(0, Math.min(image.width - 1, Math.floor(u * image.width))), y = Math.max(0, Math.min(image.height - 1, Math.floor(v * image.height)));
  return Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x + 1) * 4));
}
function textureOf(data: readonly number[], width: number, height: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array(data), width, height); texture.flipY = false; return texture;
}
function simple(): { root: THREE.Group; source: THREE.SkinnedMesh[] } {
  const root = new THREE.Group(), bone = new THREE.Bone(); root.add(bone); const skeleton = new THREE.Skeleton([bone]);
  const source = [.64, .56, .56].map((roughness, index) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([index, 0, 0, index + 1, 0, 0, index, 1, 0], 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,0,1], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([-.25, .25, 1.25, .25, .25, 1.25], 2));
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0], 4));
    geometry.setIndex([0,1,2]);
    const map = textureOf([20 + index,40,60,255,80 + index,100,120,128,140 + index,160,180,0,200 + index,220,240,255],2,2);
    const normalMap = index < 2 ? textureOf([128,128,255,255,140,110,250,255,120,130,240,255,128,128,255,255],2,2) : null;
    const material = new THREE.MeshStandardMaterial({ name: index === 2 ? "crowd_hair" : "crowd_part", map, normalMap, roughness, metalness: 0, side: THREE.DoubleSide, transparent: index === 2 });
    const mesh = new THREE.SkinnedMesh(geometry, material); mesh.name = "part" + index; root.add(mesh); mesh.bind(skeleton, new THREE.Matrix4()); return mesh;
  });
  return { root, source };
}

describe("compact prototype preservation", () => {
  it.each(CROWD_FILES)("%s keeps every vertex, triangle and bone in one unchanged authored character", async file => {
    const original = await PlayerBodies.load(bytes, false, file), compact = await PlayerBodies.load(bytes, false, file, { compactCrowd: true }); owned.push(original, compact);
    expect(compact.renderCost.drawCalls).toBe(1);
    expect(compact.renderCost.triangles).toBe(original.renderCost.triangles);
    original.begin(); original.add("a", 0, 0, 0, 0, 0, 0); original.end();
    compact.begin(); compact.add("a", 0, 0, 0, 0, 0, 0); compact.end();
    const originals = skins(original.rootOf("a")!), result = skins(compact.rootOf("a")!);
    expect(result).toHaveLength(1);
    const buffers=new Set(Object.values(result[0]!.geometry.attributes).map(bufferOf));
    expect(buffers.size).toBeLessThanOrEqual(8);
    for(const attribute of Object.values(result[0]!.geometry.attributes)){
      const packed=attribute as THREE.InterleavedBufferAttribute;
      expect(packed.isInterleavedBufferAttribute).toBe(true);
      expect(packed.offset*packed.array.BYTES_PER_ELEMENT%4).toBe(0);
      expect(packed.data.stride*packed.array.BYTES_PER_ELEMENT%4).toBe(0);
    }
    expect(result[0]!.skeleton.bones.map(b => b.name)).toEqual(originals[0]!.skeleton.bones.map(b => b.name));
    expect(result[0]!.geometry.getAttribute("position").count).toBe(originals.reduce((sum, mesh) => sum + mesh.geometry.getAttribute("position").count, 0));
    expect(Object.keys(result[0]!.geometry.attributes).sort()).toEqual([...new Set([...Object.keys(originals[0]!.geometry.attributes),"uv1","uv2"])].sort());
    for (const attr of Object.keys(originals[0]!.geometry.attributes).filter(name=>!["uv","uv1","uv2"].includes(name))) {
      const merged = result[0]!.geometry.getAttribute(attr); let at = 0;
      for (const mesh of originals) { const a = mesh.geometry.getAttribute(attr);
        expect(merged.itemSize).toBe(a.itemSize);expect(merged.normalized).toBe(a.normalized);expect(merged.array.constructor).toBe(a.array.constructor);
        expect((merged as THREE.BufferAttribute).gpuType).toBe((a as THREE.BufferAttribute).gpuType);
        for (let i = 0; i < a.count; i++, at++) for (let k = 0; k < a.itemSize; k++) {expect(merged.getComponent(at,k)).toBe(a.getComponent(i,k));expect(rawComponent(merged,at,k)).toBe(rawComponent(a,i,k));}
      }
    }
    // These three channels are deliberately atlas-derived before storage packing. Check every
    // value against that unchanged atlas layout, including files with pre-existing secondary UVs.
    const maps=originals.map(mesh=>mesh.material as THREE.MeshStandardMaterial),colors=maps.map(m=>m.map!.image as {width:number;height:number}),normals=maps.map(m=>m.normalMap?.image as {width:number;height:number}|undefined);
    const colorWidth=Math.max(...colors.map(image=>image.width))+32,colorHeight=colors.reduce((sum,image)=>sum+image.height+32,0),normalWidth=Math.max(...normals.map(image=>image?.width??1))+32,normalHeight=normals.reduce((sum,image)=>sum+(image?.height??1)+32,0);
    let colorTop=0,normalTop=0,row=0;
    for(let part=0;part<originals.length;part++){
      const oldUV=originals[part]!.geometry.getAttribute("uv"),color=colors[part]!,normal=normals[part];
      for(let i=0;i<oldUV.count;i++,row++){
        const expected={uv:[(16+oldUV.getX(i)*color.width)/colorWidth,(colorTop+16+oldUV.getY(i)*color.height)/colorHeight],uv1:[(16+(normal?oldUV.getX(i)*normal.width:.5))/normalWidth,(normalTop+16+(normal?oldUV.getY(i)*normal.height:.5))/normalHeight],uv2:[(part+.5)/originals.length,.5]};
        for(const name of ["uv","uv1","uv2"] as const){const a=result[0]!.geometry.getAttribute(name);expect(a.itemSize).toBe(2);expect(a.normalized).toBe(false);expect(a.array).toBeInstanceOf(Float32Array);for(let component=0;component<2;component++)expect(a.getComponent(row,component)).toBe(Math.fround(expected[name][component]!));}
      }
      colorTop+=color.height+32;normalTop+=(normal?.height??1)+32;
    }
    let vertexOffset=0,indexOffset=0;for(const mesh of originals){for(let i=0;i<mesh.geometry.index!.count;i++,indexOffset++)expect(result[0]!.geometry.index!.getX(indexOffset)).toBe(mesh.geometry.index!.getX(i)+vertexOffset);vertexOffset+=mesh.geometry.getAttribute("position").count;}
    expect(result[0]!.geometry.groups).toHaveLength(0);
  });

  it("keeps all actual deformed vertices and clip selection through walking/running/turning and support", async () => {
    const file = CROWD_FILES[6]!, original = await PlayerBodies.load(bytes, false, file), compact = await PlayerBodies.load(bytes, false, file, { compactCrowd: true }); owned.push(original, compact);
    original.setSupportHeight((x,y,z)=> y + .03 * Math.sin(x + z)); compact.setSupportHeight((x,y,z)=> y + .03 * Math.sin(x + z));
    for (const [speed,dt,heading] of [[0,.3,0],[1.39,.37,.2],[3.2,.14,.5],[5.8,.2,1],[1.3,.18,Math.PI]] as const) {
      for (const body of [original, compact]) { body.begin(); body.add("a", 2, 1, -3, heading, speed, dt); body.end(); body.rootOf("a")!.updateMatrixWorld(true); }
      expect(compact.rootOf("a")!.userData.motion).toBe(original.rootOf("a")!.userData.motion);
      const originals = skins(original.rootOf("a")!), result = skins(compact.rootOf("a")!)[0]!, p = new THREE.Vector3(), q = new THREE.Vector3(); let at = 0, max = 0;
      for (const mesh of originals) for (let i=0;i<mesh.geometry.getAttribute("position").count;i++,at++) {
        mesh.getVertexPosition(i,p).applyMatrix4(mesh.matrixWorld); result.getVertexPosition(at,q).applyMatrix4(result.matrixWorld); max=Math.max(max,p.distanceTo(q));
      }
      expect(max).toBeLessThan(1e-6);
    }
  });

  it("preserves map pixels, repeated UVs, hair alpha, flat hair normals and exact roughness regions", async () => {
    const {root,source} = simple(), sourceMaps = source.map(mesh => (mesh.material as THREE.MeshStandardMaterial).map!), sourceRough = source.map(mesh => (mesh.material as THREE.MeshStandardMaterial).roughness);
    const compact = await compactCrowdAvatar(root), material = compact.material as THREE.MeshStandardMaterial;
    owned.push({dispose(){compact.geometry.dispose();material.map!.dispose();material.normalMap!.dispose();material.roughnessMap!.dispose();material.dispose();compact.skeleton.dispose();}});
    expect(material.transparent).toBe(false); expect(material.alphaTest).toBe(.45);
    expect(material.map!.colorSpace).toBe(THREE.SRGBColorSpace);expect(material.normalMap!.channel).toBe(1);expect(material.roughnessMap!.channel).toBe(2);
    const coordinates = [[-.25,.25],[1.25,.25],[.25,1.25]];
    for(let part=0;part<3;part++)for(let i=0;i<3;i++){
      const index=part*3+i, old=coordinates[i]!, u=((old[0]!%1)+1)%1,v=((old[1]!%1)+1)%1, uv=compact.geometry.getAttribute("uv"), normal=compact.geometry.getAttribute("uv1"), rough=compact.geometry.getAttribute("uv2");
      expect(pixel(material.map!,uv.getX(index),uv.getY(index))).toEqual(pixel(sourceMaps[part]!,u,v));
      expect(pixel(material.roughnessMap!,rough.getX(index),rough.getY(index))[1]).toBeCloseTo(sourceRough[part]!,6);
      if(part===2)expect(pixel(material.normalMap!,normal.getX(index),normal.getY(index))).toEqual([128,128,255,255]);
    }
  });

  it("keeps normalized RGB, extra color and integer channels in four-byte-aligned shared storage", async () => {
    const {root,source}=simple();
    for(const mesh of source){
      mesh.geometry.setAttribute("color",new THREE.Uint8BufferAttribute([1,127,255,255,3,191,5,129,253],3,true));
      mesh.geometry.setAttribute("_color_1",new THREE.Uint8BufferAttribute([7,19,31,43,59,71,83,97,109,127,139,151],4,true));
      const ids=new THREE.Uint16BufferAttribute([0,79,65535,17,23,29,31,37,41],3);ids.gpuType=THREE.IntType;mesh.geometry.setAttribute("authoredIds",ids);
      const tags=new THREE.Uint16BufferAttribute([2,65535,11,13,47,53],2);tags.gpuType=THREE.IntType;mesh.geometry.setAttribute("authoredTags",tags);
      (mesh.material as THREE.MeshStandardMaterial).vertexColors=true;
    }
    const saved=source.map(mesh=>Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name,a])=>[name,{itemSize:a.itemSize,normalized:a.normalized,gpuType:(a as THREE.BufferAttribute).gpuType,type:a.array.constructor,raw:Array.from(a.array)}])));
    const compact=await compactCrowdAvatar(root),material=compact.material as THREE.MeshStandardMaterial;
    owned.push({dispose(){compact.geometry.dispose();material.map!.dispose();material.normalMap!.dispose();material.roughnessMap!.dispose();material.dispose();compact.skeleton.dispose();}});
    expect(new Set(Object.values(compact.geometry.attributes).map(bufferOf)).size).toBeLessThanOrEqual(8);
    expect(material.vertexColors).toBe(true);
    for(const name of ["color","_color_1","authoredIds","authoredTags"]){
      const a=compact.geometry.getAttribute(name) as THREE.InterleavedBufferAttribute;
      expect(a.isInterleavedBufferAttribute).toBe(true);expect(a.offset*a.array.BYTES_PER_ELEMENT%4).toBe(0);expect(a.data.stride*a.array.BYTES_PER_ELEMENT%4).toBe(0);
      let at=0;for(const part of saved){const before=part[name]!;expect(a.itemSize).toBe(before.itemSize);expect(a.normalized).toBe(before.normalized);expect((a as unknown as THREE.BufferAttribute).gpuType).toBe(before.gpuType);expect(a.array.constructor).toBe(before.type);
        for(let row=0;row<3;row++,at++)for(let component=0;component<a.itemSize;component++)expect(rawComponent(a,at,component)).toBe(before.raw[row*a.itemSize+component]);}
    }
    expect(bufferOf(compact.geometry.getAttribute("color"))).toBe(bufferOf(compact.geometry.getAttribute("_color_1")));
    expect(bufferOf(compact.geometry.getAttribute("authoredIds"))).toBe(bufferOf(compact.geometry.getAttribute("authoredTags")));
    expect(bufferOf(compact.geometry.getAttribute("authoredIds"))).not.toBe(bufferOf(compact.geometry.getAttribute("skinIndex")));
  });

  it("retires removed prototype resources once, while individual clones keep shared atlases alive", async () => {
    const gltf=await load(), old=skins(gltf.scene), oldGeometry=old.map(m=>vi.spyOn(m.geometry,"dispose")), oldMaterials=old.map(m=>vi.spyOn(m.material as THREE.Material,"dispose"));
    const compact=await compactCrowdAvatar(gltf.scene);for(const spy of [...oldGeometry,...oldMaterials])expect(spy).toHaveBeenCalledOnce();
    compact.geometry.dispose();for(const value of Object.values(compact.material))if(value instanceof THREE.Texture)value.dispose();(compact.material as THREE.Material).dispose();compact.skeleton.dispose();
    const humans=await PlayerBodies.load(bytes,false,CROWD_FILES[0]!,{compactCrowd:true});owned.push(humans);
    humans.begin();humans.add("a",0,0,0,0,0,0);humans.add("b",1,0,0,0,0,0);humans.end();
    const a=skins(humans.rootOf("a")!)[0]!,b=skins(humans.rootOf("b")!)[0]!;
    expect(a.geometry).toBe(b.geometry);expect(a.material).toBe(b.material);expect(a.skeleton).not.toBe(b.skeleton);
    const geo=vi.spyOn(a.geometry,"dispose"),mat=vi.spyOn(a.material as THREE.Material,"dispose"),map=vi.spyOn((a.material as THREE.MeshStandardMaterial).map!,"dispose"),skel=vi.spyOn(a.skeleton,"dispose");
    humans.remove(new Set(["b"]));expect(skel).toHaveBeenCalledOnce();expect(geo).not.toHaveBeenCalled();expect(mat).not.toHaveBeenCalled();expect(map).not.toHaveBeenCalled();
    humans.dispose();humans.dispose();expect(geo).toHaveBeenCalledOnce();expect(mat).toHaveBeenCalledOnce();expect(map).toHaveBeenCalledOnce();
  });

  it("leaves the original prototype intact when image decoding rejects asynchronously", async () => {
    const {root,source}=simple(), dispose=vi.spyOn(source[0]!.geometry,"dispose");
    let reject!:(error:Error)=>void;const pending=new Promise<AvatarPixels>((_resolve,no)=>{reject=no;});
    const result=compactCrowdAvatar(root,{readPixels:()=>pending});reject(new Error("image decode unavailable"));
    await expect(result).rejects.toThrow("image decode unavailable");expect(skins(root)).toEqual(source);expect(dispose).not.toHaveBeenCalled();
    for(const mesh of source){mesh.geometry.dispose();for(const value of Object.values(mesh.material))if(value instanceof THREE.Texture)value.dispose();(mesh.material as THREE.Material).dispose();}source[0]!.skeleton.dispose();
  });

  it("atomically rejects a future authored normal map that samples a secondary UV channel", async () => {
    const {root,source}=simple(),normal=(source[0]!.material as THREE.MeshStandardMaterial).normalMap!;normal.channel=1;
    const disposal=vi.spyOn(source[0]!.geometry,"dispose"),imageRead=vi.fn(async()=>({width:1,height:1,data:new Uint8Array([255,255,255,255])}));
    await expect(compactCrowdAvatar(root,{readPixels:imageRead})).rejects.toThrow("unsupported authored material layout");
    expect(imageRead).not.toHaveBeenCalled();expect(disposal).not.toHaveBeenCalled();expect(skins(root)).toEqual(source);expect(normal.channel).toBe(1);
    for(const mesh of source){mesh.geometry.dispose();for(const value of Object.values(mesh.material))if(value instanceof THREE.Texture)value.dispose();(mesh.material as THREE.Material).dispose();}source[0]!.skeleton.dispose();
  });
});


it("disposes an unadopted original prototype if image decoding cannot compact it", async () => {
  vi.mocked(THREE.TextureLoader.prototype.load).mockImplementation((_url, loaded) => {
    const texture = new THREE.Texture<HTMLImageElement>(); queueMicrotask(() => loaded?.(texture)); return texture;
  });
  const disposal=vi.spyOn(THREE.Texture.prototype,"dispose");
  await expect(PlayerBodies.load(bytes,false,CROWD_FILES[0]!,{compactCrowd:true})).rejects.toThrow("decoded texture image");
  expect(disposal).toHaveBeenCalledTimes(5);
});

it("releases compact atlas resources when its crowd owner was disposed before loading finished", async () => {
  const file=CROWD_FILES[0]!;let finish!:(value:Uint8Array)=>void;
  const pending=new Promise<Uint8Array>(resolve=>{finish=resolve;});
  const disposal=vi.spyOn(PlayerBodies.prototype,"dispose"),crowd=new CrowdHumans(path=>path===file?pending:bytes(path),false,[file]);
  crowd.dispose();finish(await bytes(file));
  await vi.waitFor(()=>expect(disposal).toHaveBeenCalledOnce(),{timeout:5000});
  expect((disposal.mock.contexts[0] as PlayerBodies).renderCost.drawCalls).toBe(1);
  expect(crowd.loaded).toBe(0);expect(crowd.group.children).toHaveLength(0);
});
