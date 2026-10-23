# Full-suite QA triage — 2026-10-23

## Scope and exact counts

- Snapshot: `/tmp/fog-city-final-tests.json`, measured commit `b788d11b1685c6d87870fb8de72b72fbc409fee0`; all 12 world measurement files carry that commit, timestamps 01:51:47–01:53:11 UTC.
- 143 test files: 131 passed, **12 failed**. **3,062 passed, 92 failed, 1 pending = 3,155 tests**. JSON also reports 575 nested suites (550 passed/25 failed); those are not file counts.
- Failure partition: **65 stale-value ratchets + 21 numeric regressions + 2 named-run regressions + 2 definition mismatches + 2 content checks = 92**.
- Of the 65 stale ratchets, **29 meet their acceptance target**, while **36 still miss the target** despite improving >10%. Tightening their baselines alone does not complete those defects.
- Pending: `tests/content/composer.test.ts` / `UPDATE_BANNED_PAIRS: rewrite content/banned-pairs.json` (maintenance rewrite test). No socket/setup failures appear in this run. The failed files are all world-gate/content checks; no net/server/dodge unit file failed.

## Failed files and first diagnostic

| File (`tests/` prefix) | Failed | Breakdown | First diagnostic |
|---|---:|---|---|
| golden/world/buildings.test.ts | 22 | 1 definition, 4 numeric regression, 17 stale ratchet | Accounting description differs; separately, 2,667 source footprints do not reconcile. |
| golden/world/cover.test.ts | 6 | 5 stale ratchet, 1 numeric regression | Beaches improved 0 → 0.771, so baseline is stale; shore-green area regresses. |
| golden/world/drive.test.ts | 13 | 8 stale ratchet, 4 numeric regression, 1 run regression | Bridge failures improved 16 → 13; four numeric and one named-run regression remain. |
| golden/world/edge.test.ts | 8 | 1 definition, 6 stale ratchet, 1 numeric regression | Wall-sample description says 97 starts; current measured population is 92. |
| golden/world/far.test.ts | 8 | 6 stale ratchet, 2 numeric regression | Far-above-near length improves 83.26 km → 0; coverage/tall-hull checks regress. |
| golden/world/foot.test.ts | 2 | 2 stale ratchet | Walk routes improved 6 → 0; both failures are stale baselines. |
| golden/world/glb.test.ts | 7 | 4 stale ratchet, 3 numeric regression | Double-ribbon share improves 0.062 → 0.053; surface/underside diagnostics also fail. |
| golden/world/houses.test.ts | 3 | 3 stale ratchet | House crack count improves 291 → 205; all three failures are stale baselines. |
| golden/world/routes.test.ts | 5 | 4 numeric regression, 1 run regression | Below-surface depth is 0.404 m versus baseline 0.173 m. |
| golden/world/streets.test.ts | 15 | 14 stale ratchet, 1 numeric regression | Dipping bridge count improves 4 → 3; freeway grade regresses. |
| golden/world/terrain.test.ts | 1 | 1 numeric regression | Fillmore grade is outside the 24% ±1.5% tolerance. |
| content/landmark-tags.test.ts | 2 | 2 content | Ballpark source/pieces are absent; expected ballpark storefronts are absent. |

## Stale ratchets: all 65 failed metric assertions

Owner: Harness coordinates valid baseline tightening with each metric's Pipeline, Render-World or Sim-World owner. Format is **baseline → measured (target)**. These are improvement failures, not worsening values. Keep run-set regressions out of any golden refresh.

### tests/golden/world/buildings.test.ts

- `A.facade.firstStoreyOffStreet`: 0.111 → 0.013 (≤0.01); residual defect remains.
- `A.facade.storeys5m`: 0.611 → 0 (≤0.02); target met.
- `A.ground.lowAboveGround`: 83 → 0 (≤0); target met.
- `A.ground.relief10`: 466 → 2 (≤0); residual defect remains.
- `A.ground.roofUnderGround`: 22 → 0 (≤0); target met.
- `A.landmark.bridgesMissing`: 2 → 0 (≤0); target met.
- `A.landmark.coitHeightError`: 0.199 → 0 (≤0.05); target met.
- `A.landmark.heroWithoutShape`: 10 → 1 (≤0); residual defect remains.
- `A.landmark.sutroTowerTopM`: 0 → 298.15 (≥290); target met.
- `A.newer.cells3`: 13 → 0 (≤0); target met.
- `A.newer.missionRockTall`: 0 → 3 (≥4); residual defect remains.
- `A.newer.publishedHeightFails`: 4 → 2 (≤0); residual defect remains.
- `A.newer.unmatched`: 122 → 0 (≤10); target met.
- `A.phantom.fortPointHeight`: 64.61 → 15.56 (≤25); target met.
- `A.phantom.tallOnStreet`: 11 → 0 (≤0); target met.
- `A.rings.coplanarRoofs`: 24 → 11 (≤0); residual defect remains.
- `A.rings.nonSimple`: 193 → 0 (≤0); target met.

### tests/golden/world/cover.test.ts

- `D.beaches.sandShare`: 0 → 0.771 (≥0.9); residual defect remains.
- `D.foliage.parkTilesShare`: 0 → 1 (≥1); target met.
- `D.lakes.drawnGrassHa`: 5.06 → 0.09 (≤0); residual defect remains.
- `D.parks.greenShare`: 0.437 → 0.882 (≥0.9); residual defect remains.
- `D.parks.propertiesUnder10pct`: 240 → 17 (≤0); residual defect remains.

### tests/golden/world/drive.test.ts

- `F.bridges.failingRuns`: 16 → 13 (≤0); residual defect remains.
- `F.buried.carMaxJumpM`: 23.15 → 0.5 (≤0.5); target met.
- `F.crossings.richlandAirS`: 2.33 → 0 (≤0.2); target met.
- `F.named.runsStopped`: 31 → 3 (≤0); residual defect remains.
- `F.placement.maxJumpM`: 23.22 → 0.5 (≤0.5); target met.
- `F.ram.launches`: 211 → 81 (≤0); residual defect remains.
- `F.sample.runsStopped`: 11 → 3 (≤0); residual defect remains.
- `F.tunnels.failingRuns`: 6 → 5 (≤0); residual defect remains.

### tests/golden/world/edge.test.ts

- `E.freeway.i280Stops`: 2 → 0 (≤0); target met.
- `E.freeway.landEdgesCrossingWalls`: 3 → 0 (≤0); target met.
- `E.gaps.turnRuns`: 156 → 240 (≥156); target met.
- `E.launch.maxRiseM`: 8.94 → 0.74 (≤1); target met.
- `E.launch.sampleLaunches`: 98 → 4 (≤0); residual defect remains.
- `E.net.buildingsWithoutStreet`: 911 → 138 (≤0); residual defect remains.

### tests/golden/world/far.test.ts

- `N.far.farAboveNearKm`: 83.26 → 0 (≤0); target met.
- `N.far.lowHullsP99M`: 8.3 → 6.56 (≤5); residual defect remains.
- `N.far.recordsWithoutHull`: 690 → 315 (≤0); residual defect remains.
- `N.far.ringStepMaxM`: 21.57 → 1.11 (≤2); target met.
- `N.far.ringStepP99M`: 7.44 → 0.91 (≤1); target met.
- `N.far.sanBrunoSummitErrorM`: 402 → 27.54 (≤10); residual defect remains.

### tests/golden/world/foot.test.ts

- `F.walk.routesFailing`: 6 → 0 (≤0); target met.
- `F.walker.verticalFails`: 2 → 0 (≤0); target met.

### tests/golden/world/glb.test.ts

- `N.glb.doubleRibbonShare`: 0.062 → 0.053 (≤0.005); residual defect remains.
- `N.glb.freewayUnderGroundShare`: 0.105 → 0.027 (≤0); residual defect remains.
- `N.glb.groundThroughRoadsShare`: 0.02 → 0 (≤0); target met.
- `N.glb.roadSunkShare`: 0.039 → 0.002 (≤0); residual defect remains.

### tests/golden/world/houses.test.ts

- `H.cracks.sampleBoxPairs`: 291 → 205 (≤0); residual defect remains.
- `H.stoops.blankBandOver2_5m`: 834 → 65 (≤0); residual defect remains.
- `H.walls.frontClassedShare`: 0 → 0.841 (≥0.9); residual defect remains.

### tests/golden/world/streets.test.ts

- `C.bridges.dippingDecks`: 4 → 3 (≤0); residual defect remains.
- `C.clearance.carriagewayEdges`: 384 → 0 (≤0); target met.
- `C.clearance.lombardEdges`: 2 → 0 (≤0); target met.
- `C.clearance.pedestrianEdges`: 62 → 0 (≤0); target met.
- `C.freeway.insideFootprintsM`: 435 → 113 (≤0); residual defect remains.
- `C.freeway.separatedCrossingsShare`: 0 → 0.423 (≥1); residual defect remains.
- `C.piers.buildingsOnWater`: 103 → 59 (≤0); residual defect remains.
- `C.piers.streetsAtSeaLevel`: 4 → 1 (≤0); residual defect remains.
- `C.stairs.carDrivable`: 4 → 1 (≤0); residual defect remains.
- `C.stairs.missing`: 2 → 1 (≤0); residual defect remains.
- `C.stairs.notMarkedStairs`: 4 → 1 (≤0); residual defect remains.
- `C.tunnels.broadwayAbovePortalLineM`: 49.68 → 8.16 (≤1); residual defect remains.
- `C.tunnels.insideFootprintsM`: 578 → 0 (≤0); target met.
- `C.tunnels.unflagged`: 7 → 2 (≤0); residual defect remains.

## Numeric regressions: all 21 failed metric assertions

All were already failing in the pre-dodge integration run `/tmp/fog-city-tests.log`. Every numeric value is identical to that run except accounting, whose corrected source-count metric changes 15,281 → 2,667. A “regression” here means against the 2026-10-21 baseline, not proof it was introduced by the current branch.

| Metric | Baseline → measured | Owner and next action |
|---|---|---|
| `A.accounting.keptMatchesRecords` | 0 → 2667 | **Pipeline + Harness:** 175,604 reported kept versus 172,937 unique source footprints. Trace later clearance, replacement and scenery removal in the report ledger. Measurement correction reduced the old erroneous 15,281-piece mismatch to 2,667; the zero target remains. |
| `A.ground.wallBottomAboveGround` | 2 → 123 | **Harness + Pipeline:** Likely span false positives: first cases are -b span pieces with deliberate underY. Gate compares every footY against terrain and has no underside exemption; verify spans before changing geometry. |
| `A.landmark.sutroAreaTallestM` | 13.64 → 13.68 | **Pipeline + Harness:** 13.68 m is safely below its fixed 20 m target but exceeds the old 13.64 numeric baseline by 4 cm. Strict ratchet delta, already present before regeneration; investigate precision/provenance, do not silently raise it. |
| `A.rings.duplicates` | 23 → 60 | **Harness + Pipeline:** First examples are terrace strips versus their own tower. Partner exclusion only follows direct tower/towerOf metadata, not source pieceOf. Canonicalize related pieces for legitimate exclusion, then audit remaining overlaps. |
| `D.shore.drawnGrassHa` | 31.07 → 67.86 | **Render-World + Pipeline:** 67.86 ha of near-shore green terrain versus 31.07. Check coverage mask/classification and legitimate coastal park land; validate ground-cover intent before treating every green sample as a defect. |
| `F.buried.walkerLowWallStops` | 29 → 30 | **Sim-World + Pipeline:** 30 blocked sites versus 29; still present before dodge. Inspect low terrace walls, collision bands and the site list in drive.specs.json. |
| `F.crossings.airborneRuns` | 66 → 70 | **Pipeline + Sim-World:** 70/297 crossing runs; worst 2.1 s airborne near 37.80902,-122.36624. Audit deck/ramp continuity. |
| `F.lake.mercedDrivenM` | 620 → 780 | **Sim-World + Pipeline:** Car crosses 780 m of South Lake Merced. Check water-edge collision/tow behavior and lake boundaries; source and runtime responsibilities overlap. |
| `F.placement.maxRiseM` | 0.34 → 1.69 | **Sim-World:** Worst placement c9329000:1 near 37.76223,-122.44639 rises 1.69 m (no jump). Audit respawn/clearance placement height. |
| `E.net.outlineCoverFails` | 0 → 969 | **Harness + Pipeline:** 969/7,100 rectangular tile-edge pieces fail. Gate assumes boundary follows entire rectangular built-tile outline, while current cut land/county boundaries may run inside a tile. Compare actual cut contour before claiming holes. |
| `N.far.outerLandUncovered` | 310 → 1835 | **Pipeline + Render-World:** 1,835 dry outer-edge samples lack far terrain. Verify actual cropped-land edges and far coverage; expansion of the measured edge population may contribute. |
| `N.far.tallHullsOff3m` | 44 → 110 | **Pipeline + Render-World:** 110 tall records mismatch far roofs; examples include tower/terrace source families. Check representation and cluster matching, then regenerate far hulls. |
| `N.glb.floatingWallBottoms` | 2 → 143 | **Harness + Pipeline:** First ten all span -b pieces (4.8-9.73 m intentional clearance). GLB gate excludes towers only, not undersides. Separate valid suspended spans from true floating walls. |
| `N.glb.roadSurfaceMaxM` | 3.84 → 179.5 | **Harness + Sim-World + Pipeline:** Worst c4079099 Clay St. The helper passes an optional/undefined feet hint to required-height surfaceHeight; stacked tunnel/deck selection can choose the wrong level. Reproduce with an explicit body/surface context before rebuilding roads. |
| `N.glb.roadSurfaceP99M` | 0.497 → 8.245 | **Harness + Sim-World + Pipeline:** Same surface-selection concern as max. 8.245 m over 2 m road samples is not evidence that every road is vertically wrong until height context is verified. |
| `F.routes.belowSurfaceM` | 0.173 → 0.404 | **Sim-World + Pipeline:** 0.404 m deepest below selected surface on closed loops. Inspect contact surface/body-height selection and the route samples. |
| `F.routes.maxJumpM` | 0.002 → 0.004 | **Sim-World + Harness:** 4 mm versus 2 mm baseline, within 0.5 m target. Strict numeric ratchet; preserve it pending deterministic/precision diagnosis. |
| `F.routes.seamStepM` | 0.003 → 0.004 | **Sim-World + Harness:** 4 mm versus 3 mm baseline, within 0.1 m target. Strict numeric ratchet; preserve it pending seam/precision diagnosis. |
| `F.routes.stopped` | 2 → 3 | **Pipeline + Sim-World:** 3 blocked loops: Lombard by 201006.0021655 at 37.80199,-122.41921; California by 201006.0058920 at 37.79146,-122.41083; Twin Peaks wall at 37.75756,-122.44789. |
| `C.freeway.maxGradePct` | 143.22 → 345.06 | **Pipeline:** 345.06% on c19205000 at 37.81123,-122.47750, far above 6% target. Check Golden Gate approach deck endpoints/terrain blending. |
| `B.grades.famousFails` | 0 → 1 | **Pipeline:** Fillmore, Broadway-Vallejo: 25.88% versus 24% ±1.5%. Other four famous-grade blocks pass. |

## Remaining six failed assertions

1. **Buildings definition mismatch (Harness; introduced by `88e2a20`).** The source metric description changed from `|report.json kept - footprint records in the colliders| (the report and the tiles agree)` to `|report.json kept - unique source footprints in the colliders| (the report and the tiles agree)`. The world-baseline adjustment synchronizes this one description in `tests/golden/world-qa-baseline.json`. Structural validation proves all other parsed fields, numeric baselines, targets, enforcement fields and defect statuses are identical to the pre-edit file; the description now exactly matches `buildings.specs.json`. `git diff --check` passed. This report records the full run before that metadata-only repair; no numeric baseline changed.
2. **Edge definition mismatch (Harness; pre-existing).** `E.walls.sampleEscapes.desc` embeds an observed sample count: baseline says 97 starts, current generation produces 92. Current escape value remains 0 against target 0. Do not just approve weaker coverage: reconcile why 5 starts disappeared, pin source sample identities/coverage or move variable population out of definition text and test it explicitly.
3. **`drive/sample` named-run regression (Pipeline + Sim-World; pre-existing).** `c11439101:+` / San Jose Ave previously reached its end; it now fails. Detailed failing set in `drive.json`; verify barrier/deck trajectory. Other nine sampled runs improved, which must not hide this one regression.
4. **`routes/hills` named-run regression (Pipeline + Sim-World; pre-existing).** `Market St, Castro, Twin Peaks summit` is newly failing relative to the golden, held by the wall at 37.75756,-122.44789. Do not add it to the golden failing list.
5. **Ballpark record presence (Pipeline + Content).** `201006.0000003` and its pieces are absent from current world output. `report.json.clearance.staleDropped` identifies deletion. The source preservation guard in `88e2a20` and its regressions pass; supported world regeneration is still pending.
6. **Ballpark storefront expectation (Pipeline + Content).** Expected retained landmark shops `{ferry-building, ballpark}`, observed `{ferry-building}`. Same absent-world-output cause; preserve the test and regenerate. Content ID-only derived-piece policy and the Saints Peter and Paul split-footprint check now pass.

## Attribution and existing QA documentation

- **No new gameplay regression is demonstrated from the dodge or multiplayer commits.** Pre-dodge and latest runs have exactly the same world file failure counts except buildings gaining the one accounting-description failure. All 21 numeric regression values match pre-dodge apart from the deliberately corrected accounting measurement. Both named-run regressions also existed then. This comparison is evidence from deterministic tests, not a browser/performance audit.
- The baseline is build `544f67c`, measured 2026-10-21. `docs/qa/world-qa-status.md` begins with older narrative evidence on `54ee728`; its generated gate section mirrors those older baseline values. It cannot be read as current success/failure status. `docs/qa/world-qa-report.md` remains useful for defect ownership and reproduction history.
- Keep `docs/qa/2026-10-23-integration-status.md` as the current integration context. Fixed metric subsets do not prove a whole W-id fixed when another test for that id still fails (e.g. zero buried roofs but 30 blocked walker sites for W-05).
- Priority: repair genuine source/behavior regressions and validate suspected measurement errors first; regenerate source-controlled outputs when raw data is available; then tighten valid improvements and refresh statuses under the existing gate rules. Do not raise old failing-list baselines or mark a whole defect fixed from one improved metric.

## Evidence pointers

- `/tmp/fog-city-final-tests.json`: exact test names, first assertion messages and all stacks.
- `test-results/world-gate/{suite}.json`: values, failed run IDs, sample counts, measured commit/time.
- `test-results/world-gate/{suite}.specs.json`: definitions and short worst-case/site lists; use `buildings`, `drive`, `edge`, `far`, `glb`, `routes`, `streets`, `terrain` for the actionable cases above.
- `/tmp/fog-city-tests.log`: pre-dodge failure/value comparison. `/tmp/fog-city-baseline-before-description.json`: exact pre-metadata-edit baseline used by the structural check.
- The world-baseline adjustment changes only the accounting-description metadata. No source behavior, geometry, threshold, golden run list or defect status was changed.

## Follow-up full Chromium run

On the same application code, the full Chromium suite completed in 14.0 minutes:
**35 passed, one failed, zero skipped**. The failure is the intentional stale-baseline
rule for `G.carPose.wheelGapM`: baseline 3.9 m, measured 0.37 m, target 0.1 m. This is a
large improvement with residual wheel placement error, not a completed W-09 fix.
Filbert wheel gaps are at most 0.01 m, Twin Peaks 0.27 m and Kearny 0.37 m. Car pitch
error is zero; the Twin Peaks far view draws 13 cells, with all 26 cells loaded.

All remaining Chromium checks pass: Node/browser replay agreement, render/simulation
independence, keyboard driving and wall collision, visible no-contact pedestrian dodge,
walking/re-entry and blocked exit, SF spawn/buildings, compressed tile decoding without
collider fallback, landmark placement, traffic models, collider-pack loading, far skyline,
driving, the southern city-edge view, packed sub-path boot and missing-pack failure.

Evidence is in `test-results/world-gate/car-pose.json`, `car-pose.specs.json` and the
retained Playwright trace. The software-renderer performance probe is informational;
it does not establish real-hardware frame rate. Firefox/WebKit separately passed all
eight pure-simulation checks. Their rendered multiplayer flows were not run.
