/** Share of full travel (0..1) around the stick centre that reads as no input (the touch stick). */
export const STICK_DEAD_ZONE = 0.15;
/**
 * The gamepad drive stick's zone. A worn pad can rest at (0.15, 0.15), which the old per-axis .16
 * zone swallowed; at 0.2 that rest reads about 0.015 per axis, under the sim's 0.05 hold-still
 * check (src/sim/car.ts), so a parked car does not creep.
 */
export const PAD_DEAD_ZONE = 0.2;

/**
 * Round (radial) dead zone for a two-axis stick. Inside the zone the stick reads (0,0). Beyond it the
 * remaining travel is rescaled so full deflection still reaches length 1, and the direction is kept.
 * A diagonal is judged by its distance from the centre, not axis by axis, so a resting thumb or a
 * worn pad cannot nudge one axis while the other stays quiet. Non-finite input reads as centred.
 */
export function radialDeadZone(x:number,y:number,zone:number=STICK_DEAD_ZONE):{x:number;y:number} {
  const px=Number.isFinite(x)?x:0,py=Number.isFinite(y)?y:0,distance=Math.hypot(px,py);
  if(distance<=zone)return{x:0,y:0};
  const strength=(Math.min(distance,1)-zone)/(1-zone);
  return{x:px/distance*strength,y:py/distance*strength};
}
