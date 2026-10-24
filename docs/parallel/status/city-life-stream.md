# City life stream (`city-life`)

Owner feedback (live build `ff7db5b`): "when there's a car stopped in the middle of the road,
everyone should go around the car" and "there should be more robots. And there should be a
little bit more action."

## Now

- **PR 1, going round stopped vehicles**: [#38](https://github.com/BroderickHigby/fog-city/pull/38),
  merged into `integrate/wave2` (with the real-SF junction deadlock fix). Follow-ups made after the
  merge (a narrower general step-out for walkers, the junction soak at 40 s) are folded into PR 2.
- **PR 2, more robots and more action**: branch `work/city-life/robots-action`, merged with
  `integrate/wave2` `59e5a7b` (v13), stamped **SIM_VERSION 14** (13 → 14 is a pure restamp).
  CI is blocked by billing, so the PR stays a draft with local evidence posted on it.
- Next: readable robots (visible tells, a first-time explainer, plain scan reasons, a map legend;
  intro text coordinated with Missions).

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

## PR 2: more robots, more action (SIM_VERSION 14)

- `content/city-life.json` (schema, provenance hash, `src/content/cityLife.ts`): density per kind
  by hour band and district, the bad-robot share (never raised in protected areas), director
  pacing, and three new incident cards (crosswalk squatter, robotaxi standoff, malfunction spree).
- The street mix shifts toward robots **without adding bodies**: population is trimmed out of view
  so the agent total stays at or below the old one.
- The Ambient Director's cards are staged for real (`src/sim/agents/incidents.ts`) 25–70 m from the
  player: snatch, crosswalk squatter, nose-to-nose robotaxi standoff, malfunction spree. They show
  as bounty blips and cards; robots flagged by Bot Check and bad robots on to you show on the map.
- Real-SF soak (wave 3, seed 7, a minute at each hub): bad robots within 300 m, mean, FiDi 15.3
  (12.3 before), SoMa 23.3 (19.8), Marina 11.3 (7.3), North Beach 5.8 (4.7); about one incident
  a minute; agents 434/357/367/418 (before 445/379/410/429); 16.7–19.9 ms/tick on the test
  machine with probes, the same as before.
- Known limit: a car abandoned inside a junction (on a turn connector) still blocks that turn.

## Requests for Lane R

- None yet. Ad drones, Patrol units and Sign-spinners (wave-3 roster) have no models; until they
  exist, PR 2 raises presence with the existing Footman, Trundle and robotaxi models only.
