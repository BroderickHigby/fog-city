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

Playwright chromium (SwiftShader) on `1cfaa6ec`: 39 passed, 10 failed. Baseline reruns of the 10 failures on main and the snapshot are in progress; results follow in the next commit.

## What is left, in order

1. Decide the engine audio (above).
2. Diagnose `ram-soak` liveness under combined v21+v24 traffic.
3. Fix the snapshot's own failures: forbidden APIs, `activity-rules.json` contract, Presidio checkpoint.
4. Re-record composed and wave2 goldens at v24 once behaviour is accepted.
5. Still open from IMPLEMENTATION_LEDGER.md: mission completion by real controls, traffic/bridge
   behaviour, audio listening proof, sustained performance inside the 1 GB target, independent
   Standards/Spec review.
6. One orchestrator session merges. This branch is not for merge until 1–5 are done.
