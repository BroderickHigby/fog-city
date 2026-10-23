import {expect,it} from "vitest";
import {AimController,NO_LOOK} from "../../src/input/aim.ts";
import {InputController} from "../../src/input/controller.ts";
import {CameraRig,type CameraTarget,NO_FLY_INPUT} from "../../src/render/cameras.ts";
import {PerspectiveCamera,Vector3} from "three";

it("records bounded absolute aim only after deliberate look input and clears on reset",()=>{
  const aim=new AimController();expect(aim.update(1,NO_LOOK,1/60)).toBeUndefined();
  const pose=aim.update(1,{...NO_LOOK,pixelsX:100,pixelsY:-100},1/60)!;
  expect(pose.yaw).toBeCloseTo(1.3);expect(pose.pitch).toBeCloseTo(.3);
  expect(aim.update(2,{...NO_LOOK,stickY:-1},100)?.pitch).toBeLessThanOrEqual(1.2);
  expect(aim.update(2,{...NO_LOOK,reset:true},1/60)).toBeUndefined();
});
it("combines right-stick aim and drains pointer motion when modal input is blocked",()=>{
  const pad={connected:true,axes:[0,0,.8,-.8],buttons:[]};
  const controls=new InputController(undefined,()=>[pad]);controls.addLook(20,-10);
  expect(controls.consumeLook()).toMatchObject({pixelsX:20,pixelsY:-10});
  controls.setBlocked(true);controls.addLook(200,200);expect(controls.consumeLook()).toEqual(NO_LOOK);
  controls.setBlocked(false);expect(controls.consumeLook()).toEqual(NO_LOOK);
});
it("first-person camera looks along the recorded weapon bearing",()=>{
  const camera=new PerspectiveCamera(),rig=new CameraRig(camera,()=>0);rig.setMode("first-person");
  const target:CameraTarget={x:0,y:0,z:0,heading:0,onFoot:true,speed:0,lookYaw:1,lookPitch:.2};rig.update(1/60,target,NO_FLY_INPUT);
  const direction=camera.getWorldDirection(new Vector3());expect(Math.atan2(direction.x,-direction.z)).toBeCloseTo(1);expect(Math.asin(direction.y)).toBeCloseTo(.2);
});

it("releases pointer fire on cancellation and disposes canvas listeners",async()=>{
  const {PointerCombat}=await import("../../src/input/pointer-combat.ts");
  const target=Object.assign(new EventTarget(),{style:{touchAction:"auto",cursor:"default"},ownerDocument:{defaultView:new EventTarget()},setPointerCapture(){},hasPointerCapture:()=>false});
  const controls=new InputController(undefined,()=>[]),pointer=new PointerCombat(target as unknown as HTMLElement,controls);
  const dispatch=(type:string,x=0)=>{const event=new Event(type,{cancelable:true});Object.defineProperties(event,{pointerId:{value:1},pointerType:{value:"mouse"},button:{value:0},buttons:{value:type==="pointerdown"?1:0},clientX:{value:x},clientY:{value:0}});target.dispatchEvent(event);};
  dispatch("pointerdown");expect(controls.sample().actions).not.toBe(0);dispatch("pointermove",20);expect(controls.consumeLook().pixelsX).toBe(20);
  dispatch("pointercancel");expect(controls.sample().actions).toBe(0);pointer.dispose();dispatch("pointerdown");expect(controls.sample().actions).toBe(0);expect(target.style.cursor).toBe("default");
});

it("chase aiming stays aligned through abrupt turns and terrain camera clamping",()=>{
  const camera=new PerspectiveCamera(),rig=new CameraRig(camera,()=>10);
  const target:CameraTarget={x:0,y:0,z:0,heading:0,onFoot:true,speed:0,lookYaw:0,lookPitch:0};rig.update(1/60,target,NO_FLY_INPUT);
  rig.update(1/60,{...target,lookYaw:1.8,lookPitch:-1.1},NO_FLY_INPUT);
  const direction=camera.getWorldDirection(new Vector3());expect(Math.atan2(direction.x,-direction.z)).toBeCloseTo(1.8);expect(Math.asin(direction.y)).toBeCloseTo(-1.1);expect(camera.position.y).toBeGreaterThanOrEqual(11);
});
