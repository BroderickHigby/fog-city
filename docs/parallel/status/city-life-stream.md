# City life stream (`city-life`)

Owner feedback (live build `ff7db5b`): "when there's a car stopped in the middle of the road,
everyone should go around the car" and "there should be more robots. And there should be a
little bit more action."

## Now

- **PR 1, going round stopped vehicles** — [#38](https://github.com/BroderickHigby/fog-city/pull/38)
  (draft), branch `work/city-life/overtake` (from `origin/integrate/wave2` `ff7db5b`).
  SIM_VERSION **10** (9 stays reserved for the World stream's structural integration). Local:
  typecheck, full vitest and the new Chromium check on real SF pass; waiting on CI.
- **PR 2, more robots and more action** — next, on `work/city-life/robots-action`.

## PR 1: going round stopped vehicles (SIM_VERSION 10)

What changes in the game:

- **Robotaxis** held behind a vehicle that is standing still (a player's parked or abandoned car,
  a parked van or bus, a seized robotaxi) wait 4 m back for 1.5 s, check the road, then ease out,
  pass and merge back (`src/sim/overtake.ts`, wired in `src/sim/agents.ts`). The check covers
  oncoming and adjacent traffic predicted along its heading, people with the robotaxis' existing
  walker berth, buildings and the kerb; the pass happens only inside the carriageway. If the road
  stops being clear before it is alongside, it eases back in and waits again. One that pulled up
  bumper to bumper backs up to the standoff first, if the way behind is clear. While passing it
  claims the road ahead of it: oncoming robotaxis stop short of the claim, and neither the
  deadlock breaker nor the mutual-yield rule ever lets a robotaxi drive into a pass.
- The pass profile is a pure function of arc length on the lane, so the probe, the people berth
  and the dodge's prediction (`agentRouteAt`) follow exactly where the robotaxi will drive.
  `dodge.ts` is untouched.
- **Walkers** (people and robots, the runtime sidewalk followers the game uses) whose route runs
  into a vehicle standing still walk round its nearer bumper to the first clear point of their
  route beyond it (`src/sim/agents/detour.ts`, wired in `src/sim/agents/runtime.ts`). Moving
  vehicles stay the dodge's business.
- People no longer stop to "glance" at a player sitting in a stopped car (they glanced every tick
  while within 4 m and froze around it); they still glance at a player standing near them.

Versioning: `SIM_VERSION = 10`; `upgradeState` restamps 8 → 10 (both new fields are optional and
absent from older saves). New fixtures: `tests/golden/legacy-saves/v8-parked-car.json`, a real v8
save recorded with the v8 code at `ff7db5b`, and `tests/golden/composed-v10.json`. The older
`composed-v8.json` and all legacy saves are kept. **If World's v9 lands first, the chain becomes
8 → 9 → 10**; my step is a pure restamp, so it rebases trivially.

Tests:

- `tests/sim/overtake.test.ts` (closed loops on the grid city): robotaxis pass a parked car and
  merge back over three seeds with no overlap and no contact, and none waits 8 s; a robotaxi waits
  for an oncoming one before pulling out and never comes within 6 m of it while out of its lane;
  one stopped bumper to bumper backs up and passes; with two cars side by side across the street
  it waits and honks and touches nothing; determinism; in the game composition, people and robots
  walk round a car parked across a crosswalk (nobody stands at it 2 s, zero contacts).
- `tests/sim/city-life-version.test.ts`: the v8 save upgrades with every field kept and steps on
  to a pass, identically after a JSON round trip.
- `tests/e2e/city-life.spec.ts` (Chromium, real SF): get out at the spawn, mid-lane on The
  Embarcadero, and walk to the pavement; the page replays the 8,069 planned frames, a robotaxi
  goes round the abandoned car, zero contacts, and the page reaches Node's exact state (passed
  locally, 4.5 min).
- Real SF probe (Node, game systems, 40 s per street): Drumm St 2 passes, longest wait 5.5 s,
  0 contacts.
- Sim bench (single anchor, 900 ticks): mean 8.2 ms vs 7.8 ms at `ff7db5b` (within run noise).

Files outside the usual Sim-Agents/Sim-World split, for the record: `tests/e2e/city-life.spec.ts`
(Harness), `tests/golden/*` new fixtures (Harness), `tests/sim/agents.test.ts` (one assertion now
expects the new 4 m standoff instead of the old 1.5 m gap).

Known, pre-existing, not changed: the robotaxi deadlock breaker (`GHOST_TICKS`) can still let two
robotaxis squeeze through each other at a gridlocked junction far from any pass (seen on the grid
city with seed 23 on the old code too).

## PR 2 plan: more robots, more action

- Robot presence per district and hour from data, raising Footmen and Trundles toward the
  design's 3–4 robots per person, inside the existing per-player cap and LOD.
- Stage the Ambient Director's cards for real (today `director.stage` is emitted and nothing
  spawns): a snatch, a delivery bot blocking a crosswalk, a robotaxi standoff, a malfunction
  spree, with street-level bounty blips on the map.
- Pacing tuned so something is within 150 m most of the time, without spam.

## Requests for Lane R

- None yet. Ad drones, Patrol units and Sign-spinners (wave-3 roster) have no models; until they
  exist, PR 2 raises presence with the existing Footman, Trundle and robotaxi models only.
