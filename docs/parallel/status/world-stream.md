# World stream status

Stream id `world`. Scope: handoff §4 (held world), §5 (renderer wiring) and the structural
commands of §10. Coordinator session: `session_012u6jdJxkY41mYkqG3yG9Xk`.

## Stack

| PR | Branch | Seam | State |
| --- | --- | --- | --- |
| (a) | `work/world/source-cache` | Structural world import as SIM_VERSION 9, source cache and pipeline reproducibility | in progress |
| (b) | `work/world/defects` | Generator, collision and sweep fixes for the §4 defect table | in progress, pushed, no PR yet |
| (c) | `work/world/physics` | Height-aware motion, surface-aware recovery, agent surfaces, migration tests | in progress, pushed, no PR yet |
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

## PR (b) progress (`work/world/defects`)

Merged root-cause fixes (code only; tiles regenerate once after all groups):
- Freeways that run off the world over water hold their height (US-101 Golden Gate approach,
  I-80 onto the Bay Bridge east span): max freeway grade 345.06 → 133.07 % (baseline 143.22).
  Creek bridges span to the highest dry ground 15–45 m inland: dipping decks 3 → 0, bridge
  runs failing 13 → 7.
- Footprints generated twice dropped (newer-parcel lots retire the footprints they enclose;
  nested multi-part rings): duplicates 26 → 6, coplanar roofs 11 → 0. Far hulls cover each tall
  record's centroids: far hulls off 3 m 110 → 88.
- Stairway barriers never stand in a meeting street's carriageway (the Twin Peaks route's wall);
  street corridors widen on bends by the car's swept path (Lombard hairpin); roofs clear the
  ground at their walls' feet too: stopped routes 3 → 1, named runs stopped 3 → 1, buried
  walker low walls 30 → 28.
- Southern boundary: probe start poses that straddle a wall are rejected, the probe drives ≥ 12
  approaches over 6 lanes at three headings, 0.02 m kept; a recovery test shows clearCarSpot
  never produces such a pose (coordinator's three conditions).
- Pack test: lake flags vs cover digits and building undersides compared exactly.

Open, with evidence:
- Placement rise 1.69 m and the Twin Peaks route's 0.93 s airborne: every ground cell is split
  along one fixed diagonal, which makes a shelf then a 54 % drop on some slopes. Fix: a
  data-chosen diagonal in every consumer (pipeline mesh, terrain, terrace, ribbons, far mesh,
  sim, gate copy, renderer). Next, after the Broadway agent finishes in the same code.
- Gate measurement questions, to be settled by measuring both the 544f67c world and the
  candidate with a corrected measurement, never by raising a baseline: the road follower starts
  freeway edges at ground height under viaducts (insideFootprints 113 m, the remaining 133 %);
  far hulls compared with the record's own roof under its own tower (82 of 88); buried low walls
  compared with the record carrying the original id rather than the wall touched (28); the
  California route follower overshooting a 100° turn; Sutro's 4 cm from a vertex-mean shift.
- Broadway tunnel road/sim disagreement (6.6 m) and below-surface travel: agent still working.

### Gate measurement corrections, checked on the 544f67c baseline world

`73845a9` corrects three measurements to what their metrics name. Each was run on the 544f67c
world (its tiles under current code, `/home/user/fog-old`) as well as the candidate. Metrics whose
measurement did not change reproduce their recorded baselines exactly there (carriageway 384,
Lombard 2, pedestrian 62, freeway inside footprints 435, low hulls p99 8.3), so the comparison is
sound. Corrected values on the baseline world:

| Metric | Recorded baseline | Corrected, 544f67c world |
| --- | ---: | ---: |
| `N.far.tallHullsOff3m` | 44 | 9 |
| `F.buried.walkerLowWallStops` | 29 | 0 |
| `C.freeway.maxGradePct` | 143.22 | 139.07 |

The corrections are stricter, not looser. The candidate is held to the corrected old-world value
(the baseline is lowered to it), never to the old looser number.

## PR (c) progress (`work/world/physics`)

- `fb915d6` cherry-picked (conflict resolved keeping per-player `ownerId`).
- Runtime walkers: admission, accepted step and swept segment at the body's band; stacked-level
  bodies ignored. sf-agents' "in a building" failure was a body under a span (underside 4.7 m up).
- clearCarSpot/spawn/join take a level hint (`Spawn.y`, additive); exit and enter are level-aware;
  mission parking bays on the road's own surface; projectiles find the surface at their level.
- Each new test file fails on the code before its fix.

## Salvaged commits

- `qa/world-integration` `4556f8a` (merged in `4244369`).
- `qa/agent-surfaces` `fb915d6` (cherry-picked as `a5085d8` on `work/world/physics`).

## Log

- 2026-10-23: import merge `4244369` pushed. Unit project on the merge before fixes:
  3,445 passed, 16 failed, 1 skipped; after merge-fallout fixes the remaining reds are the
  pre-existing list above.
