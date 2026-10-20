// Phase 0 arcade car: a kinematic bicycle model with building collision.
// Deliberately simple and fully deterministic; the vehicle track replaces the
// handling model, not the contract.

import { DT, type CarState, type SimInput } from "./contract.ts";
import { approach, clamp, dcos, dsin, dtan, wrapAngle } from "./dmath.ts";
import { groundHeight, resolveCircle, type World } from "./world.ts";

export const CAR = {
  maxSpeed: 28, // m/s, ~100 km/h
  maxReverse: 8,
  accel: 9,
  reverseAccel: 5,
  brakeDecel: 22,
  drag: 0.35, // 1/s
  rolling: 0.6, // m/s^2 when coasting
  wheelbase: 2.8,
  maxSteer: 0.55,
  steerRate: 2.6, // rad/s
  radius: 1.6, // collision circle, m
  bounce: 0.25,
} as const;

export function makeCar(x: number, z: number, heading: number, y = 0): CarState {
  return { x, y, z, heading, speed: 0, steer: 0, hits: 0 };
}

export function stepCar(world: World, c: Readonly<CarState>, input: Readonly<SimInput>): CarState {
  const throttle = input.throttle;
  let speed = c.speed;

  if (throttle > 0) {
    speed += (speed < 0 ? CAR.brakeDecel : CAR.accel) * throttle * DT;
  } else if (throttle < 0) {
    speed += (speed > 0 ? -CAR.brakeDecel : -CAR.reverseAccel) * -throttle * DT;
  } else {
    speed = approach(speed, 0, CAR.rolling * DT);
  }
  if (input.brake > 0) speed = approach(speed, 0, CAR.brakeDecel * input.brake * DT);
  speed -= speed * CAR.drag * DT;
  speed = clamp(speed, -CAR.maxReverse, CAR.maxSpeed);

  // Less wheel angle at speed keeps the car controllable.
  const steerLimit = CAR.maxSteer / (1 + (speed < 0 ? -speed : speed) / 18);
  const steer = approach(c.steer, input.steer * steerLimit, CAR.steerRate * DT);
  const heading = wrapAngle(c.heading + (speed / CAR.wheelbase) * dtan(steer) * DT);

  let x = c.x + dsin(heading) * speed * DT;
  let z = c.z - dcos(heading) * speed * DT;
  const y = groundHeight(world, x, z);

  const res = resolveCircle(world, x, z, y + 0.5, CAR.radius);
  let hits = c.hits;
  if (res.hit) {
    x = res.x;
    z = res.z;
    speed = -speed * CAR.bounce;
    hits += 1;
  }
  return { x, y, z, heading, speed, steer, hits };
}
