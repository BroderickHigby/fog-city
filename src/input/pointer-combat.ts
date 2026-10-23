import type {InputController} from "./controller.ts";

/** Canvas-only controls. UI buttons never bubble a shot through the canvas. */
export class PointerCombat {
  private readonly element:HTMLElement;
  private readonly controls:InputController;
  private pointer:number|null=null;
  private x=0;
  private y=0;
  private firing=false;
  private readonly oldTouchAction:string;
  private readonly oldCursor:string;
  private readonly down=(event:PointerEvent)=>{
    if(event.button===1){this.controls.resetLook();event.preventDefault();return;}
    if(event.button!==0&&event.button!==2)return;
    this.pointer=event.pointerId;this.x=event.clientX;this.y=event.clientY;
    this.element.setPointerCapture?.(event.pointerId);
    if(event.button===0&&event.pointerType!=="touch"){this.firing=true;this.controls.setAction("fire",true);}
    event.preventDefault();
  };
  private readonly move=(event:PointerEvent)=>{if(this.pointer!==event.pointerId)return;this.controls.addLook(event.clientX-this.x,event.clientY-this.y);this.x=event.clientX;this.y=event.clientY;};
  private readonly end=(event:PointerEvent)=>{
    if(this.pointer!==event.pointerId)return;
    if(event.type==="pointerup"&&event.buttons!==0){if(event.button===0){this.firing=false;this.controls.setAction("fire",false);}return;}
    this.pointer=null;this.firing=false;this.controls.setAction("fire",false);
    if(this.element.hasPointerCapture?.(event.pointerId))this.element.releasePointerCapture(event.pointerId);
  };
  private readonly blur=()=>{this.pointer=null;if(this.firing)this.controls.setAction("fire",false);this.firing=false;};
  private readonly context=(event:Event)=>event.preventDefault();
  constructor(element:HTMLElement,controls:InputController){
    this.element=element;this.controls=controls;this.oldTouchAction=element.style.touchAction;this.oldCursor=element.style.cursor;element.style.touchAction="none";element.style.cursor="crosshair";
    element.addEventListener("pointerdown",this.down);element.addEventListener("pointermove",this.move);element.addEventListener("pointerup",this.end);element.addEventListener("pointercancel",this.end);element.addEventListener("lostpointercapture",this.end);element.addEventListener("contextmenu",this.context);element.ownerDocument.defaultView?.addEventListener("blur",this.blur);
  }
  dispose():void{this.blur();const element=this.element;element.removeEventListener("pointerdown",this.down);element.removeEventListener("pointermove",this.move);element.removeEventListener("pointerup",this.end);element.removeEventListener("pointercancel",this.end);element.removeEventListener("lostpointercapture",this.end);element.removeEventListener("contextmenu",this.context);element.ownerDocument.defaultView?.removeEventListener("blur",this.blur);element.style.touchAction=this.oldTouchAction;element.style.cursor=this.oldCursor;}
}
