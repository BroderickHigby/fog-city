// Handling adapted from Slop New York controllers.js at be65d0ab61b24718b6da8886b7d7bed2d68ac178
// (MIT; full notice retained in assets/imports/slop-new-york/LICENSE.md). Fog City's fixed-tick,
// compass frame, wet streets, hill gravity and explicit handbrake remain authoritative.
//
// v24 (brake-steer and handbrake drift; v19 to v23 keep the path below exactly):
//  - Braking against travel (the brake, or throttle against the motion) cuts the tyres' LATERAL
//    grip by up to brakeSlide (to 30%) while the YAW keeps the tyres' full grip (Slop's
//    steeringGrip, controllers.js updateCar), faded out below brakeFadeSpeed. So brake + steer
//    turns the body while the tail slides; releasing the brake gives the grip back at once.
//    Throttle against travel (S while rolling forward) reproduces the original controller's own
//    trajectory (tests/golden/reference-braking-819a0ad.json).
//  - The handbrake (the brake over half, steering over 0.3, above handbrakeMinSpeed: the same
//    rule as v14-v23) locks the rear wheels: it slows the car at handbrakeDecel instead of the
//    ABS foot brake, the rear's `grip` drops as before, and as it engages (grip still whole at
//    the tick's start) the tail steps out: the yaw rate jumps toward the most yaw the tyres
//    allow on the steering side, by at most handbrakeKick (the v14-v18 kick, now capped by grip).
import { DT, type CarState, type SimInput } from "./contract.ts";
import { clamp, dcos, dsin, datan, dtan, wrapAngle } from "./dmath.ts";

/** City-road handling profile; physical body/mass/safety limits remain CAR's shared contract. */
export const REFERENCE_DRIVE = Object.freeze({
  speed: 36, reverseSpeed: 10.5, acceleration: 4.5, powerSpeed: 14.5,
  rolling: .18, drag: .0012, coast: .6, brake: 9,
  wheelbase: 2.76, grip: 9.5, cornering: 10.5, steerLock: .6,
  handbrakeMinSpeed: 9, handbrakeDrop: 4, gripRecover: 1.3,
  /** v24: share of lateral grip that full braking against travel takes away (Slop: 0.7). */
  brakeSlide: .7,
  /** v24: braking's slide fades in over the first this many m/s (Slop: 5). */
  brakeFadeSpeed: 5,
  /** v24: the handbrake's deceleration, m/s^2 (rear wheels only; the foot brake is `brake`). */
  handbrakeDecel: 4,
  /** v24: the most the yaw rate jumps as the handbrake engages, rad/s (car.ts CAR.handbrakeKick). */
  handbrakeKick: .9,
});
/** First SIM_VERSION with brake-steer rotation and the handbrake drift. */
export const BRAKE_DRIFT_VERSION = 24;
/** The handbrake is engaging (its kick fires) while the grip at the tick's start is at least this (dodge.ts assumes it). */
/** v24: the kick fires only once grip has fully recovered, so a flickering handbrake cannot re-kick. */
const HANDBRAKE_ENGAGED = 1;
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

/**
 * Pure planar control, independent of rendering and world geometry; gravity is a world vector.
 * `version`: the SIM_VERSION whose handling to use (19 to 23: the v19 port; 24 on: brake-steer).
 */
export function stepReferenceDriving(c: Readonly<CarState>, input: Readonly<SimInput>, traction = 1, gravityX = 0, gravityZ = 0, version = 19): ReferenceDrivingResult {
  let heading=c.heading,speed=c.speed,lateral=c.lateral,yawRate=c.yawRate,steer=c.steer,grip=c.grip,dx=0,dz=0;
  const mu=clamp(traction,0,1),tireLimit=REFERENCE_DRIVE.grip*mu,drift=version>=BRAKE_DRIFT_VERSION;
  for(let i=0;i<2;i++) {
    const fx=dsin(heading),fz=-dcos(heading),rx=-fz,rz=fx;
    const handbrake=input.brake>.5&&Math.abs(input.steer)>.3&&Math.abs(speed)>REFERENCE_DRIVE.handbrakeMinSpeed;
    // v24: the handbrake engages this tick (once per pull: grip must be fully back before it can kick again).
    const kick=drift&&i===0&&handbrake&&c.grip>=HANDBRAKE_ENGAGED;
    grip=handbrake?Math.max(0,grip-REFERENCE_DRIVE.handbrakeDrop*H):Math.min(1,grip+REFERENCE_DRIVE.gripRecover*H);
    const forward=speed,sideways=lateral;
    // v24: the handbrake brakes the rear wheels only (handbrakeDecel), not at the foot brake's rate.
    const pedal=drift&&handbrake?input.brake*REFERENCE_DRIVE.handbrakeDecel/REFERENCE_DRIVE.brake:input.brake;
    let next=referenceDriveSpeed(forward,input.throttle,pedal,H);
    // Only tire force spends cornering grip. Aero and slope gravity are external forces.
    let tireAcceleration=(next-forward)/H+REFERENCE_DRIVE.drag*forward*Math.abs(forward);
    if(Math.abs(tireAcceleration)>tireLimit) {
      tireAcceleration=clamp(tireAcceleration,-tireLimit,tireLimit);
      next=forward+(tireAcceleration-REFERENCE_DRIVE.drag*forward*Math.abs(forward))*H;
    }
    const available=Math.sqrt(Math.max(0,tireLimit*tireLimit-tireAcceleration*tireAcceleration));
    let lateralGrip=available*(.55+.45*grip),steeringGrip=lateralGrip;
    if(drift) {
      // v24 (Slop's handbrake/steeringGrip): braking against travel, faded in from a crawl, slides
      // the tyres sideways while the steering keeps all of the tyres' grip.
      const against=Math.max(input.brake,forward*input.throttle<0?Math.abs(input.throttle):0)*Math.min(1,Math.abs(forward)/REFERENCE_DRIVE.brakeFadeSpeed);
      steeringGrip=available+(tireLimit-available)*against;
      lateralGrip*=1-REFERENCE_DRIVE.brakeSlide*against;
    }
    const turn=REFERENCE_DRIVE.wheelbase*REFERENCE_DRIVE.cornering;
    const lock=datan(turn/Math.max(next*next,turn/dtan(REFERENCE_DRIVE.steerLock)));
    steer+=(input.steer*lock-steer)*STEER_RESPONSE;
    const yawLimit=steeringGrip/Math.max(2,Math.abs(next));
    const targetYaw=clamp(next*dtan(steer)/REFERENCE_DRIVE.wheelbase,-yawLimit,yawLimit);
    if(kick) {
      // v24: the tail steps out toward the steering, to the most yaw the tyres allow (never past it).
      // In reverse the yaw for a steer is the other way round, so the kick follows the yaw, not the stick.
      const side=(input.steer<0?-1:1)*(next<0?-1:1),gap=side*yawLimit-yawRate;
      if(gap*side>0)yawRate+=side*Math.min(gap*side,REFERENCE_DRIVE.handbrakeKick);
    }
    const yawStep=steeringGrip*.65*H;
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
