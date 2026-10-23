import { Vector3, type Camera } from 'three';
import type { SimState } from '../sim/contract.ts';
import { campaignOf } from '../sim/missions/runtime.ts';
import { combatOf } from '../sim/combat/system.ts';
/** Read-only combat feedback: no flashes, shake or hidden firmware disclosure. */
export class CombatFeedback {
 private visible:(a:{x:number;z:number},b:{x:number;z:number})=>boolean;
 private root=document.createElement('div');private label=document.createElement('div');private bar=document.createElement('progress');private point=new Vector3();private mark=document.createElement('span');private lastHit=-1000;
 constructor(visible:(a:{x:number;z:number},b:{x:number;z:number})=>boolean=()=>true){this.visible=visible;const style=document.createElement('style');style.textContent=`#combat-feedback{position:fixed;z-index:3;pointer-events:none;transform:translate(-50%,-50%);text-align:center;color:#effff7;font:12px system-ui;text-shadow:0 1px 5px #000}#combat-feedback .aim-ring{display:block;width:15px;height:15px;border:1px solid #e4fff0dd;border-radius:50%;margin:auto auto 12px;box-shadow:0 0 0 1px #0007}#combat-feedback progress{display:block;width:130px;height:5px;accent-color:#cc9d62;margin:6px auto}#combat-feedback .hit{position:absolute;top:-8px;left:50%;transform:translateX(-50%);font-size:26px;color:#b7eed8}`;document.head.append(style);this.root.id='combat-feedback';this.root.setAttribute('aria-hidden','true');const ring=document.createElement('span');ring.className='aim-ring';this.mark.className='hit';this.mark.textContent='×';this.bar.max=1;this.root.append(ring,this.mark,this.label,this.bar);document.body.append(this.root);}
 update(state:SimState,id:string,camera:Camera,yaw:number,pitch:number):void{
  const player=state.players[id],foot=player?.mode==='foot'?player.foot:null;this.root.hidden=!foot;if(!foot)return;
  this.point.set(foot.x+Math.sin(yaw)*30,foot.y+1.2+Math.tan(pitch)*30,foot.z-Math.cos(yaw)*30).project(camera);
  this.root.style.left=`${(this.point.x*.5+.5)*innerWidth}px`;this.root.style.top=`${(-this.point.y*.5+.5)*innerHeight}px`;
  const combat=combatOf(state);const target=Object.values(campaignOf(state)?.actors??{}).filter(a=>{const dx=a.x-foot.x,dz=a.z-foot.z,d=Math.hypot(dx,dz);return d<=30&&d>0&&this.visible(foot,a)&&(dx*Math.sin(yaw)-dz*Math.cos(yaw))/d>.985;}).sort((a,b)=>Math.hypot(a.x-foot.x,a.z-foot.z)-Math.hypot(b.x-foot.x,b.z-foot.z))[0];
  const scan=combat?.players[id]?.scan;this.label.textContent=target?`${scan?.targetId===target.id?`${scan.bad?'Flagged':'Clear'} · ${scan.confidence}%`:'Robot'} · ${Math.round(Math.hypot(target.x-foot.x,target.z-foot.z))} m`:'';
  const rust=target?combat?.targets[target.id]?.rust??0:0;this.bar.hidden=rust<=0;this.bar.value=rust;
  if(combat?.events.some(e=>e.sourceId===id&&e.kind==='projectile.ended'&&e.detail==='actor'&&combat.targets[e.targetId]?.lastWaterTick===state.tick))this.lastHit=state.tick;
  this.mark.style.opacity=String(Math.max(0,1-(state.tick-this.lastHit)/14));
 }
}
