// Handling adapted from Slop New York controllers.js at be65d0ab61b24718b6da8886b7d7bed2d68ac178
// (MIT; full notice retained in assets/imports/slop-new-york/LICENSE.md). Fog City's fixed-tick,
// compass frame, wet streets, hill gravity and explicit handbrake remain authoritative.
import { DT, type CarState, type SimInput } from "./contract.ts";
import { clamp, dcos, dsin, datan, dtan, wrapAngle } from "./dmath.ts";

/** City-road handling profile; physical body/mass/safety limits remain CAR's shared contract. */
export const REFERENCE_DRIVE = Object.freeze({
  speed: 36, reverseSpeed: 10.5, acceleration: 4.5, powerSpeed: 14.5,
  rolling: .18, drag: .0012, coast: .6, brake: 9,
  wheelbase: 2.76, grip: 9.5, cornering: 10.5, steerLock: .6,
  handbrakeMinSpeed: 9, handbrakeDrop: 4, gripRecover: 1.3,
});
const H = DT / 2;
// 1-exp(-rate/120), recorded constants: no host-dependent transcendental in the sim.
const STEER_RESPONSE = .07995558537067671;
const YAW_RESPONSE = .040810542890861834;
const TIRE_RESPONSE = .0327838995179941;

export interface ReferenceDrivingResult {
  heading: number; speed: number; lateral: number; yawRate: number; steer: number; grip: number;
  /** Actual integrated travel over the two fixed half-ticks, before world/body contacts. */
  dx: number; dz: number;
}

/** One signed pedal step: opposite throttle brakes first; a tiny crawl cannot lock reverse. */
export function referenceDriveSpeed(speed: number, throttle: number, brake: number, dt: number): number {
  if (speed * throttle < 0 && Math.abs(speed) < .05) speed = 0;
  const magnitude = Math.abs(speed), opposing = speed * throttle < 0;
  const pedal = Math.max(brake, opposing ? Math.abs(throttle) : 0);
  const resistance = REFERENCE_DRIVE.rolling + (pedal > 0 ? pedal * REFERENCE_DRIVE.brake : !throttle ? REFERENCE_DRIVE.coast : 0);
  const coast = Math.max(0, magnitude - resistance * dt) / (1 + REFERENCE_DRIVE.drag * magnitude * dt);
  if (!throttle || pedal > 0) return (speed < 0 ? -1 : speed > 0 ? 1 : 0) * coast;
  const limit = throttle < 0 ? REFERENCE_DRIVE.reverseSpeed : REFERENCE_DRIVE.speed;
  const acceleration = REFERENCE_DRIVE.acceleration * REFERENCE_DRIVE.powerSpeed / Math.max(REFERENCE_DRIVE.powerSpeed, magnitude);
  return (throttle < 0 ? -1 : 1) * Math.min(Math.max(limit, coast), coast + Math.abs(throttle) * acceleration * dt);
}

/** Pure planar control, independent of rendering and world geometry; gravity is a world vector. */
export function stepReferenceDriving(c: Readonly<CarState>, input: Readonly<SimInput>, traction = 1, gravityX = 0, gravityZ = 0): ReferenceDrivingResult {
  let heading=c.heading,speed=c.speed,lateral=c.lateral,yawRate=c.yawRate,steer=c.steer,grip=c.grip,dx=0,dz=0;
  const mu=clamp(traction,0,1),tireLimit=REFERENCE_DRIVE.grip*mu;
  for(let i=0;i<2;i++) {
    const fx=dsin(heading),fz=-dcos(heading),rx=-fz,rz=fx;
    const handbrake=input.brake>.5&&Math.abs(input.steer)>.3&&Math.abs(speed)>REFERENCE_DRIVE.handbrakeMinSpeed;
    grip=handbrake?Math.max(0,grip-REFERENCE_DRIVE.handbrakeDrop*H):Math.min(1,grip+REFERENCE_DRIVE.gripRecover*H);
    const forward=speed,sideways=lateral;
    let next=referenceDriveSpeed(forward,input.throttle,input.brake,H);
    // Only tire force spends cornering grip. Aero and slope gravity are external forces.
    let tireAcceleration=(next-forward)/H+REFERENCE_DRIVE.drag*forward*Math.abs(forward);
    if(Math.abs(tireAcceleration)>tireLimit) {
      tireAcceleration=clamp(tireAcceleration,-tireLimit,tireLimit);
      next=forward+(tireAcceleration-REFERENCE_DRIVE.drag*forward*Math.abs(forward))*H;
    }
    const available=Math.sqrt(Math.max(0,tireLimit*tireLimit-tireAcceleration*tireAcceleration));
    const lateralGrip=available*(.55+.45*grip);
    const turn=REFERENCE_DRIVE.wheelbase*REFERENCE_DRIVE.cornering;
    const lock=datan(turn/Math.max(next*next,turn/dtan(REFERENCE_DRIVE.steerLock)));
    steer+=(input.steer*lock-steer)*STEER_RESPONSE;
    const yawLimit=lateralGrip/Math.max(2,Math.abs(next));
    const targetYaw=clamp(next*dtan(steer)/REFERENCE_DRIVE.wheelbase,-yawLimit,yawLimit);
    const yawStep=lateralGrip*.65*H;
    yawRate+=clamp((targetYaw-yawRate)*YAW_RESPONSE,-yawStep,yawStep);
    heading=wrapAngle(heading+yawRate*H);
    const nfx=dsin(heading),nfz=-dcos(heading),nrx=-nfz,nrz=nfx;
    const worldX=fx*next+rx*sideways,worldZ=fz*next+rz*sideways;
    speed=worldX*nfx+worldZ*nfz;
    const slip=worldX*nrx+worldZ*nrz;
    const correction=clamp(-slip*TIRE_RESPONSE,-lateralGrip*H,lateralGrip*H);
    lateral=slip+correction;
    const vx=nfx*speed+nrx*lateral+gravityX*H,vz=nfz*speed+nrz*lateral+gravityZ*H;
    speed=vx*nfx+vz*nfz;lateral=vx*nrx+vz*nrz;
    // Parked vehicles stay held on SF hills; neutral input does not cause endless creep.
    if(Math.abs(input.throttle)<.05&&Math.abs(speed)<.3&&Math.abs(lateral)<.3) {speed=0;lateral=0;yawRate=0;}
    dx+=(nfx*speed+nrx*lateral)*H;dz+=(nfz*speed+nrz*lateral)*H;
  }
  return {heading,speed:speed+0,lateral:lateral+0,yawRate:yawRate+0,steer:steer+0,grip,dx,dz};
}
