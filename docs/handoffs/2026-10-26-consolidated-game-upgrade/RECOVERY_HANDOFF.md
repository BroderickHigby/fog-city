# Recovery handoff, 27 October 2026

The consolidated-upgrade session (`codex/consolidated-game-upgrade` worktree at
`~/workspace/fogcityworktree/consolidated-game-upgrade`) stopped with three local commits and 116
uncommitted files. A second session tried to save them to GitHub, but no branch reached the
remote. This branch saves that work and merges current `main` into it.

- Branch: `recovery/consolidated-game-upgrade`
- PR: https://github.com/BroderickHigby/fog-city/pull/118 (draft). The ledger's integration PR,
  https://github.com/BroderickHigby/fog-city/pull/107, is still the documentation seed. Close one of
  them in favour of the other when the work lands.
- The original worktree is unchanged: the snapshot was written through a temporary index.

## Update, 28 October (cloud coordinator session)

Commits on top of `0e48de15`:

| SHA | What |
| --- | --- |
| `14a2d195` | Merge `origin/main` at `4b3167d6` (#119 cover art, #120 Runway Run, #121 stick dead zones, #122 engine gears). Nine conflicts, both sides kept. Runway Run needs no state change; its version pin follows the branch to 24. main's `EngineClock` gearbox now drives the engine params, with the recovered recording tags kept. |
| `ff758076` | The recovered sim and content now pass their contracts: `sq()` (new in `dmath.ts`) and `Math.sqrt` replace `**` and `Math.hypot`; faction events are `faction.pauserCompleted` / `faction.acceleratorCompleted`; `maxSpeedMps` is in the schema; the Pauser label names Embarcadero Plaza (legal checklist); eight checkpoints moved onto open, reachable ground (Crissy Field to Mason Street, 190 m; the Bernal viewer 56 m; the rest 4-18 m); Coit Recon is offered (`coit-viewer.ts` produces `recon.viewerCompleted`). |
| `ec21b6ed` | Impacts, v24: a knocked slide that meets someone's clearance stays where it was. This was the city-life contact. A bus nudged from behind slid 0.44 m toward a waiting walker, because `resolveBox`'s person push spent the push budget and the wall settle then overshot. |

Full unit run (`ff758076`): 4,726 pass, 11 fail. 6 composed goldens (re-record at v24 once the
behaviour is accepted), plus `wave2-interface`, `perf-budget` and two `junction-deadlock-sf`
cases, all inherited as listed below. The 11th is `ram-soak` "flat out, no brakes": 274 m of
the 300 m floor, with no contacts, failures or jumps. On main the car glances off robotaxi #77 at
tick ~470 and drives 513 m. Here #77 reaches that point about 30 ticks later (v24 junction
hulls), the hit is head-on, and the car pushes the knocked robotaxi to rest until the soak
driver reverses. That is physically plausible, but the gate stands: it is not loosened.

Browser (SwiftShader):
- `city-life` passes (it failed before `ec21b6ed`).
- `demo-day` fails, "the update pusher never began its channel". Planned in Node from the page's
  own initial state, the same code completes from one boot's state and fails from another. The
  pusher starts an update the tick the scene is staged, and whether it is cancelled before it
  converts the guest depends on boot timing. The driver's assumption needs a fix: it should wait
  for the channel only if the guest is still unconverted, or the stage should not admit an
  update before the player arrives. **Current main (`4b3167d6`) fails the same way** in the same
  browser run (7.8 min, same error), so the merge does not cause this. It broke on main after
  `fcf590b7`, or it was always sensitive to boot timing.
- `sf-world` "buildings near the Ferry Building are on screen" fails on "tiles settled", alone
  and in a batch, and **fails identically on current main**, so the merge does not cause it. The
  rest of the file stops there, so the "asset models" case named in the table below was not
  reached this time.

Other open points:
- The robotaxi that goes round the abandoned car (`city-life`) only offsets 0.24 m and then waits,
  honking. The test passes, but the owner asked for traffic that actually drives round stopped
  cars.
- The engine audio decision below still stands. The recordings play; main's #111/#122 synth is
  computed but not heard.

## Commits

| SHA | What |
| --- | --- |
| `7d86a68d`, `163f011d`, `96048e15` | The interrupted session's local commits (ledger, feature foundations, vehicles/landmarks/audio) |
| `48306f89` | Snapshot of the 116 uncommitted files (64 modified, 52 new), byte-for-byte from the worktree |
| `34e0e465` | Merge `origin/main` at `fcf590b7` (25 commits, 19 conflicts) |
| `17617b5b` | Merge `origin/main` at `c602ded8` (#110 hair, #111 engine sound) |
| `1cfaa6ec` | Recovered tests and match carry moved to SIM_VERSION 24; ui-copy hash |

## Sim version reconciliation

main used v21 (robotaxi amber commit), v22 (steal car) and v23 (late dodge). The recovered work had
also claimed v21 for its own rules. Those rules are now **v24**:

- `SIM_VERSION = 24`. `upgradeState` restamps 21→22→23→24 with no field changes.
- Only lines the recovered work added were renumbered (`version >= 21` → `>= 24`, `simVersion ?? 21`,
  and the test helpers' positional version arguments). main's `amberCommit = prev.version >= 21` is
  unchanged.
- `src/sim/agents.ts`: amber commit and 5 m junction hulls combined. `committedOnAmber` reads
  `scheduleTick`, the tick the recovered code reads signal aspects with.
- `src/sim/combat/adapter.ts`: collapsed-silhouette pass (v24) plus main's stolen-car wall exclusion.
- `src/sim/modes/carry.ts`: `rankForXp(xp, 24)`. It still said 21, which ranked carried XP on the
  legacy table.
- The recovered fixtures were renamed `-v24`. main's v20–v23 composed goldens stay as upgrade inputs.

## Audio: a decision for Brody

The recovered build plays **recorded** engine audio (`RecordedDrivingAudio`, `public/audio/vehicle*`).
main's #111 four-cylinder synth (`vehicle-synth.ts`) is merged and its params are computed, but the
mixer no longer plays the synth for the player's car. Keep the recordings, or bring the synth back
as the fallback or default.

## Test status (merged tree, `1cfaa6ec`)

`tsc --noEmit` passes. The full vitest run (before the last fixes) had 71 of 4,646 tests failing.
Every one of those files was rerun on the merge, on the pre-merge snapshot and on main:

**Fixed (merge-caused):** 49 tests: upgrade-chain pins, recovered tests passing `21` as the
current version, carry rank, ui-copy hash.

**Already failing before the merge (not caused by it):**

| Test | Fails on | Note |
| --- | --- | --- |
| `golden/composed.test.ts` (6) | snapshot | Goldens not re-recorded after the recovered behaviour changes. Re-record at v24 only after the behaviour is accepted (`node scripts/golden/composed.ts`). |
| `sim/forbidden-apis.test.ts` (6) | snapshot | `Math.*`, `**`, and a DOM word in coit-observation, coit-viewer, agents, lures, placement, pause-timers. Use `dmath.ts`. |
| `content/{schemas,taste,gameplay-catalogs}` (3) | snapshot | `activity-rules.json` definition 16/17: extra property, event id `faction.pauser-completed` breaks the id pattern, R-Evolution checklist label. |
| `player/activity-availability`, `activity-checkpoints-sf` | snapshot | `presidio-loop:coast` checkpoint is 190 m from any street. |
| `junction-deadlock-sf` (2), `perf-budget` | snapshot and main | Robotaxi standstill limit; allocation 8.1 MB/tick against a 4.5 MB baseline. |
| `wave2-interface` | main | Also red on main. |

**Open, merge-caused:** `impacts/ram-soak` "flat out … no brakes": safety holds (no contacts, no
override failures, no jumps), but the car drives 274 m of the 300 m floor. It passes on main and on
the snapshot. The cause is the combined traffic (amber commit plus junction hulls) on that seeded
route, and it hasn't been diagnosed.

## Browser QA

The in-app browser could not hold a WebGL context in a hidden pane, so QA ran the Playwright chromium
suite (SwiftShader) against the dev server at `1cfaa6ec`: **39 passed, 10 failed**. The 10 failures
were rerun on main (`fcf590b7`) and on the pre-merge snapshot (`48306f89`):

| Spec | Merge | main | Snapshot | Cause |
| --- | --- | --- | --- | --- |
| `demo-day` "Demo Day completes in SF" | fail | pass | pass | **Merge.** `demo-day-driver.ts:171` "The update pusher never began its channel". |
| `city-life` "traffic goes round a car abandoned mid-lane" | fail | pass | fail | Recovered work, **made worse by the merge**: on the snapshot no agent goes round the car (`seen.size` 0); on the merge an agent touches it (`contacts: 1` at tick 5203, `gameplay-driver.ts:36`). Same combined-traffic area as `ram-soak`. |
| `sf-world` "renderer draws it with the asset models" | fail | pass | fail | Recovered work: five `civilian:*` car models drawn that the spec does not list. Update the spec if the civilian cars are intended. |
| `determinism` (render pokes; 600-tick multiplayer), `weather` | fail | fail | fail | Already failing on main: browser and Node states part after chunk 0. |
| `dynamics` "W pulls away at an EV's rate" | fail | fail | fail | Already failing on main (pull 4.5 against > 5). |
| `multiplayer`, `realism`, `web-build` | fail | fail | fail | Already failing on main (timeouts on boot / surface textures under SwiftShader). |

Logs: `$TMPDIR/e2e.log` and `$TMPDIR/e2e-baselines.log` on Brody's Mac (not committed).

## What is left, in order

1. Decide the engine audio (above).
2. Fix the merge-caused failures: `demo-day` update pusher, then `ram-soak` liveness and the `city-life`
   contact under combined v21+v24 traffic (likely one cause).
3. Fix the snapshot's own failures: forbidden APIs, `activity-rules.json` contract, Presidio checkpoint.
4. Re-record composed and wave2 goldens at v24 once behaviour is accepted.
5. Still open from IMPLEMENTATION_LEDGER.md: mission completion by real controls, traffic/bridge
   behaviour, audio listening proof, sustained performance inside the 1 GB target, independent
   Standards/Spec review.
6. One orchestrator session merges. This branch is not for merge until 1–5 are done.
