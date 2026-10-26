import { mapCoordinates } from "./navigation.ts";
import { atlasFor, MAP_COLORS, paintAtlas, routeSegments, type MapAtlas } from "./map-atlas.ts";
import type { MapPoint, UiView } from "./types.ts";

const COLORS:Record<string,string>={water:"#73cff9",mission:"#ffd579",safehouse:"#aef0ba",bounty:"#f9a0a7",wash:"#b9c6ff",robot:"#ff8a79"};
const MAX_CACHE_SIDE=1024;
type Surface=HTMLCanvasElement|OffscreenCanvas;
interface Cache { atlas:MapAtlas;surface:Surface;center:MapPoint;radius:number;viewRadius:number;size:number;ratio:number;paints:number }
const backgrounds=new WeakMap<HTMLCanvasElement,Cache>();
/** Small read-only diagnostics for cache/budget tests and the local QA harness. */
export function mapCacheInfo(canvas:HTMLCanvasElement):Readonly<{paints:number;width:number;height:number;features:number}>|null {const c=backgrounds.get(canvas);return c?{paints:c.paints,width:c.surface.width,height:c.surface.height,features:c.atlas.features}:null;}
export function releaseMapCache(canvas:HTMLCanvasElement):void {const c=backgrounds.get(canvas);if(c){c.surface.width=1;c.surface.height=1;backgrounds.delete(canvas);}}
export function mapScale(radius:number,size:number):{metres:number;pixels:number;label:string} {
  const target=2*radius*.24,base=10**Math.floor(Math.log10(Math.max(1,target))),metres=[1,2,5,10].map(n=>n*base).filter(n=>n<=target).at(-1)??base;
  return{metres,pixels:metres*size/(2*radius),label:metres>=1000?`${metres/1000} km`:`${metres} m`};
}
function background(canvas:HTMLCanvasElement,c:CanvasRenderingContext2D,atlas:MapAtlas,center:MapPoint,radius:number,size:number,ratio:number,heading:number):void {
  if(heading!==0){paintAtlas(c,atlas,center,radius,size,1,heading);return;}
  const old=backgrounds.get(canvas);
  let cache=old;
  const valid=cache&&cache.atlas===atlas&&cache.viewRadius===radius&&cache.size===size&&cache.ratio===ratio
    &&Math.abs(center.x-cache.center.x)<=cache.radius-radius&&Math.abs(center.z-cache.center.z)<=cache.radius-radius;
  if(!valid){
    cache=undefined;
    const physical=Math.round(size*ratio),side=Math.min(MAX_CACHE_SIDE,physical*2),overscan=side/physical,cacheRadius=radius*overscan;
    let surface:Surface|null=null;
    if(typeof OffscreenCanvas!=="undefined")surface=new OffscreenCanvas(side,side);
    else if(canvas.ownerDocument)surface=canvas.ownerDocument.createElement("canvas");
    if(surface){surface.width=side;surface.height=side;const ctx=surface.getContext("2d") as CanvasRenderingContext2D|null;
      if(ctx){const quantum=Math.max(1,(cacheRadius-radius)/2),snapped=cacheRadius-radius<1?{...center}:{x:Math.round(center.x/quantum)*quantum,z:Math.round(center.z/quantum)*quantum};paintAtlas(ctx,atlas,snapped,cacheRadius,side,ratio);cache={atlas,surface,center:snapped,radius:cacheRadius,viewRadius:radius,size,ratio,paints:(old?.paints??0)+1};if(old){old.surface.width=1;old.surface.height=1;}backgrounds.set(canvas,cache);}
    }
  }
  if(!cache||cache.atlas!==atlas||typeof c.drawImage!=="function"){paintAtlas(c,atlas,center,radius,size);return;}
  const physical=Math.round(size*ratio),scale=physical/(2*radius),x=cache.surface.width/2+(center.x-cache.center.x)*scale-physical/2,z=cache.surface.height/2+(center.z-cache.center.z)*scale-physical/2;
  c.drawImage(cache.surface,x,z,physical,physical,0,0,size,size);
}
/** SF stays north-up by default; only the actual player arrow rotates. The phone can pan its center. */
export function drawMap(canvas:HTMLCanvasElement,view:UiView,size=202,heading=0,radius=view.map?.radius??170,center:MapPoint={x:view.x,z:view.z}):void {
  const context=canvas.getContext("2d");if(!context)return;
  radius=Math.max(20,Math.min(6000,Number.isFinite(radius)?radius:170));size=Math.max(80,Math.min(600,Math.round(size)));
  const ratio=Math.max(1,Math.min(2,MAX_CACHE_SIDE/size,canvas.ownerDocument?.defaultView?.devicePixelRatio??1)),physical=Math.round(size*ratio);
  if(canvas.width!==physical||canvas.height!==physical){canvas.width=physical;canvas.height=physical;}
  const c=context,map=view.map,point=(p:MapPoint)=>mapCoordinates(p,center,heading,radius,size);
  c.setTransform?.(ratio,0,0,ratio,0,0);c.clearRect(0,0,size,size);background(canvas,c,atlasFor(map),center,radius,size,ratio,heading);
  if(map?.waypoint){
    const segments=routeSegments(map,{x:view.x,z:view.z},map.waypoint);c.lineCap="round";c.lineJoin="round";
    c.beginPath();let started=false;
    for(const segment of segments){const pts=segment.points;for(let i=0;i<pts.length;i++){const raw=pts[segment.reversed?pts.length-1-i:i]!,p=point({x:raw[0],z:raw[1]});if(started)c.lineTo(p.x,p.z);else{c.moveTo(p.x,p.z);started=true;}}}
    c.strokeStyle="#191b19dd";c.lineWidth=7;c.stroke();c.strokeStyle=MAP_COLORS.route;c.lineWidth=3.5;c.stroke();
    const p=point(map.waypoint);if(p.x>=-8&&p.x<=size+8&&p.z>=-8&&p.z<=size+8){c.fillStyle=MAP_COLORS.route;c.strokeStyle="#2a2412";c.lineWidth=2;c.beginPath();c.arc(p.x,p.z,4.5,0,Math.PI*2);c.fill();c.stroke();}
  }
  for(const blip of map?.blips??[]){
    if(blip.kind==="robot"&&!blip.confirmed)continue;
    const p=point(blip);if(!Number.isFinite(p.x+p.z)||p.x<3||p.x>size-3||p.z<3||p.z>size-3)continue;
    c.fillStyle=COLORS[blip.kind]??"#fff";c.strokeStyle="#111b21";c.lineWidth=1.5;c.beginPath();c.arc(p.x,p.z,3.6,0,Math.PI*2);c.fill();c.stroke();
  }
  const own=point({x:view.x,z:view.z});
  if(own.x>=-8&&own.x<=size+8&&own.z>=-8&&own.z<=size+8){c.save();c.translate(own.x,own.z);c.rotate(view.heading-heading);c.fillStyle="#f8fcff";c.strokeStyle="#111820";c.lineWidth=2.5;c.beginPath();c.moveTo(0,-8);c.lineTo(5.5,6);c.lineTo(0,3);c.lineTo(-5.5,6);c.closePath();c.stroke();c.fill();c.restore();}
  if(typeof c.fillText==="function"){
    c.fillStyle="#0b1219cf";c.fillRect(size-31,5,25,25);c.font="700 12px system-ui";c.textAlign="center";c.textBaseline="middle";c.fillStyle="#eaf3fb";c.fillText("N",size-18,17);
    const ruler=mapScale(radius,size),end=size-11,start=end-ruler.pixels,y=size-12;c.strokeStyle="#e1e8ed";c.lineWidth=1.5;c.beginPath();c.moveTo(start,y-4);c.lineTo(start,y);c.lineTo(end,y);c.lineTo(end,y-4);c.stroke();c.font="600 9px system-ui";c.textAlign="center";c.fillStyle="#d4e0e8";c.fillText(ruler.label,(start+end)/2,y-9);
  }
}
