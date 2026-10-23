# World stream status

Stream id `world`. Scope: handoff §4 (held world), §5 (renderer wiring) and the structural
commands of §10. Coordinator session: `session_012u6jdJxkY41mYkqG3yG9Xk`.

## Stack

| PR | Branch | Seam | State |
| --- | --- | --- | --- |
| (a) | `work/world/source-cache` | Structural world import as SIM_VERSION 9, source cache and pipeline reproducibility | in progress |
| (b) | `work/world/defects` | Generator, collision and sweep fixes for the §4 defect table | not started |
| (c) | `work/world/physics-v9` | Height-aware motion, surface-aware recovery, agent surfaces, 8→9 migration tests | not started |
| (d) | `work/world/render-wiring` | §5 `main.ts` wiring, structural renderer files, camera/tunnel probes | not started |

## Decisions

- **SIM_VERSION 9 is stamped in PR (a)**, in the same commit that imports the structural
  physics, so no branch targeting `integrate/wave2` ever carries structural physics under the
  gameplay-only v8 stamp. `upgradeState` chains v7 → v8 → v9 with no field rewrite. PR (c)
  adds the surface-aware load/join recovery and the real-save migration tests.
- The structural branch was merged (merge commit, authorship kept), not re-applied by hand.
  Conflicts were resolved by keeping `integrate/wave2`'s registry, parking, street-cleaning,
  transit and sidewalk layers; only comments and version stamps were combined.
- The renderer branch's storefront-kit / house-palette / landmark-tag schemas stay with their
  content files and land in PR (d), not (a): the world branch carried the schemas without the
  content, which broke content validation.
- v7 and v8 golden fixtures are kept unchanged. New v9 pins: `tests/golden/composed-v9.json`
  (coverage identical to v8 in every scenario; only hashes move, the version is hashed) and
  `tests/golden/wave2-v9.json`.

## Known red at the import checkpoint (pre-existing on `qa/world-integration`)

Verified by running the same tests on a pristine `qa/world-integration` checkout:

- `tests/sim/pack.test.ts`: the committed pack and the per-tile JSON disagree on `cover`.
- `tests/golden/world-baseline.test.ts`: the gate's drawn-ground reader vs the renderer's tint hook.
- `tests/sim/sf-agents.test.ts`: one agent enters building `201006.0000158-b4`.
- `tests/sim/boundary.test.ts`: 2.1978 m southern-boundary overshoot (limit 0.02 m).
- The strict `world-pr` gate (handoff: 53 passed / 78 failed / 7 skipped).

## Salvaged commits

- `qa/world-integration` `4556f8a` (merged in `4244369`).

## Log

- 2026-10-23: import merge `4244369` pushed. Unit project on the merge before fixes:
  3,445 passed, 16 failed, 1 skipped; after merge-fallout fixes the remaining reds are the
  pre-existing list above.
