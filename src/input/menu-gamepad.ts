import type {PadLike} from "./controller.ts";

export interface MenuGamepadCallbacks {isOpen():boolean;toggle():void;close():void;move(delta:number):void;activate():void}
/** Standard-pad menu buttons are edge-triggered independently of gameplay controls. */
export class MenuGamepad {
  private previous=new Set<number>();
  private axis=0;
  private readonly callbacks:MenuGamepadCallbacks;
  constructor(callbacks:MenuGamepadCallbacks){this.callbacks=callbacks;}
  update(pad:PadLike|null|undefined):void {
    const now=new Set<number>();if(pad?.connected)pad.buttons.forEach((button,index)=>{if(button.pressed)now.add(index);});
    const pressed=(index:number)=>now.has(index)&&!this.previous.has(index);
    if(pressed(9))this.callbacks.toggle();
    else if(this.callbacks.isOpen()){
      if(pressed(1)||pressed(8))this.callbacks.close();
      else if(pressed(0))this.callbacks.activate();
      const direction=(pad?.axes[1]??0)>.5?1:(pad?.axes[1]??0)<-.5?-1:0;
      if(pressed(12)||pressed(14)||direction===-1&&this.axis!==-1)this.callbacks.move(-1);
      if(pressed(13)||pressed(15)||direction===1&&this.axis!==1)this.callbacks.move(1);
      this.axis=direction;
    }else this.axis=0;
    this.previous=now;
  }
}
