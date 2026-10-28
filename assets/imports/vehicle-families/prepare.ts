/** Deterministic CC0 Kenney import; no Blender or new dependencies. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { NodeIO, Document } from "@gltf-transform/core";
import { KHRTextureTransform, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptEncoder } from "meshoptimizer";
import { Matrix4, Vector3, Color, SRGBColorSpace } from "three";

const base = resolve(import.meta.dirname), repo = resolve(base,"../../..");
function rgbaPng(data: Uint8Array): {width:number;height:number;pixels:Uint8Array} {
  const b=Buffer.from(data),width=b.readUInt32BE(16),height=b.readUInt32BE(20);
  if(b[24]!==8||b[25]!==6||b[28]!==0)throw Error("Expected noninterlaced 8-bit RGBA PNG");
  const parts:Buffer[]=[];for(let p=8;p<b.length;){const n=b.readUInt32BE(p),type=b.toString("ascii",p+4,p+8);if(type==="IDAT")parts.push(b.subarray(p+8,p+8+n));p+=n+12;}
  const raw=inflateSync(Buffer.concat(parts)),pixels=new Uint8Array(width*height*4),stride=width*4;
  for(let y=0;y<height;y++)for(let x=0;x<stride;x++){
    const filter=raw[y*(stride+1)]!,value=raw[y*(stride+1)+1+x]!,left=x>=4?pixels[y*stride+x-4]!:0,up=y?pixels[(y-1)*stride+x]!:0,upperLeft=y&&x>=4?pixels[(y-1)*stride+x-4]!:0;
    let predictor=0;if(filter===1)predictor=left;else if(filter===2)predictor=up;else if(filter===3)predictor=Math.floor((left+up)/2);else if(filter===4){const p=left+up-upperLeft,a=Math.abs(p-left),bb=Math.abs(p-up),c=Math.abs(p-upperLeft);predictor=a<=bb&&a<=c?left:bb<=c?up:upperLeft;}else if(filter!==0)throw Error("Unknown PNG filter");
    pixels[y*stride+x]=(value+predictor)&255;
  }
  return {width,height,pixels};
}
const png=rgbaPng(readFileSync(join(base,"raw/selected/Textures/colormap.png")));
function pixel(uv: number[]): number[] {const x=Math.max(0,Math.min(png.width-1,Math.floor(uv[0]!*png.width))),y=Math.max(0,Math.min(png.height-1,Math.floor(uv[1]!*png.height))),i=(y*png.width+x)*4;return [png.pixels[i]!,png.pixels[i+1]!,png.pixels[i+2]!];}
const inputs=[{id:"compact-hatch",source:"hatchback-sports",length:3.78,width:1.88,height:1.49,wb:2.42,radius:.30,wheelWidth:.18,profile:"light-ice"},
 {id:"sedan",source:"sedan",length:4.30,width:1.96,height:1.48,wb:2.66,radius:.34,wheelWidth:.215,profile:"light-ice"},
 {id:"utility-suv",source:"suv",length:4.48,width:1.98,height:1.77,wb:2.76,radius:.365,wheelWidth:.235,profile:"utility-ice"},
 {id:"short-pickup",source:"truck",length:4.58,width:1.98,height:1.72,wb:2.88,radius:.355,wheelWidth:.225,profile:"utility-ice"},
 {id:"cargo-van",source:"van",length:4.58,width:2,height:2.06,wb:2.85,radius:.34,wheelWidth:.215,profile:"utility-ice"}];
const reader=new NodeIO().registerExtensions([KHRTextureTransform]);
for(const input of inputs){
 const doc=await reader.read(join(base,"raw/selected",input.source+".glb")),counts=new Map<string,number>();
 for(const node of doc.getRoot().listNodes())if(node.getName()==="body")for(const p of node.getMesh()!.listPrimitives()){
  const uv=p.getAttribute("TEXCOORD_0")!,idx=p.getIndices()!;
  for(let k=0;k<idx.getCount();k+=3){const rgb=pixel(uv.getElement(idx.getScalar(k),[0,0]));const key=rgb.join(",");counts.set(key,(counts.get(key)??0)+1);}
 }
 console.log(JSON.stringify({id:input.id,palette:[...counts.entries()].sort((a,b)=>b[1]-a[1])}));
}
if(!process.argv.includes("--prepare"))process.exit(0);
// Import transformation/output stage follows after metadata inspection.
await MeshoptEncoder.ready;
const output=join(repo,"public/models/vehicles");mkdirSync(output,{recursive:true});
const prepared=[];
for(const input of inputs){
 const sourcePath=join(base,"raw/selected",input.source+".glb"),sourceBytes=readFileSync(sourcePath),doc=await reader.read(sourcePath);
 const originals=doc.getRoot().listNodes().filter(n=>n.getMesh());
 const fronts=originals.filter(n=>/^wheel-front-(left|right)$/.test(n.getName()));
 const backs=originals.filter(n=>/^wheel-back-(left|right)$/.test(n.getName()));
 if(fronts.length!==2||backs.length!==2)throw Error("Four separate wheels required");
 const center=(node:typeof originals[number]):Vector3=>{
  const points:Vector3[]=[];const matrix=new Matrix4().fromArray(node.getWorldMatrix());
  for(const primitive of node.getMesh()!.listPrimitives()){const positions=primitive.getAttribute("POSITION")!;for(let i=0;i<positions.getCount();i++)points.push(new Vector3().fromArray(positions.getElement(i,[0,0,0])).applyMatrix4(matrix));}
  const min=new Vector3(Infinity,Infinity,Infinity),max=new Vector3(-Infinity,-Infinity,-Infinity);for(const p of points){min.min(p);max.max(p);}return min.add(max).multiplyScalar(.5);
 };
 const frontSign=Math.sign(fronts.reduce((a,n)=>a+center(n).z,0)-backs.reduce((a,n)=>a+center(n).z,0));
 const axis=new Matrix4().makeRotationY(frontSign>0?Math.PI:0);
 const bounds={min:new Vector3(Infinity,Infinity,Infinity),max:new Vector3(-Infinity,-Infinity,-Infinity)};
 for(const node of originals){const matrix=axis.clone().multiply(new Matrix4().fromArray(node.getWorldMatrix()));for(const primitive of node.getMesh()!.listPrimitives()){const positions=primitive.getAttribute("POSITION")!;for(let k=0;k<positions.getCount();k++){const p=new Vector3().fromArray(positions.getElement(k,[0,0,0])).applyMatrix4(matrix);bounds.min.min(p);bounds.max.max(p);}}}
 const front=fronts.reduce((a,n)=>a+center(n).applyMatrix4(axis).z,0)/2,back=backs.reduce((a,n)=>a+center(n).applyMatrix4(axis).z,0)/2;
 const sourceRadius=.3,ratio=input.radius/sourceRadius,band=sourceRadius*1.07;
 const zKnots=[[bounds.min.z,-input.length/2],[front-band,-input.wb/2-band*ratio],[front+band,-input.wb/2+band*ratio],[back-band,input.wb/2-band*ratio],[back+band,input.wb/2+band*ratio],[bounds.max.z,input.length/2]];
 const bodyWidths:Record<string,number>={"compact-hatch":1.72,sedan:1.80,"utility-suv":1.88,"short-pickup":1.88,"cargo-van":1.90};
 const bodyWidth=bodyWidths[input.id]!;
 function warp(v:number,knots:number[][]):[number,number]{for(let j=0;j<knots.length-1;j++){const a=knots[j]!,b=knots[j+1]!;if(v<=b[0]!||j===knots.length-2){const slope=(b[1]!-a[1]!)/(b[0]!-a[0]!);return [a[1]!+(v-a[0]!)*slope,slope];}}throw Error("Invalid warp");}
 const xOuter=Math.max(Math.abs(bounds.min.x),Math.abs(bounds.max.x));
 const xKnots=[[0,0],[.6,bodyWidth/2],[xOuter,input.width/2]];
 const yKnots=[[0,0],[sourceRadius*2.1,input.radius*2.1],[bounds.max.y,input.height]];
 const out=new Document(),buffer=out.createBuffer(),scene=out.createScene(),root=out.createNode(input.id).setExtras({fcFamily:input.id,source:"Kenney Car Kit 3.1",licence:"CC0-1.0",front:"-Z"});scene.addChild(root);
 const materials=new Map<string,ReturnType<typeof out.createMaterial>>();
 function material(key:string){let m=materials.get(key);if(!m){const parts=key.split(":");const kind=parts[0]!,rr=parts[1],gg=parts[2],bb=parts[3]; const rgb=kind==="paint"?[1,1,1]:new Color().setRGB(Number(rr)/255,Number(gg)/255,Number(bb)/255,SRGBColorSpace).toArray();m=out.createMaterial(kind==="paint"?"paint":`${kind}.${String(materials.size).padStart(3,"0")}`).setBaseColorFactor([rgb[0]!,rgb[1]!,rgb[2]!,1]).setDoubleSided(false).setMetallicFactor(kind==="metal"?.7:kind==="paint"?.15:0).setRoughnessFactor(kind==="glass"?.15:kind==="paint"?.32:.75);if(kind.startsWith("light_"))m.setEmissiveFactor(kind==="light_headlight"?[.65,.6,.45]:[.5,.015,.01]);materials.set(key,m);}return m;}
 let tris=0;const wheels:Record<string,{radiusM:number;widthM:number;hub:number[]}>={};
 for(const node of originals){
  const wheel=/^wheel-(front|back)-(left|right)$/.test(node.getName());
  const matrix=axis.clone().multiply(new Matrix4().fromArray(node.getWorldMatrix()));
  const originalCenter=center(node).applyMatrix4(axis),isFront=node.getName().startsWith("wheel-front"),isLeft=originalCenter.x<0;
  const hub=new Vector3((isLeft?-1:1)*(bodyWidth/2-input.wheelWidth/2-.02),input.radius,isFront?-input.wb/2:input.wb/2);
  const name=wheel?`wheel_${isFront?"F":"R"}${isLeft?"L":"R"}`:node.getName();
  const target=out.createNode(name),mesh=out.createMesh(name);target.setMesh(mesh);root.addChild(target);
  if(wheel){target.setTranslation(hub.toArray()).setExtras({wheel:name.slice(6),radius:input.radius,spinAxis:[1,0,0],steer:isFront});wheels[name]={radiusM:input.radius,widthM:input.wheelWidth,hub:hub.toArray()};}
  const groups=new Map<string,{p:number[];n:number[];c:number[]}>();
  for(const primitive of node.getMesh()!.listPrimitives()){
   const positions=primitive.getAttribute("POSITION")!,normals=primitive.getAttribute("NORMAL")!,uv=primitive.getAttribute("TEXCOORD_0")!,idx=primitive.getIndices()!;
   for(let k=0;k<idx.getCount();k+=3){
    const color=pixel(uv.getElement(idx.getScalar(k),[0,0]));const [r,g,b]=color as [number,number,number];
    const chroma=Math.max(r,g,b)-Math.min(r,g,b);
    const painted=!wheel&&((g>r+30&&g>b+15)||(b>r+55&&b>g+30)||(r>g+80&&g>85&&b<100));
    const kind=painted?"paint":r>180&&g<85&&b<100?"light_taillight":r>240&&g>180&&b<100?"light_headlight":chroma<35&&r<80?"trim":wheel?"metal":b>r+12&&r<170?"glass":"metal";
    const linear=new Color().setRGB(r/255,g/255,b/255,SRGBColorSpace);
    const key=painted?"paint":[kind,...color.map(x=>Math.min(255,Math.round(x/16)*16))].join(":"); let group=groups.get(key);if(!group){group={p:[],n:[],c:[]};groups.set(key,group);}
    for(let j=0;j<3;j++){
     const i=idx.getScalar(k+j),p=new Vector3().fromArray(positions.getElement(i,[0,0,0])).applyMatrix4(matrix),n=new Vector3().fromArray(normals.getElement(i,[0,0,0])).transformDirection(matrix);
     let dx:number,dy:number,dz:number;
     if(wheel){p.sub(originalCenter);dx=input.wheelWidth/.35;dy=ratio;dz=ratio;p.set(p.x*dx,p.y*dy,p.z*dz);}
     else {const sx=Math.sign(p.x)||1,x=warp(Math.abs(p.x),xKnots),y=warp(p.y,yKnots),z=warp(p.z,zKnots);p.set(sx*x[0],y[0],z[0]);dx=x[1];dy=y[1];dz=z[1];}
     n.set(n.x/dx,n.y/dy,n.z/dz).normalize();group.p.push(...p.toArray());group.n.push(...n.toArray());group.c.push(1,1,1);
    }
    tris++;
   }
  }
  for(const [kind,g]of groups){const count=g.p.length/3,accessor=(type:"VEC3"|"SCALAR",data:Float32Array|Uint16Array|Uint32Array)=>out.createAccessor().setType(type).setArray(data).setBuffer(buffer);
   const indices=count>65535?new Uint32Array(count):new Uint16Array(count);for(let i=0;i<count;i++)indices[i]=i;
   mesh.addPrimitive(out.createPrimitive().setAttribute("POSITION",accessor("VEC3",new Float32Array(g.p))).setAttribute("NORMAL",accessor("VEC3",new Float32Array(g.n))).setAttribute("COLOR_0",accessor("VEC3",new Float32Array(g.c))).setIndices(accessor("SCALAR",indices)).setMaterial(material(kind)));
  }
 }
 const io=new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({"meshopt.encoder":MeshoptEncoder});out.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
 const bytes=await io.writeBinary(out),path=join(output,input.id+".glb");writeFileSync(path,bytes);
 const record={id:input.id,sourceEntry:`Models/GLB format/${input.source}.glb`,sourceSha256:createHash("sha256").update(sourceBytes).digest("hex"),url:`models/vehicles/${input.id}.glb`,sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,triangles:tris,lengthM:input.length,bodyWidthM:bodyWidth,totalWidthM:input.width,heightM:input.height,wheelbaseM:input.wb,wheelRadiusM:input.radius,wheelWidthM:input.wheelWidth,trackM:bodyWidth-input.wheelWidth-.04,wheels,audioProfile:input.profile,paintMaterial:"paint",far:{method:"runtime-voxel",cellM:.20},visualApproved:false};
 if(tris>3500||bytes.length>300000)throw Error(`Output budget exceeded: ${input.id}`);prepared.push(record);console.log(JSON.stringify(record));
}
writeFileSync(join(base,"prepared-manifest.json"),JSON.stringify({schema:1,author:"Kenney",licence:"CC0-1.0",source:"https://kenney.nl/assets/car-kit",transform:"prepare.ts: front/wheel hub normalization; piecewise wheel-well-preserving proportions; colormap quantized to linear material colors compatible with packed agent surfaces; paint separated; meshopt lossless compression",models:prepared},null,2)+"\n");
