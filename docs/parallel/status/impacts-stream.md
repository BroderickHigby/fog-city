# Impacts stream (`impacts`)

Owner request after playing the live build (`integrate/wave2` at `ff7db5b`): "You should be able to
hit robots, and you should be able to hit cars as well. Ideally, you're able to knock over a tree as
well." Goal: driving feels physical, the way GTA does.

## Plan and PRs

| PR | Branch | GitHub | SIM_VERSION | State |
|---|---|---|---|---|
| 1. Car vs car | `work/impacts/car-vs-car` | #50 | 14 | draft; on integrate `59e5a7b`; unit + browser green locally |
| 2. Car vs robot | `work/impacts/car-vs-robot` | #57 (stacked on #50) | 15 | draft; unit + browser green locally |
| 3. Destructibles | `work/impacts/destructibles` | #62 (stacked on #57) | 16 | draft; real SF street props from World detail |
| 4. Vehicle dynamics | `work/impacts/car-dynamics` | #81 (stacked on #50) | 15 | draft; unit + browser green locally |

All draft into `integrate/wave2`. Each merges the one below it, so #57's diff includes #50
and #62's includes both until they land. Restamped 2026-10-24 on integrate `59e5a7b`
(SIM_VERSION 13): impacts 14, robots 15, props 16; dynamics 15 beside robots (the coordinator
restamps whichever lands second). Each step is a no-rewrite `upgradeState` step.


## What the player's car did before this stream (finding, `ff7db5b`)

`step.ts` `obstaclesOf` gives each player's car the circles of every robot, robotaxi and other
player's car (as of the previous tick); `car.ts` `stepCar` treats every one of them exactly like a
building wall: the car is pushed out, its speed into the circle is removed (restitution 0.1 only
above 8 m/s) and wall friction scrapes its slide. The other body never moves: a robotaxi carries on
along its lane as if nothing happened (it brakes only because its look-ahead sees the player), a
parked car is immovable, and robots dive out of the way (dodge.ts) or, when reached, stop the car
dead like a bollard. Nothing records damage. People and animals are never car obstacles at all
(dodge.ts guarantees them), and trees, lamp posts and other props do not exist in the simulation
(they are renderer-only, so a car drives straight through them).

## SIM_VERSION

`SIM_VERSION = 11` (9 reserved for World, 10 taken by the weather PR #29). `upgradeState` steps 8 ->
11 with no field rewrite: every new field is optional (`ext.impacts` absent until the first hit;
`AgentState.knock` / `.dents` absent on untouched agents). When 9 / 10 land first, the chain
becomes ... -> 10 -> 11 with the same no-rewrite step. Older fixtures are kept.

## Design decisions (recorded here; design.md decision log updated with PR 2)

- Car vs car (design already says "Car-to-car contact dents cars (car condition 0-100) and costs
  repair money, never runway"): implemented as momentum exchange along the contact normal (player car
  1,400 kg, robotaxi 1,800 kg, restitution 0.25, a little contact friction) with an off-centre spin
  kick. Condition loss is from each body's change of velocity; at 0 the car limps (no throttle above
  9 m/s). **Repair money and the garage are not wired yet** (Sim-Player owns the wallet): as a
  placeholder, condition comes back 1 point a second after 20 s without a hit.
- Robotaxis hit hard enough (velocity change >= 0.4 m/s) leave their lane: slide, sit with hazards
  and horn (mode `honk`), turn in place if needed, and rejoin the lane on a connector from where they
  stand. They are removed only if still off-lane after 30 s with nobody within 60 m.
- People are untouchable: every sliding body treats people, animals and players on foot as circles
  grown by 0.8 m and stops dead against them. The dodge still runs after impacts and still guards
  everyone.

## Vehicle dynamics (coordinator assignment, 2026-10-24): branch `work/impacts/car-dynamics`

Stacked on #50, SIM_VERSION 15 on that line (14 is impacts); the coordinator restamps the order at merge.
Numbers for the Dodge stream (session_018jNDGsP8HczyRRV3vD22e3):

- Player car top speed is about **54 m/s (195 km/h)** flat out. The speed cap is 62 m/s downhill (was 30 and 50).
- **0-100 km/h takes about 5.5 s.** The launch is gentler than before: 6 m/s² at most, then 110 W/kg against drag.
- **Brakes** are ABS-limited at tyreMu·g, about 10.3 m/s² dry and 7.4 m/s² at weather traction 0.72 (was 22). Stopping from 100 km/h takes about 36 m dry and 49 m wet.
- **Lateral grip** is about 1.05 g, up to 1.42 g at the front with full weight transfer. dodge.ts reads `CAR_MAX_DV_PER_S` and `CAR_MAX_TURN_ACCEL` from car.ts, and a player's car's reach now bounds its yaw change within a step.
- Robotaxis and service vehicles keep their own speeds: lane followers, and the follower's `maxSpeed`.
- The real-SF clearance soaks and dodge fuzz pass at these speeds, plus a new flat-out run from 50 m/s.

## SIM_VERSION per PR

PR 1 = 11, PR 2 = 12, PR 3 = 13, each with a no-rewrite `upgradeState` step (8 -> 11 -> 12 -> 13)
and its own replay/composed fixtures beside the older ones. If they merge together the chain is
the same; nothing reuses a stamp with different behaviour.

## Files touched outside the impacts module (for their owners)

- `src/sim/collide.ts` (World / Sim-World): `Circle.body?`, `ImpactBody`, `BoxResolve.circle`.
- `src/sim/car.ts` (Sim-World): mass, `bodyHit`, `spinKick`, `stepCar(..., contacts)`.
- `src/sim/step.ts`, `src/sim/contract.ts`, `src/sim/motion.ts` (Sim-World): wiring, SIM_VERSION 11,
  knocked bodies skipped by motion proposals.
- `src/sim/agents.ts` (Sim-Agents): two optional `AgentState` fields (`knock`, `dents`).
- `src/sim/dodge.ts` (Dodge, session_018jNDGsP8HczyRRV3vD22e3): a knocked robotaxi is measured by
  its knock velocity and yaw, not its lane route (three one-line conditions); a player's car's
  reach (`vehicleOfCar`) now also bounds the velocity change a shove can give it mid-step and the
  push out of a building after a spin swings a corner in (found by the existing reach test, kept
  exact); PR 2: robots no longer dive for a player's car and a knocked robot is not a dodger;
  PR 3: street props count as bodies in a car's reach.
- `src/sim/agents/runtime.ts` (Sim-Agents, PR 2): good robots no longer get the "vehicle" avoid
  stimulus from a player's car (people and animals still do).
- `src/sim/game-systems.ts` (Sim-World, PR 2): `rammedRobotFacts` turns "a player's car knocked a
  good robot over" into the existing `economy.penalty` fact ($30, -3 reputation).
- Render (Lane R, session_01K4HE49AUF6waq4TuKbdd3r): new files `src/render/impact-layer.ts` (PR 1)
  and `src/render/prop-damage.ts` (PR 3). Hook lines: `src/main.ts` (construct + `update` each frame,
  debug handles `__fogcityImpacts`, `__fogcityProps` under `debug=1`), `src/render/foliage.ts`
  (`setOverride`, one line in `update`), `src/render/scene.ts` (`setFoliageOverride` pass-through).
- Harness: `tests/e2e/impacts.spec.ts` (new), `docs/testing.md` row, `tests/golden/*-v11..13.json`
  (new; older kept), `tests/golden/composed.test.ts` import, `tests/sim/dodge-soak.ts` ram driver.

## Requests to other streams

- Audio (session_01VDSn9WMvqcRCHoSVrG3VgK): impact sounds. Source: `state.ext.impacts.events`
  (`ImpactEvent`: durable `id`, `tick`, `kind` car-car / car-taxi / taxi-car / taxi-taxi, position,
  closing `speed` m/s, `dv` m/s). Wanted: a crunch scaled by `dv` (light bump < 3, crunch 3-8, big
  smash > 8), a scrape, and a robotaxi horn while a robotaxi's `mode === "honk"` and `knock` is set.
- City life (session_016EZ6L7tmyK2MnsHG59Dc1v): robotaxis queue behind a knocked robotaxi with
  today's look-ahead; any lane-change-around behaviour is yours.

## Follow-ups for other streams

- Sim-Player: repair money and the garage for car condition (design: "costs repair money", "in the
  shop at 0"). Today condition limps at 0 and recovers by itself after 20 s without a hit.
- Sim-Agents / combat: a rammed bad robot could become `alerted` (it "heard" the crash); a knocked
  bad robot could be easier to rust while down. Not done: combat state is theirs.
- World detail: props placed from real data join through `world.props` (`PropPlacement`: id,
  kind, x, z) with the specs in `src/sim/props.ts`; draw them and read `ext.impacts.props` for
  their broken state.
- Audio: see the request above; PR 2 adds `car-robot` / `taxi-robot` / `robot-robot` events with
  `fell` and `disabled`, PR 3 `car-prop` with `broke` (thud vs crack; a hydrant hiss while
  `ext.impacts.props["hydrant:..."]` is set).

## Log

- 2026-10-23: started from `ff7db5b`. Read handoff, design, car/step/agents/dodge/motion.
- 2026-10-23 23:15 UTC: PR 1 pushed (`348c74a`); PR 2 (`d87ebfd`+e2e) and PR 3 (`5018313`+e2e) committed
  in worktrees. Full unit suite green on PR 1; browser suite in progress.
- 2026-10-24 00:50 UTC: all three PRs opened as drafts and watched: #50, #57, #62. Each stacks on the one below.
- 2026-10-24 05:30 UTC: integrate `59e5a7b` (v13) merged into #50 and forwarded: #50 v14 (`1e8a7c8`),
  #81 v15 (`14894be`), #57 v15 (`bd260b5`, robot e2e driver now backs out of walls), #62 v16
  (World detail's real SF trees, signal poles and signs are the sim's props via src/io/world-load.ts;
  `propKnock(state, id)` accessor). Local only: `junction-deadlock-sf` times out at 180 s here on the
  unmodified base too.
