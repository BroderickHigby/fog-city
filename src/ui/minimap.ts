import { mapCoordinates, route } from "./navigation.ts";
import type { MapPoint, UiView } from "./types.ts";

const COLORS:Record<string,string>={water:"#73cff9",mission:"#ffd579",safehouse:"#aef0ba",bounty:"#f9a0a7",wash:"#b9c6ff",robot:"#ff8a79"};
export function drawMap(canvas:HTMLCanvasElement,view:UiView,size=180,heading=view.heading,radius=view.map?.radius??100):void {
  const context=canvas.getContext("2d");if(!context)return;
  if(canvas.width!==size){canvas.width=size;canvas.height=size;}
  const c=context,map=view.map,center={x:view.x,z:view.z};
  const point=(p:MapPoint)=>mapCoordinates(p,center,heading,radius,size);
  c.clearRect(0,0,size,size);c.fillStyle="#102129";c.fillRect(0,0,size,size);
  const nodes=new Map(map?.nodes.map(node=>[node.id,node]));
  c.lineCap="round";c.strokeStyle="#64777a";c.lineWidth=size/50;
  for(const edge of map?.edges??[]){
    const from=nodes.get(edge.from),to=nodes.get(edge.to);if(!from||!to)continue;
    const a=point(from),b=point(to);c.beginPath();c.moveTo(a.x,a.z);c.lineTo(b.x,b.z);c.stroke();
  }
  if(map?.waypoint){
    const path=route(map.nodes,map.edges,center,map.waypoint);c.strokeStyle="#a7efc5";c.lineWidth=size/70;c.beginPath();
    path.forEach((node,index)=>{const p=point(node);if(index)c.lineTo(p.x,p.z);else c.moveTo(p.x,p.z);});c.stroke();
    const p=point(map.waypoint);c.strokeStyle="#e9ffed";c.lineWidth=2;c.strokeRect(p.x-5,p.z-5,10,10);
  }
  for(const blip of map?.blips??[]){
    if(blip.kind==="robot"&&!blip.confirmed)continue;
    const p=point(blip);if(!Number.isFinite(p.x+p.z))continue;
    c.fillStyle=COLORS[blip.kind]??"#fff";c.beginPath();c.arc(p.x,p.z,4,0,Math.PI*2);c.fill();
  }
  c.save();c.translate(size/2,size/2);c.rotate(view.heading-heading);c.fillStyle="#fff";c.beginPath();c.moveTo(0,-8);c.lineTo(5,6);c.lineTo(0,3);c.lineTo(-5,6);c.closePath();c.fill();c.restore();
}
