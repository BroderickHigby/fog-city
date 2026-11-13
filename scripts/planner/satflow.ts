import { idmAccel, IDM } from "../../src/planner/traffic.ts";
// Queue of 40 cars stopped at a line; light turns green at t=0. Count cars crossing the line per second.
const n = 40, cars = Array.from({ length: n }, (_, i) => ({ s: -i * (IDM.len + IDM.s0) - 0.5, v: 0, a: 0 }));
const dt = 0.1; const crossed: number[] = [];
for (let t = 0; t < 120; t += dt) {
  for (let i = 0; i < n; i++) { const c = cars[i]!, l = cars[i - 1]; c.a = idmAccel(c.v, l ? l.s - IDM.len - c.s : Infinity, l ? c.v - l.v : 0); }
  for (const c of cars) { const s0 = c.s; c.v = Math.max(0, c.v + c.a * dt); c.s += c.v * dt; if (s0 < 0 && c.s >= 0) crossed.push(t); }
}
const h = crossed.slice(5, 30); console.log("first car", crossed[0]?.toFixed(1), "steady headway", ((h.at(-1)! - h[0]!) / (h.length - 1)).toFixed(2), "s =", (3600 * (h.length - 1) / (h.at(-1)! - h[0]!)).toFixed(0), "veh/h/lane");
