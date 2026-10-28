import type { SimState } from "../contract.ts";
import { dcos,dsin } from "../dmath.ts";
import type { Gadget } from "../combat-contract.ts";
import type { RobotBrainIntent } from "../robots/brain.ts";
import type { RuntimeActor } from "./runtime.ts";

export interface DeviceLure {id:number;kind:"speaker"|"parrots";x:number;z:number;stopRadius:number;goal:{x:number;z:number}|null;speed:number}
/** Active accepted robot sabotage stays atomic. A lure never deletes or replaces that intent. */
export function robotSabotageActive(state:Readonly<SimState>,actor:Readonly<RuntimeActor>,intent?:RobotBrainIntent):boolean {
  return (state.ext.combat?.attacks??[]).some(attack=>attack.attackerId===actor.id&&(attack.kind==="forced-update"||state.ext.robots?.actors[attack.targetId]?.firmware==="good"));
}
/** Current live gadget state is the authority; no old `device.lure` event can restart one. */
export function runtimeDeviceLure(state:Readonly<SimState>,actor:Readonly<RuntimeActor>,intent?:RobotBrainIntent):DeviceLure|null {
  if(state.version<21||actor.retired||actor.posted||actor.child||actor.mobilityAid||actor.posture==="seated"||actor.posture==="lying"||intent?.movement.kind==="flee"||robotSabotageActive(state,actor,intent))return null;
  const associate=actor.model==="associate",bad=actor.firmware==="bad"&&!actor.protected&&["footman","trundle","patrol","sign-spinner"].includes(actor.model);
  if(!associate&&!bad||(state.ext.combat?.targets[actor.id]?.phase??"active")!=="active"||(state.ext.combat?.pauseUntil??0)>state.tick)return null;
  const candidates=(state.ext.combat?.gadgets??[]).filter((g):g is Gadget&{kind:"speaker"|"parrots"}=>
    (g.kind==="speaker"||g.kind==="parrots")&&g.untilTick>state.tick&&state.players[g.ownerId]!==undefined&&
    (g.kind==="parrots"||bad&&g.targetId===actor.id)&&((g.x-actor.x)**2+(g.y-actor.y)**2+(g.z-actor.z)**2<=g.radius*g.radius))
    .sort((a,b)=>(a.x-actor.x)**2+(a.z-actor.z)**2-((b.x-actor.x)**2+(b.z-actor.z)**2)||a.id-b.id);
  const gadget=candidates[0];if(!gadget)return null;
  const dx=actor.x-gadget.x,dz=actor.z-gadget.z,distance=Math.sqrt(dx*dx+dz*dz),stopRadius=(gadget.kind==="parrots"?15:1.2)+actor.radius+.75;
  const ux=distance>1e-8?dx/distance:dsin(actor.heading),uz=distance>1e-8?dz/distance:-dcos(actor.heading);
  const goal=distance>=stopRadius&&distance-stopRadius<=.15?null:{x:gadget.x+ux*stopRadius,z:gadget.z+uz*stopRadius};
  return {id:gadget.id,kind:gadget.kind,x:gadget.x,z:gadget.z,stopRadius,goal,speed:goal?Math.min(1.6,Math.max(.4,Math.abs(distance-stopRadius))):0};
}
/** Route detours may not shortcut through the flock; an already-near actor only retreats. */
export function lureStepAllowed(lure:Readonly<DeviceLure>,from:{x:number;z:number},to:{x:number;z:number}):boolean {
  if(lure.kind!=="parrots")return true;
  const ax=from.x-lure.x,az=from.z-lure.z,bx=to.x-lure.x,bz=to.z-lure.z,start=ax*ax+az*az,end=bx*bx+bz*bz,dx=bx-ax,dz=bz-az,length=dx*dx+dz*dz,t=length>0?Math.max(0,Math.min(1,-(ax*dx+az*dz)/length)):0,min=(ax+t*dx)**2+(az+t*dz)**2;
  return start<lure.stopRadius*lure.stopRadius?end>=start&&min>=start-1e-8:min>=lure.stopRadius*lure.stopRadius-1e-8;
}
