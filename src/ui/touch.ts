import type { InputController, VirtualAction } from "../input/controller.ts";
import type { UiCopy } from "./types.ts";

export function createTouchControls(doc:Document,controller:InputController,copy:UiCopy):{element:HTMLElement;dispose():void} {
  const root=doc.createElement("div");root.className="fc-touch";
  const cleanups:(()=>void)[]=[];
  const stick=doc.createElement("div");stick.className="fc-stick";stick.setAttribute("role","group");stick.setAttribute("aria-label",copy("ui.controls.move"));
  const knob=doc.createElement("span");stick.append(knob);let pointer:number|undefined;
  function release(){pointer=undefined;controller.setStick(0,0);knob.style.transform="";}
  function move(e:PointerEvent){if(pointer!==e.pointerId)return;const r=stick.getBoundingClientRect(),x=(e.clientX-r.left-r.width/2)/(r.width/2),y=(e.clientY-r.top-r.height/2)/(r.height/2),length=Math.max(1,Math.hypot(x,y));controller.setStick(x/length,y/length);knob.style.transform=`translate(${x/length*34}px,${y/length*34}px)`;}
  const down=(e:PointerEvent)=>{if(pointer!==undefined)return;e.preventDefault();pointer=e.pointerId;stick.setPointerCapture(e.pointerId);move(e);};
  stick.addEventListener("pointerdown",down);stick.addEventListener("pointermove",move);for(const type of ["pointerup","pointercancel","lostpointercapture"])stick.addEventListener(type,release);
  cleanups.push(()=>{stick.removeEventListener("pointerdown",down);stick.removeEventListener("pointermove",move);for(const type of ["pointerup","pointercancel","lostpointercapture"])stick.removeEventListener(type,release);release();});
  const buttons=doc.createElement("div");buttons.className="fc-touch-actions";
  for(const action of ["fire","scan","watch","cone","gadget","interact","enterExit","brake","altFire"] satisfies VirtualAction[]){
    const button=doc.createElement("button");button.type="button";button.textContent=copy(`ui.controls.${action}`);let held:number|undefined;
    const start=(e:PointerEvent)=>{if(held!==undefined)return;e.preventDefault();held=e.pointerId;button.setPointerCapture(e.pointerId);controller.setAction(action,true);};
    const end=()=>{held=undefined;controller.setAction(action,false);};
    button.addEventListener("pointerdown",start);for(const type of ["pointerup","pointercancel","lostpointercapture"])button.addEventListener(type,end);
    cleanups.push(()=>{button.removeEventListener("pointerdown",start);for(const type of ["pointerup","pointercancel","lostpointercapture"])button.removeEventListener(type,end);end();});buttons.append(button);
  }
  root.append(stick,buttons);return{element:root,dispose(){for(const cleanup of cleanups)cleanup();root.remove();}};
}
