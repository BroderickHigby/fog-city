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

- **Version renumbering pending (coordinator, 22:37):** Gameplay weather PR #29 takes
  SIM_VERSION 10 and lands first. When it merges into `integrate/wave2`, merge it here and
  renumber the structural physics to the next unused number (likely **11**), chaining
  10 → 11. The v9-labelled fixtures (`composed-v9.json`, `wave2-v9.json`) never shipped, so they
  are re-recorded as v11 rather than kept. v7/v8 (and weather's v10) fixtures stay.

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

## Reproducibility (PR a)

- The pinned raw cache is not recoverable: no git ref on origin carries `pipeline/.cache`
  (gitignored), no dangling objects exist, and the original build machine's disk is gone.
  The pipeline never recorded input hashes, only the label `snapshotDate: 2026-10-23`.
- DataSF answered HTTP 200 (redirect to `data.sf.gov`); Socrata has no as-of queries, so the
  current datasets were fetched (181 responses, 389.7 MB), resumable through DataSF's 425
  throttling.
- Offline `--check` of the held world against that cache: **1,192 / 1,203 files byte-identical**,
  including the collider pack, every collider, roads and far cells. The 11 differences all
  derive from the daily business registry (`g8m3-pdis`): `storefronts.json` (10,478 → 10,481
  anchors), `report.json` counters, nine shopfront-bearing tile GLBs.
- Recorded as explicit snapshot `2026-10-23T21:20Z`: hashes in `pipeline/source-snapshot.json`
  (verifier `pipeline/tools/source-snapshot.ts`), diff summary in `docs/data-sources.md`
  "Snapshots", tiles regenerated (no hand edits).

## Strict gate at the import (`world-pr`, merged tree)

53 passed / 78 failed / 7 skipped. Of 116 metrics: 67 better, 37 same, **12 worse**:
freeway max grade 143.22 → 345.06 % (US-101 Golden Gate approach `c19205000`), drawn road vs
sim surface 3.84 → 6.6 m (Broadway Tunnel `c3186101`), stopped routes 2 → 3, placement rise
0.34 → 1.69 m (`c9329000`), airborne crossings 66 → 70, far hulls off 3 m 44 → 110, duplicates
23 → 26, buried walker stops 29 → 30, below-surface 0.173 → 0.404 m, Sutro area +4 cm, two
millimetre route metrics. These are PR (b)'s list.

**Southern boundary (2.1978 m) root cause:** not a collision or sweep defect. The test's start
pose (50 m back from the edge) at x 1450–1480 lands on a 30 m land-wall notch at the creek
shore (z 9620), so the car *starts* 2.2 m across that wall; the measured overshoot is that start
pose (2.200 at tick −1, 2.198 at tick 0) and never grows. From all 21 starts clear of every
wall, at both southern land edges, the car stops at the county line with 0.000 m overshoot.
Fix in PR (b): the probe rejects start poses that already straddle a wall; the 0.02 m
assertion stays.

## Lane R requests (for PR d)

- Cherry-pick `b0914fb` (`feature/ferry-showcase`, lit office floors at night in
  `facade-shader.ts` / `far-layer.ts`) if it applies cleanly and render tests pass; otherwise
  record here and Lane R patches after (d) lands.
- `showcase.ts`, `detail.ts`, sidewalks/kerbs (`sidewalks.ts`), the house-kit facade shader and
  `structures.ts` reach `integrate/wave2` only through PR (d).

## Salvaged commits

- `qa/world-integration` `4556f8a` (merged in `4244369`).

## Log

- 2026-10-23: import merge `4244369` pushed. Unit project on the merge before fixes:
  3,445 passed, 16 failed, 1 skipped; after merge-fallout fixes the remaining reds are the
  pre-existing list above.
