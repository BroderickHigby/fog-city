import type { RoadGraph } from '../render/types.ts';
import type { SimState } from '../sim/contract.ts';
import { campaignOf, placePosition, stepOf } from '../sim/missions/runtime.ts';
/** North-up street map from the same SF road graph as driving, not a decorative image. */
export class Minimap {
  private canvas=document.createElement('canvas');private context:CanvasRenderingContext2D;private roads:RoadGraph|null;private tick=-1;private bucket='';private nearby:RoadGraph['edges']=[];
  constructor(roads:RoadGraph|null){this.roads=roads;this.canvas.width=this.canvas.height=400;this.canvas.id='city-map';this.canvas.setAttribute('aria-label','Nearby San Francisco streets and mission destination');this.context=this.canvas.getContext('2d')!;Object.assign(this.canvas.style,{position:'fixed',left:'28px',bottom:'25px',width:'178px',height:'178px',borderRadius:'50%',border:'2px solid #7bad9b99',boxShadow:'0 6px 30px #0006',zIndex:'3'});document.body.append(this.canvas);}
  update(state:SimState,id:string):void{
    if(state.tick-this.tick<10&&state.tick>=this.tick)return;this.tick=state.tick;const p=state.players[id];if(!p)return;const b=p.mode==='foot'?p.foot!:p.car;
    const bucket=`${Math.floor(b.x/250)}:${Math.floor(b.z/250)}`;if(bucket!==this.bucket){this.bucket=bucket;this.nearby=this.roads?.edges.filter(e=>e.points.some(v=>Math.abs(v[0]-b.x)<800&&Math.abs(v[1]-b.z)<800))??[];}
    const c=this.context;c.fillStyle='#172d32';c.fillRect(0,0,400,400);const scale=.4;
    c.strokeStyle='#506669';c.lineCap='round';c.lineJoin='round';for(const e of this.nearby){c.lineWidth=e.kind==='freeway'?6:3;c.beginPath();e.points.forEach(([x,z],i)=>{const px=200+(x-b.x)*scale,pz=200+(z-b.z)*scale;if(i)c.lineTo(px,pz);else c.moveTo(px,pz);});c.stroke();}
    const r=campaignOf(state)?.players[id],s=r?stepOf(r):undefined;
    const goal=s?.type==='goto'?placePosition(s.target):s?.type==='trigger'?placePosition(s.event.place):s?.type==='objective'?Object.values(campaignOf(state)?.actors??{}).find(a=>a.owner===id&&a.binding===s.objective.actor):undefined;
    if(goal){let x=(goal.x-b.x)*scale,z=(goal.z-b.z)*scale;const d=Math.hypot(x,z);if(d>173){x*=173/d;z*=173/d;}c.fillStyle='#f4d38d';c.beginPath();c.arc(200+x,200+z,10,0,Math.PI*2);c.fill();}
    c.save();c.translate(200,200);c.rotate(b.heading);c.fillStyle='#b3ffe0';c.strokeStyle='#0d2720';c.lineWidth=3;c.beginPath();c.moveTo(0,-15);c.lineTo(10,11);c.lineTo(0,6);c.lineTo(-10,11);c.closePath();c.fill();c.stroke();c.restore();c.fillStyle='#c7e4db';c.font='bold 20px sans-serif';c.fillText('N',191,30);
  }
}
