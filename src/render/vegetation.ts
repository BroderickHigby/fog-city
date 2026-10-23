import * as THREE from 'three';
/** Original, instanced bay-laurel / Monterey-cypress silhouettes; no imported model licence. */
const random = (n:number):number => {let x=(n*1664525+1013904223)|0;x^=x>>>16;return (x>>>0)/4294967296;};
export function treeGeometry(conifer=false): THREE.BufferGeometry {
  const positions:number[]=[],normals:number[]=[],uvs:number[]=[],colors:number[]=[];
  const add=(g:THREE.BufferGeometry,m:THREE.Matrix4,color:THREE.Color)=>{
    const flat=g.index?g.toNonIndexed():g.clone();flat.applyMatrix4(m);
    const p=flat.getAttribute('position'),n=flat.getAttribute('normal'),u=flat.getAttribute('uv');
    for(let i=0;i<p.count;i++){positions.push(p.getX(i),p.getY(i),p.getZ(i));normals.push(n.getX(i),n.getY(i),n.getZ(i));uvs.push(u?.getX(i)??0,u?.getY(i)??0);colors.push(color.r,color.g,color.b);}
    flat.dispose();g.dispose();
  };
  const branch=(a:THREE.Vector3,b:THREE.Vector3,r:number)=>{const d=b.clone().sub(a),q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),d.clone().normalize());add(new THREE.CylinderGeometry(r*.35,r,d.length(),7),new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(.5),q,new THREE.Vector3(1,1,1)),new THREE.Color(0xffffff));};
  branch(new THREE.Vector3(),new THREE.Vector3(.025,.8,0),.028);
  for(let i=0;i<13;i++){const angle=i*2.399963,r=conifer?.14:.27,y=.35+i*.035;branch(new THREE.Vector3(0,y,0),new THREE.Vector3(Math.cos(angle)*r,y+.16,Math.sin(angle)*r),.009);}
  const barkEnd=positions.length/3;
  for(let i=0;i<150;i++){
    const a=i*2.399963, h=random(i+5), r=Math.sqrt(random(i+9))*(conifer?.23*(1-h*.55):.43);
    const y=conifer?.32+h*.67:.52+h*.42;
    const center=new THREE.Vector3(Math.cos(a)*r,y,Math.sin(a)*r);
    const size=conifer?.16:.21;
    const q=new THREE.Quaternion().setFromEuler(new THREE.Euler((random(i+200)-.5)*2,a,random(i+80)*1.5));
    const c=new THREE.Color().setHSL(.24+random(i+61)*.08,.28+random(i+72)*.22,.33+random(i+93)*.22);
    add(new THREE.PlaneGeometry(size*(.8+random(i+33)*.8),size),new THREE.Matrix4().compose(center,q,new THREE.Vector3(1,1,1)),c);
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.addGroup(0,barkEnd,0);g.addGroup(barkEnd,positions.length/3-barkEnd,1);g.computeBoundingBox();g.computeBoundingSphere();return g;
}
export function treeMaterials(): [THREE.MeshStandardMaterial,THREE.MeshStandardMaterial] {
  const bark=new THREE.MeshStandardMaterial({color:0x806e58,roughness:.97,vertexColors:true,name:'fc:tree-bark'});
  const leaf=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.85,vertexColors:true,side:THREE.DoubleSide,alphaTest:.45,name:'fc:tree-leaves'});
  if(typeof document!=='undefined'){
    const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const c=canvas.getContext('2d')!;
    for(let i=0;i<90;i++){const a=i*2.399963,r=Math.sqrt(random(i+90))*54,x=64+Math.cos(a)*r,y=64+Math.sin(a)*r;c.fillStyle=`rgba(255,255,255,${.78+random(i+20)*.22})`;c.beginPath();c.ellipse(x,y,4+random(i+8)*7,2+random(i+12)*3,a,0,Math.PI*2);c.fill();}
    leaf.map=new THREE.CanvasTexture(canvas);leaf.map.colorSpace=THREE.SRGBColorSpace;
  }
  return [bark,leaf];
}
