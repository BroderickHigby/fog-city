// Traffic keeps flowing out of the starting districts on the real city (coordinator, 2026-10-24:
// Missions' player could not drive out of the FiDi desk, Gameplay's Fleet Week getaway car sat in
// a jam by Marina Green). Two root causes, both fixed at the source:
//  - A disguised bad Footman took a robotaxi for a robot to force-update, walked into the road and
//    stood at its nose; the robotaxi yielded to it for good (src/sim/agents/runtime.ts: robots see
//    robots of their own medium only).
//  - On a short link between two junctions (Fillmore St, 15.7 m between Retiro Way and Marina
//    Blvd) a robotaxi waiting at the far line still had its tail in the junction behind, kept it,
//    and could not contend for the one ahead; one coming the other way did the same (agents.ts:
//    SHORT_LINK_M, rearHold).
// Each leg puts the player on the pavement by the street (the game composition, never in the
// road) and watches every robotaxi within 80 m of that point: none stands still for 45 s (90 s
// in the queue on a side street into the five-way all-way stop at Marina Blvd and Fillmore), they
// drive along the street in every 30 s window, nothing touches anyone, and no robot on foot ever
// sets out after a vehicle.
import { describe, expect, it } from "vitest";
import type { CombatWave } from "../../src/sim/combat-contract.ts";
import { agentsOf, createGameSystems, createInitialState, dodgeExtOf, makeFoot, step, type SimState, type World } from "../../src/sim/index.ts";
import { agentsRuntimeOf } from "../../src/sim/agents/runtime.ts";
import { toLocal } from "../../src/geo/project.ts";
import { loadWorld, worldExists } from "../helpers.ts";
// Cost: about 18–26 ms a simulated tick on real SF with the probes (Beale St, 7,200 ticks: 190 s);
// each leg's timeout allows 60 ms a tick for slower machines.
const MS_PER_TICK = 60;

const WINDOW = 30 * 60;
const VEHICLES = new Set(["robotaxi", "van", "bus"]);

interface Leg {
  street: string; seed: number; wave: CombatWave; at: { x: number; z: number }; secs: number;
  /** Longest a robotaxi may stand still, seconds. */
  limitS: number;
}

/** The point of `street` nearest `near`. */
function onStreet(world: World, street: string, near: { x: number; z: number }): { x: number; z: number } {
  let best = { x: 0, z: 0, d: Infinity };
  for (const e of world.roads!.edges) {
    if (e.name !== street) continue;
    for (let i = 0; i < e.center.xs.length; i++) {
      const d = Math.hypot(e.center.xs[i]! - near.x, e.center.zs[i]! - near.z);
      if (d < best.d) best = { x: e.center.xs[i]!, z: e.center.zs[i]!, d };
    }
  }
  return best;
}

function soak(world: World, leg: Leg): void {
  const systems = createGameSystems({ wave: leg.wave, protectedArea: () => false });
  const at = onStreet(world, leg.street, leg.at);
  const streetEdges = new Set(world.roads!.edges.filter((e) => e.name === leg.street).map((e) => e.id));
  const pavement = [...world.sidewalks!.nodes].sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z) || (a.id < b.id ? -1 : 1))[0]!;
  let s: SimState = createInitialState(world, leg.seed, ["p1"], { x: at.x + 400, z: at.z + 400, heading: 0 });
  s = { ...s, players: { p1: { ...s.players.p1!, mode: "foot", foot: makeFoot(pavement.x, s.players.p1!.car.y, pavement.z, 0) } } };
  const still = new Map<number, number>();
  const driven: number[] = [];
  let worst = 0, who = "", metres = 0;
  for (let t = 0; t < leg.secs * 60; t++) {
    s = step(world, s, {}, [], systems);
    for (const a of agentsOf(s)) {
      if (a.kind !== "robotaxi" || Math.hypot(a.x - at.x, a.z - at.z) > 80) { still.delete(a.id); continue; }
      if (streetEdges.has(a.edge)) metres += Math.abs(a.speed) / 60;
      // Road velocity is signed in SIM24; reversing is physical movement.
      const n = Math.abs(a.speed) < 0.05 ? (still.get(a.id) ?? 0) + 1 : 0;
      still.set(a.id, n);
      if (n > worst) { worst = n; who = `${a.id} at ${a.x.toFixed(1)},${a.z.toFixed(1)} on ${a.edge}`; }
    }
    if (t % WINDOW === WINDOW - 1) { driven.push(Math.round(metres)); metres = 0; }
    const runtime = agentsRuntimeOf(s);
    if (t % 60 === 0 && runtime) {
      const byNumber = new Map(Object.keys(runtime.actors).map((k) => [runtime.actors[k]!.numericId, runtime.actors[k]!] as const));
      for (const k of Object.keys(runtime.actors)) {
        const r = runtime.actors[k]!;
        const m = r.intent?.movement;
        if (VEHICLES.has(r.model) || m?.kind !== "pursue" || m.target.kind !== "robot") continue;
        const target = byNumber.get(m.target.id);
        expect(target && VEHICLES.has(target.model), `${k} (${r.model}) sets out after ${target?.id} (${target?.model}) at tick ${s.tick}`).toBe(false);
      }
    }
  }
  const report = `${leg.street} at ${at.x.toFixed(0)},${at.z.toFixed(0)}: longest standstill ${(worst / 60).toFixed(0)} s (${who}); metres driven per 30 s ${driven.join(", ")}`;
  console.info(report);
  expect(worst, report).toBeLessThan(leg.limitS * 60);
  for (const m of driven) expect(m, report).toBeGreaterThan(0);
  expect(dodgeExtOf(s).contacts, report).toBe(0);
}

describe.skipIf(!worldExists("sf"))("traffic flows out of the starting districts on the real city", () => {
  const { world } = loadWorld("sf", { roads: true });
  const desk = toLocal(37.7905, -122.4015); // the FiDi coworking desk (content/safehouses.json)
  // Gameplay's Fleet Week jam: Fillmore St between Retiro Way and Marina Blvd, seed 606, wave 4.
  const marina = { x: -3852, z: -1196 };
  const legs: Leg[] = [
    // Missions' report (seed 1, wave 3): the queue on Beale St at (-197, 496) behind a Footman.
    { street: "Beale St", seed: 1, wave: 3, at: { x: -197, z: 496 }, secs: 120, limitS: 45 },
    ...["Market St", "Mission St", "Howard St", "The Embarcadero"].map((street) => ({ street, seed: 1, wave: 3 as const, at: desk, secs: 90, limitS: 45 })),
    { street: "Marina Blvd", seed: 606, wave: 4, at: marina, secs: 150, limitS: 45 },
    // Where the getaway car was headed: Marina Blvd at Laguna St.
    { street: "Laguna St", seed: 606, wave: 4, at: { x: -3408.5, z: -1071.1 }, secs: 150, limitS: 45 },
    { street: "Fillmore St", seed: 606, wave: 4, at: marina, secs: 150, limitS: 90 },
  ];
  for (const leg of legs) it(`${leg.street} (seed ${leg.seed}, wave ${leg.wave}): no 45 s standstill, cars moving every 30 s`, () => soak(world, leg), leg.secs * 60 * MS_PER_TICK);
});
