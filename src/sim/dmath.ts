// Deterministic transcendental functions for the simulation.
//
// Math.sin/cos/atan2/exp/pow are not required by the spec to give identical results
// across JavaScript engines. The sim must produce bit-identical states on a Node server
// and in every browser, so src/sim uses only + - * / and Math.sqrt / Math.floor /
// Math.round / Math.abs / Math.min / Math.max (all exactly specified), plus these.
// tests/sim/forbidden-apis.test.ts enforces this.

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

/** Wrap an angle to [-PI, PI). */
export function wrapAngle(a: number): number {
  return a - TAU * Math.floor((a + PI) / TAU);
}

/** sin(x), |error| < 1e-8 over all finite x. */
export function dsin(x: number): number {
  let a = wrapAngle(x);
  // Fold to [-PI/2, PI/2] using sin(PI - a) = sin(a).
  if (a > HALF_PI) a = PI - a;
  else if (a < -HALF_PI) a = -PI - a;
  const a2 = a * a;
  // Taylor series to a^15, Horner form.
  return (
    a *
    (1 +
      a2 *
        (-1 / 6 +
          a2 *
            (1 / 120 +
              a2 *
                (-1 / 5040 +
                  a2 * (1 / 362880 + a2 * (-1 / 39916800 + a2 * (1 / 6227020800 + a2 * (-1 / 1307674368000))))))))
  );
}

export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

export function dtan(x: number): number {
  return dsin(x) / dcos(x);
}

const TAN_PI_12 = 0.2679491924311227;
const SQRT3 = 1.7320508075688772;

function atanSmall(t: number): number {
  // |t| <= tan(pi/12); series to t^13.
  const t2 = t * t;
  return t * (1 + t2 * (-1 / 3 + t2 * (1 / 5 + t2 * (-1 / 7 + t2 * (1 / 9 + t2 * (-1 / 11 + t2 * (1 / 13)))))));
}

/** atan(t) for any finite t, |error| < 1e-8. */
export function datan(t: number): number {
  const neg = t < 0;
  let x = neg ? -t : t;
  let offset = 0;
  if (x > 1) {
    x = 1 / x;
    offset = HALF_PI;
  }
  let r: number;
  if (x > TAN_PI_12) r = PI / 6 + atanSmall((x * SQRT3 - 1) / (x + SQRT3));
  else r = atanSmall(x);
  if (offset !== 0) r = offset - r;
  return neg ? -r : r;
}

export function datan2(y: number, x: number): number {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Move v toward target by at most maxDelta. */
export function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return v + maxDelta > target ? target : v + maxDelta;
  return v - maxDelta < target ? target : v - maxDelta;
}
