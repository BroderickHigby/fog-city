import {expect,it} from "vitest";
import {MenuGamepad} from "../../src/input/menu-gamepad.ts";
import {Keyboard} from "../../src/input/keyboard.ts";
import {Action} from "../../src/sim/contract.ts";
it("opens menus, navigates and activates once per pad press",()=>{
  let open=false,moves=0,activations=0;const menu=new MenuGamepad({isOpen:()=>open,toggle:()=>{open=!open;},close:()=>{open=false;},move:delta=>{moves+=delta;},activate:()=>{activations++;}});
  const pad=(pressed:number[])=>({connected:true,axes:[0,0],buttons:Array.from({length:16},(_,index)=>({pressed:pressed.includes(index),value:pressed.includes(index)?1:0}))});
  menu.update(pad([9]));menu.update(pad([9]));expect(open).toBe(true);
  menu.update(pad([13]));menu.update(pad([13]));expect(moves).toBe(1);
  menu.update(pad([0]));menu.update(pad([0]));expect(activations).toBe(1);menu.update(pad([1]));expect(open).toBe(false);
});
it("does not leak a held key through a dismissed modal",()=>{
  const target=new EventTarget() as EventTarget&{document:{activeElement:null}};target.document={activeElement:null};
  const keyboard=new Keyboard(target as unknown as Window);
  const event=(type:string,repeat=false)=>{const e=new Event(type);Object.defineProperties(e,{code:{value:"KeyE"},repeat:{value:repeat}});target.dispatchEvent(e);};
  event("keydown");expect(keyboard.sample().actions).toBe(Action.fire);keyboard.setBlocked(true);event("keydown",true);keyboard.setBlocked(false);event("keydown",true);expect(keyboard.sample().actions).toBe(0);
  event("keyup");event("keydown");expect(keyboard.sample().actions).toBe(Action.fire);keyboard.dispose();
});
