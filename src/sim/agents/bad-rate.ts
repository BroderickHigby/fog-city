// The bad-robot share of robots at a point, computed in the sim. Same data and formula as
// content's badRobotRate (src/content/places.ts, docs/design.md "The living city"), but that
// one measures distance with Math.hypot, whose last bit differs between JS engines. A one-ulp
// difference there can flip a robot's firmware draw on one browser and not another, so the sim
// measures with Math.sqrt (correctly rounded everywhere). Where hypot and sqrt agree the result
// is bit-for-bit the content function's.
import { BASELINE_BAD_RATE, MOAT_SITES, protectedAreaAt } from "../../content/places.ts";
import { toLatLon, toLocal } from "../../geo/project.ts";

/** Each Moat Labs site in local metres, projected exactly as content's distanceM projects it. */
const SITES = MOAT_SITES.map((site) => ({ ...toLocal(site.lat, site.lon), term: site.term, falloffM: site.falloffM }));

export function badRobotRateAt(x: number, z: number, baseline: number = BASELINE_BAD_RATE): number {
  const point = toLatLon(x, z);
  if (protectedAreaAt([point.lat, point.lon])) return baseline;
  // content projects the lat/lon back to metres before measuring; do the same.
  const p = toLocal(point.lat, point.lon);
  let rate = baseline;
  for (const site of SITES) {
    const dx = p.x - site.x, dz = p.z - site.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < site.falloffM) rate += site.term * (1 - d / site.falloffM);
  }
  return rate;
}
