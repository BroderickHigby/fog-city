# World continuity gate

> **Evidence files.** The scripts, outputs and screenshots this document names (paths such as `critic/c2-drive-all.mjs`, `synth/h1-head-sim.mjs` or `houses/shots/h03-sunset-30th.png`) lived in the QA run's scratch space (`qa-world/`, outside the repository) and are not committed. The numbers quoted from them are the record; the gate (`world-continuity-gate.md`) re-measures them in the repository's own tests.

This is the standing QA gate for the world: buildings, terrain and hills, streets and structures, ground cover, the world edge, and play continuity, by car and on foot. It must pass before any territory step or wave merges. It is written for `docs/qa/`.

The gate turns the 52 defects of `world-qa-report.md` into automated tests, plus a fixed screenshot tour that a person reviews each wave. Every threshold below was measured on head 54ee728 (the "baseline" column) or comes from a defect's acceptance test (the "target").

## Rules

1. **No network.** Tests never hit the network.
   - They read the committed world: `public/tiles/sf/` (`world.colliders.bin`, `*.collider.json`, `*.glb`, `f*.glb`, `roads.json`, `boundary.json`, `districts.json`, `sidewalks.json`).
   - Anything else they need is a small derived fixture that the pipeline commits beside its tests, for example:
     - the 2025 roll's parcel points;
     - the Rec and Park polygons;
     - named lake outlines;
     - summit and grade reference values;
     - published heights.
2. **One world loader.**
   - `tests/helpers/world.ts` (Harness) loads the world as the game boots it: collider pack, `roads.json` and `boundary.json`, through `assembleWorldFiles` and then `buildWorld`. It is loaded once per worker.
   - The same file provides a road follower (the Stanley controller of `qa-world/critic/lib.mjs` `drivePath`), a walker follower, and a meshopt GLB decoder for Node.
3. **Ratchet.**
   - `tests/golden/world-qa-baseline.json` (Harness) holds each metric's current value, its target, and the defect it tracks.
   - Per PR, no metric may be worse than its baseline.
   - A PR that improves a metric lowers its baseline in the same PR. The test prints a reminder when a metric beats its baseline, and fails when it beats it by more than 10% while the baseline is stale.
   - Format: `{ "build": "54ee728", "metrics": { "<id>": { "baseline": n, "target": n, "unit": "...", "defects": ["W-01"], "targetWave": n|null } } }`.
4. **Blocker metrics** have target 0. They must be at target before the wave that schedules their fix closes.
   - W-06 and W-07 are regressions introduced at head. Their targets apply to the next merge into integrate/wave1.
5. **Cadence and memory.** The machine has 16 GB and no swap; the per-PR world tests must stay under 2 GB peak.
   - **Per PR:** `world-pr`, a Vitest project. It loads the pack only (12.7 MB; the world builds in about 2 s, about 0.7 GB), with `--maxWorkers=2`, in under 5 minutes.
   - **Nightly:** `world-nightly` with `--maxWorkers=1`, plus `playwright test world-tour --workers=1`, under 40 minutes.
   - Locally, both run under the machine-wide heavy lock.
   - When a PR changes a subset of tiles, the GLB-decoding checks run per PR on the changed tiles only, and nightly on all 583.
6. **Ownership.** Each test lives in its owner track's directory (`CLAUDE.md`):
   - `tests/pipeline/`: Pipeline.
   - `tests/sim/world/` and the files directly in `tests/sim/`: Sim-World.
   - `tests/render/`: Render-World.
   - `tests/e2e/`, `tests/helpers/`, `tests/golden/`: Harness.
   - `tests/assets/`: Assets.
   - `tests/content/`: Content.

## Merge rule

A territory step or wave merges only when all of these hold:

- **(a)** Every `world-pr` test passes, and no metric is worse than its baseline.
- **(b)** The latest nightly on the merge candidate passed, with no new failure.
- **(c)** Every blocker metric scheduled for this wave is at its target.
- **(d)** The screenshot tour below was shot on the candidate and reviewed, with the contact sheet compared side by side against the previous wave's, and the reviewer has signed the wave's QA note.
- **(e)** `world-qa-status.md` is updated: each defect fixed, partly fixed or open, with the metric that proves it.

## A. Buildings

| Test file | Cadence | Asserts | Baseline (head) | Target | Defects |
|---|---|---|---|---|---|
| `tests/pipeline/completeness.test.ts` | PR | Every source footprint is accounted for: present, or dropped with a counted reason (low LiDAR, under 4 m², invalid); 0 "other" | 175,595 present; 774 / 768 / 3 / 0 other | unchanged accounting, 0 other | - |
| same | PR | Post-2015 parcel points with storeys and no record within 25 m | 122 | ≤ 10, and no 100 m cell with 3 or more | W-04 |
| same | PR | Mission Rock box (37.7740-37.7765, -122.3905..-122.3875): records 40 m or taller | 0 | ≥ 4 | W-04 |
| same | PR | Published heights within ±10%: Salesforce 326, Transamerica 260, 555 California 237, One Rincon Hill 188, 250 Howard 167.6 (roof), The Avery 188, 706 Mission 146, Fifteen Fifty 116 | 3 failures (Avery, 706 Mission, Fifteen Fifty) | 0 failures | W-04 |
| `tests/pipeline/grounding.test.ts` | PR | Wall bottom (footY) ≤ min ground + 0.3 m, sampled densely along the walls | 2 (south edge) | 0 | L-03 |
| same | PR | Records with the ground above the roof anywhere inside the footprint (1 m raster) | 18 | 0 | W-05 |
| same | PR | Records 4 m or taller with topY - max ground < 2 m | 79 | 0 | W-05 |
| same | PR | Drawn parts with more than 10 m of relief under one roof | 479 | 0 | W-28 |
| same | nightly (GLB) | Wall bottoms more than 0.05 m above the drawn ground | 38 | 0 | L-02 |
| `tests/pipeline/parity.test.ts` | nightly (all GLBs), PR (changed tiles) | Every collider record has a non-empty GLB index range and every range has a record; y and xz extents match | 0 mismatches (pass) | 0 | - |
| `tests/pipeline/rings.test.ts` | PR | Non-simple footprint or tower rings; duplicate footprints; coplanar roof pairs | 192 / 23 / 24 | 0 / 0 / 0 | W-30, L-01 |
| `tests/pipeline/facade-storeys.test.ts` | PR | Residential records drawn with storeys of 5 m or more | 61% | < 2% | W-15 |
| same | PR | Street-facing buildings whose first-storey line is more than 1.5 m off the sidewalk | 11.1% | ≤ 1% | W-29 |
| `tests/pipeline/landmark-records.test.ts` | PR | No record over 30 m stands on a drivable centreline; Fort Point 201006.0000856 topY - ground ≤ 25 m | 2 (1st St tower, Fort Point) | 0 | W-16 |
| `tests/assets/landmarks.test.ts` | PR | Entries exist for sutro-tower (top ≥ 290 m above its ground), golden-gate-bridge and bay-bridge-west; Coit within 5% of 64 m; every places-table landmark has a model or a documented interim shape with no office window grid | Sutro, both bridges and Coit fail | all pass | W-24, W-25, W-27 |

## B. Terrain and hills

| Test file | Cadence | Asserts | Baseline (head) | Target | Defects |
|---|---|---|---|---|---|
| `tests/pipeline/terrain-coverage.test.ts` | PR | Every built tile has a finite 51x51 heightfield and a water mask; the pack equals the JSON value for value (heights, water, ids, baseY, topY, vertices) | pass (583 tiles, 0 mismatches) | pass | - |
| `tests/sim/world/seams.test.ts` | PR | `groundHeight` on every tile border every 2.5 m gives the same value from both neighbours' lattices | pass (219,693 samples, max 0) | 0 | - |
| same | nightly | GLB ground border vertices are identical across neighbours, and no T-junction opens a crack | pass | 0 | - |
| `tests/sim/world/ground-parity.test.ts` | PR | At 10,000 seeded land points, \|sim ground - mesh ground\| ≤ 0.02 m (mesh height computed from the lattice with the mesh's triangle split, so no GLB decode) | p99 0.283 m, max 0.98 m (per-cell max 4.37 m) | ≤ 0.02 m | W-22 |
| `tests/pipeline/summits.test.ts` | PR | 25 named summits: the lattice maximum within 150 m is within 1 m of the committed DEM reference, and within 5 m of the published value or of a listed source difference (Bernal +9.9, Potrero +7.6, Russian Hill +9.6, Lone Mountain -10.1, Bayview Hill -10.2, Fort Funston +9.2) | pass | pass | - |
| `tests/pipeline/grades.test.ts` | PR | Steepest 10 m along the drivable surface: Filbert (Leavenworth-Hyde) 31.5 ± 1.0%, 22nd (Church-Vicksburg) 31.5 ± 1.0%, Jones (Union-Filbert) 29 ± 1.0%, Duboce (Alpine-Divisadero) 27.9 ± 2.0%, Fillmore (Broadway-Vallejo) 24 ± 1.5% | pass | pass | - |
| same | PR | Hillside-crossing roads (Twin Peaks Blvd c12770000, Vermont c13216002, Vasquez c13186101, Kensington c7806001, Filbert c5491000, Burritt c3403000): grade break at most the 1 m DEM's + 10 points, and steepest 10 m at most the DEM's + 5 points | 6 fail | 0 | W-31 |
| `tests/pipeline/inland-water.test.ts` | PR | Lake Merced, Stow, Spreckels, Elk Glen, Lloyd, Pine, Mountain Lake, the Palace of Fine Arts lagoon, the Crissy marsh, Laguna Honda, the Chain of Lakes: at least 90% of lattice samples in the outline are water at the lake's level; hydro-flattened regions of 0.5 ha or more that are not water | 0% / 14 regions, 109.9 ha | ≥ 90% / 0 | W-11 |
| `tests/pipeline/far-ring.test.ts` | nightly | Near lattice against far terrain at every tile border every 5 m | p99 7.43 m, max 21.45 m; far above near by more than 1 m along 82.7 km | p99 ≤ 1 m, max ≤ 2 m, far never above near by more than 0.5 m without a skirt | W-17 |
| `tests/pipeline/far-coverage.test.ts` | nightly | Every land border sample has far terrain within 1 m across it; t-16_21, t-4_21, t-3_21 and t7_-5 have at least 95% far coverage; `manifest.outside` contains every land tile 4-adjacent to a built tile; San Bruno Mountain's summit is within 10 m of 402 m | 340 samples uncovered; 0% in the 4 tiles; summit absent | 0; ≥ 95%; present | W-40 |
| `tests/pipeline/far-hulls.test.ts` | nightly | Records 30 m or taller: \|far roof - topY\| at the centroid; every record under a hull or cluster; records under 30 m at p99 | 41 over 10 m (max +122.4); 690 without a hull; p99 8.3 m | all ≤ 3 m; 0; ≤ 5 m | W-41 |

## C. Streets and structures

| Test file | Cadence | Asserts | Baseline (head) | Target | Defects |
|---|---|---|---|---|---|
| `tests/pipeline/carriageway-clearance.test.ts` | PR | Drivable edges with a centreline sample within 0.95 m of a footprint whose roof is more than 0.5 m above the ground and whose underside is below road + 4.5 m. An allow-list holds the tunnels and decks, each with its reason | 384 edges (287 confirmed blocked in drives) | 0 | W-01, W-43 |
| same | PR | Pedestrian edges with a centreline sample within 0.75 m of such a footprint | 33 edges blocked both ways | 0 | W-39 |
| `tests/pipeline/tunnels.test.ts` | PR | Broadway (2 edges), Stockton, Toll Plaza, MacArthur, the Presidio Parkway and YBI are flagged tunnels; the ribbon is within 1 m of the straight portal profile; tunnel centreline inside footprints below the ceiling | none flagged; Broadway 49.45 m above the portal line; 417 + 145 m inside | all flagged; ≤ 1 m; 0 m | W-02 |
| `tests/pipeline/freeway-decks.test.ts` | PR | Freeway and ramp centreline inside footprints (allow-list); freeway ribbon area under the ground; the deck at least 5 m above each of the 154 street-crossing places; maximum grade outside ramps | 435 m; 10.0%; 0 decks; 141% | 0 m; 0%; all ≥ 5 m; ≤ 6% | W-03 |
| `tests/pipeline/bridges-piers.test.ts` | PR | Surface `bridge` edges with a deck between the abutments; buildings at least 50% on water without a deck; pier streets with samples at y = 0 (Al Scoma, Pier 45 Vly, Pier 50 Vly, Unnamed 42) | 0 of 4 creek bridges; 95; 4 | 4 of 4; 0; 0 | W-12, W-13 |
| `tests/pipeline/road-surface.test.ts` | nightly (GLB), PR (changed tiles) | \|drawn road top - sim surface\| at every centreline and kerb-inset sample (2 m along) | 2.47% of samples more than 0.3 m under the road; max 3.98 m | ≤ 0.05 m everywhere | W-09 |
| same | same | On a 0.5 m grid over every ribbon: ground mesh above the ribbon top by more than 0.02 m | 2.31% of roads, 11.5% of freeways | 0 | W-10 |
| same | same | Road area covered by two ribbons; ribbon seam gaps over 2 cm | 1.19-1.35 km²; 9 | < 0.5%; 0 | W-32, L-11 |
| `tests/pipeline/road-profile.test.ts` | PR | Every drivable edge has a 2 m profile that keeps intersection plateaus and agrees with the DEM within 0.5 m away from structures | no profiles | all edges | W-09, W-31 |
| `tests/pipeline/stairs.test.ts` | PR | Filbert, Greenwich, Lyon, the 16th Ave tiled steps (Moraga), Vulcan and Harry are pedestrian `stairs` edges joined to the walk graph; drivable stair edges | 3 missing; stairs drivable | all present; 0 | W-33 |
| `tests/render/props-placement.test.ts` | PR | Street trees and lamps on a road ribbon (+0.5 m) or inside a footprint, for every sf tile's spot lists (pure geometry, no browser) | trees 4.1% on roads, 5.8% in buildings; lamps 8.3% on roads | 0 / 0 / 0 | W-44 |
| `tests/render/sidewalks.test.ts` | PR | Every side that has a sidewalk in `sidewalks.json` has drawn sidewalk geometry in its sf tile | none drawn | all | W-45 |

## D. Ground cover

| Test file | Cadence | Asserts | Baseline (head) | Target | Defects |
|---|---|---|---|---|---|
| `tests/pipeline/ground-cover.test.ts` | PR | Ground class per lattice vertex: share of Rec and Park land vertices that are grass or forest; properties under 10% green | 43.7% (as tinted); 240 of 253 | ≥ 90%; 0 | W-18 |
| same | PR | Lake-surface vertices classed or tinted grass | 5.0 ha | 0 | W-11 |
| same | PR | Vertices on Ocean, Baker, China and Crissy beaches that are sand; shore land at 1.5-8 m within 80 m of the sea tinted grass | 0%; 32.6 ha | ≥ 90%; 0 | W-34, W-18 |
| same | PR | Tiles over Golden Gate Park, the Presidio, McLaren, Lincoln Park, Buena Vista, Glen Canyon, Sutro Forest and Mt Davidson have a non-empty foliage node; in each listed park, the share of canopy-mapped land more than 30 m from a drawn tree | 0 of 583 tiles with foliage | all listed tiles; < 15% | W-18 |
| `tests/render/parks.test.ts` (extend) | PR | No water-class or lake vertex is ever tinted grass; once ground classes land, the district tint is gone | tint by district | by class | W-11, W-18 |

## E. World edge and network

| Test file | Cadence | Asserts | Baseline (head) | Target | Defects |
|---|---|---|---|---|---|
| `tests/sim/world/world-edge.test.ts` | nightly (all walls); PR (a fixed 100-point sample) | Ram every wall every 100 m from a dry start 12 m inside: a car at 30 m/s at 0/±30/±60°, and a sprinting walker at 0/±45°. Crossings of a real wall segment; bodies ending outside the built tiles | 0 / 0 (pass, 6,064 tests) | 0 / 0 | W-08 |
| `tests/sim/world/shore-gaps.test.ts` | PR | At each of the 22 gaps: a car turning 30/60/90° either way at 10 and 25 m/s, and a sprinting walker, stay within 1 m of the road corridor; no body ends more than 3 m on the water side of any uncut shore line | 26 of 36 turn runs out (max 205 m; 1,213 m via Pier 45 Vly) | 0 | W-21 |
| `tests/sim/world/wall-launch.test.ts` | nightly (every 50 m of shore); PR (a fixed 200-point sample) | Start 2.5 m and 6 m on the water side, drive at the wall at 5/15/30 m/s: peak height above the ground, and the largest per-tick move | 8,137 of 8,958 launch; max 1,612 m; one-tick moves of 8 m | ≤ 1 m; ≤ speed·DT + 0.5 m | W-06 |
| `tests/sim/car-push.test.ts` | PR | Unit: a car box pushed sideways onto a 3 m bank, or out of a footprint, gains no upward vy beyond \|v\|·slope + 1 m/s | fails (vy 52-102 m/s) | pass | W-06, W-23, W-51 |
| `tests/sim/world/freeway-continuity.test.ts` | PR | gradeSeparated edges with both endpoints on land that cross a wall; I-280 NB from Alemany to King St and SB back at 25 m/s | 3 edges; both stop at walls | 0; both reach the end with 0 wall contacts | W-07 |
| `tests/pipeline/network.test.ts` | PR | Mainland largest drivable component (freeways and pedestrian edges excluded); every mainland district reaches its nodes from the spawn; dead ends at tile seams; `boundary.json` covers the built outline exactly once; every built tile with buildings has a drivable edge or is listed as scenery-only | 97.1%; ≥ 95.3%; 0; pass; Daly City strip unlisted | ≥ 97%; ≥ 95%; 0; pass; 0 unlisted | W-42 |

## F. Play continuity: closed-loop drives over the hills, and on foot

All F tests use the real `stepCar`, `stepFoot` or `step()` on the world as the game boots it, walls on.

| Test file | Cadence | Asserts | Baseline (head) | Target | Defects |
|---|---|---|---|---|---|
| `tests/sim/world/drive-every-street.test.ts` | nightly (about 9 min, 0.7 GB) | Every non-pedestrian, non-freeway edge in each allowed direction, at min(posted, 20) m/s with the road follower. Stuck = throttle held at < 0.5 m/s for 2 s | 434 stuck runs (238 edges blocked every way, 200 on the mainland); 58 start-blocked; 84 runs airborne ≥ 0.5 s | mainland: 0 stuck, 0 start-blocked; airborne ≥ 0.5 s only on a listed set of real crests; every district ≥ 99.5% of runs reach the end | W-01, W-14 |
| `tests/sim/world/drive-named-streets.test.ts` | PR (about 1 min) | A committed list with the expected outcome per edge and direction: 1st St, Howard, Kearny (c7752000, c7759000, c7751000), Upper Market (both), Battery, Elk (both), Houston, Crescent (c4495000/6), Mason (both), Winston (both), Walnut, Broadway Tunnel (both), Stockton, Toll Plaza, Lombard c8448000/c8449000, 3rd/4th/Illinois bridges, Richland, Twin Peaks Blvd, Filbert, 22nd St, Vermont, plus the critic's seeded 300-edge sample. No edge may regress from reached to stopped; fixed edges stay fixed | per baseline file | all reach | W-01, W-02, W-43, W-12, W-14 |
| `tests/sim/world/hill-routes.test.ts` | PR (about 2 min) | Closed-loop routes with the full `step()` and traffic: Ferry Building → Filbert up → Lombard down; California over Nob Hill; Market → Castro → Twin Peaks summit; 22nd St up from Church; Fillmore down to the Marina; Potrero Hill via Vermont; Great Hwy; 19th Ave; JFK Dr through Golden Gate Park; 3rd St to Dogpatch; one diagonal across 40 or more seams | Lombard, 1st St, Howard, Broadway and Houston stop (7dbb362 routes) | every route reaches the end; 0 stuck; seam y step ≤ 0.1 m; car y ≥ ground - 0.1 m; no tick moves the car more than speed·DT + 0.5 m; airborne only at listed real crests (Filbert ≤ 0.8 s at 25 m/s); hashState equal on a re-run | W-01, W-14, W-22 |
| `tests/sim/world/drive-freeways.test.ts` | nightly | Every freeway and ramp edge at 25 m/s | 62 of 220 airborne ≥ 0.5 s, 35 hard landings, 11 stuck | 0 airborne > 0.3 s, 0 landings > 3 m/s, 0 stuck | W-03, W-07 |
| `tests/sim/world/tunnels.test.ts` | PR | Both Broadway bores, Stockton and Toll Plaza at 25 m/s | Broadway stops both ways; Stockton airborne 0.85-0.98 s | 0 hits, y within 1 m of the portal line, 0 airborne ticks | W-02 |
| `tests/sim/world/bridges.test.ts` | PR | 3rd St, 4th St, Illinois St and 3rd St (Islais) at 15 and 25 m/s | dip to y = 0 | y ≥ lower abutment - 0.2 m; 0 airborne; no wheel over water | W-12 |
| `tests/sim/world/grade-separations.test.ts` | PR | The 291 street-over-freeway crossings at 15 m/s; Richland Ave at 16 and 20 m/s | 38 airborne ≥ 0.5 s; Richland 1.65 s, 17.8 m | 0 trenches or humps over 1 m; no airborne > 0.2 s | W-14 |
| `tests/sim/world/ram-launch.test.ts` | PR | 360 seeded rams at 25 m/s into buildings on ground of 15% or more (Russian Hill, west of Twin Peaks, Bernal) | 176 launch; max 27.1 m | 0 airborne > 0.3 s or > 0.5 m up | W-23 |
| `tests/sim/world/placement.test.ts` | PR | A car placed at each of the 58 start-blocked street starts, and at the multiplayer spawn slots: rise; largest per-tick move | 178 m (Congdon), 144 m (Market at Octavia) | rise < 0.5 m; move ≤ speed·DT + 0.5 m; respawn picks a clear spot | W-51 |
| `tests/sim/world/buried-buildings.test.ts` | PR | A car and a walker driven at each of the 30 buried-roof sites | 23.49 m one-tick teleport; walker held at an underground wall | no tick moves a body more than speed·DT + 0.5 m; a walker crosses or stops at a wall at least 2.5 m tall | W-05 |
| `tests/sim/world/walk-every-path.test.ts` | nightly | All 170 pedestrian edges walked both ways with `stepFoot` | 264 of 340 reach | 340 of 340 | W-39 |
| `tests/sim/world/walk-routes.test.ts` | PR | Filbert up (average ≥ 1.0 m/s), the Lyon St steps, 22nd St, the Filbert Steps, a seam on a slope (y step ≤ 0.01 m), Pemberton Pl, Cottage Row | Filbert, Lyon and the seam pass; Pemberton and Cottage Row blocked | all pass | W-39 |
| `tests/sim/world/walker-falls.test.ts` | PR | Walking off a 3 m drop; climbing a slope over 100% taller than 1 m | 1-tick drop; any cliff climbable | ≥ 0.7 s to land; not climbable | W-52 |
| `tests/sim/world/determinism.test.ts` | PR | 60 s of `step()` with traffic, twice from the pack and once from the JSON colliders: hashState at every 600 ticks | identical (pass) | identical | - |
| `tests/e2e/determinism.spec.ts` (extend) | nightly | The browser `stepN` replays of the 4th St gap, I-280 wall and Pier 45 runs match Node | dxz 0.000 (pass) | dxz ≤ 0.001 m | - |

## G. Render in the browser (SwiftShader; assertions through `window.__fogcity`, never frame rate)

| Test file | Cadence | Asserts | Baseline (head) | Target | Defects |
|---|---|---|---|---|---|
| `tests/e2e/car-pose.spec.ts` | PR | On Filbert at 37.80027,-122.41817: the model's pitch is within 1° of the sim's; every wheel's bottom is within 0.1 m of the drawn road (also on Twin Peaks Blvd at 37.75495,-122.44774 and on Kearny at 37.80469,-122.40622) | pitch passes; wheels 0.29-0.32 m under (Filbert), 1.25-1.70 m (Twin Peaks Blvd) | pass | W-19, W-09 |
| `tests/e2e/far-ring.spec.ts` | nightly | At radius 60, beside the borders t-16_-1/t-15_-1, t-20_17/t-20_18 and t-9_13/t-8_13: no ray straight down or 20° down from 30 m above the near ground passes both layers and hits the sea plane | sea visible at 2 of 3 | 0 | W-17 |
| `tests/e2e/world-tour.spec.ts` | nightly, and on every wave candidate | Runs the screenshot tour below. Each view: `tilesSettled`, `tilesFailed` 0, far cells loaded > 0, 0 console errors. Raycasts: a lake view hits water material; the beach views hit sand; the park views hit grass and foliage; the Sutro, bridge and Coit views hit landmark models | far cells pass; lakes, beaches, parks and landmarks fail | all pass | W-11, W-18, W-24, W-25, W-27, W-34 |

## Screenshot tour (reviewed by a person each wave)

`tests/e2e/world-tour.spec.ts` shoots a fixed list of views with `window.__fogcity.flyTo(x, y, z, yaw, pitch)` and `tilesSettled()`.
- Street views use an eye at 1.7 m, looking along the street, uphill and downhill where it applies.
- Aerial views are taken from 120 m at -35°.
- Views marked "night" also run with `setNight(true)`.
- The positions are committed in `tests/e2e/world-tour.views.json` as lat/lon, converted with `src/geo/project.ts`.

The tour writes a contact sheet and puts it beside the previous wave's. The reviewer checks each view against the listed points, records pass or fail per view in the wave's QA note, and opens a defect with the view id for every fail.

| # | View | Mode | What to look for |
|---|---|---|---|
| 1 | Filbert St at Hyde, looking down to the Bay (37.80027,-122.41817) | street, both ways | the grade reads as 31.5%; the car's wheels sit on the road; no ground through the road |
| 2 | Lombard crooked block from the top at Hyde | street + aerial | switchbacks and hedges; the car follows the drawn line without hitting a house (W-43) |
| 3 | 22nd St between Church and Vicksburg | street up + aerial, night | steep block; houses step down the hill; lit windows |
| 4 | Vermont St crooked block (Potrero Hill) | street + aerial | no lattice bumps (W-31) |
| 5 | Twin Peaks summit looking northeast | street, day + night | skyline continuous to downtown; no ring seam; Sutro Tower behind (W-17, W-25) |
| 6 | Twin Peaks Blvd at 37.75495,-122.44774 | chase | the car is not under the road (W-09) |
| 7 | Bernal Hill summit | street | far terrain to the south; no sea through the ground (W-40) |
| 8 | Telegraph Hill and Coit Tower | street + aerial, night | Coit is a fluted column, not an apartment block (W-27) |
| 9 | California St over Nob Hill | street up | Grace Cathedral; no buried roofs (W-05) |
| 10 | Russian Hill 201006.0000980 uphill side | street | no hill showing through the roof; no invisible wall (W-05) |
| 11 | Castro hill site 201006.0010129 | street | as above |
| 12 | Mission, Liberty St row (37.75733,-122.42275) | street | bay windows, stoops, no cracks between houses, colour variety (W-36, W-37, W-49, W-50) |
| 13 | Painted Ladies, 710-720 Steiner | street | the hand palette; bays; gables (W-37, W-38) |
| 14 | Sunset, 30th Ave between Kirkham and Lawton | street + aerial | garage storey with 2 floors above; garage doors; no 3 m windows (W-15, W-48) |
| 15 | Marina, Avila St | street | stucco palette; storey heights (W-15) |
| 16 | Pacific Heights, Fillmore drop to the Marina | street down | storey lines start at the sidewalk (W-29); no blank plinths (W-50) |
| 17 | Mission St, 16th to 24th | street | storefronts on every anchor (W-47) |
| 18 | Glen Park, Elk St | street | the street is open, not walled by houses (W-01) |
| 19 | Upper Market at 37.75660,-122.44156 | street | the carriageway is open (W-01) |
| 20 | 1st St at the Transit Center | street | the street passes under the deck; no tower on the street (W-01, W-16) |
| 21 | Howard St at Moscone | street | the bridge has an underside over the road (W-01) |
| 22 | Broadway Tunnel west portal | street | portal; no road over the hill (W-02) |
| 23 | Central Freeway at Mission and 13th | street + aerial | the freeway overhead on a deck; no trees or lamps in the road (W-03, W-44) |
| 24 | I-280 in Dogpatch | aerial | the viaduct is above the buildings (W-03) |
| 25 | I-80 at Rincon Hill, and the Bay Bridge from Rincon Park | street + aerial | the Bay Bridge silhouette; I-80 on a deck (W-03, W-24) |
| 26 | Richland Ave over I-280 | street | the street crosses on a deck, no trench (W-14) |
| 27 | 3rd St (Lefty O'Doul) bridge and 4th St bridge | street + aerial | the deck at bank height, not at the water (W-12) |
| 28 | Pier 1 and Pier 39 aprons | aerial | decks under the sheds; no sheds standing in the water (W-13) |
| 29 | Embarcadero at Pier 14 | street | a seawall face, not a ramp into the Bay (W-35) |
| 30 | Golden Gate Park aerial; Stow Lake; Spreckels Lake | aerial | forest and lawn; lakes are water (W-18, W-11) |
| 31 | Lake Merced | aerial + street | open water at about 5 m (W-11) |
| 32 | Dolores Park, Buena Vista, Glen Canyon, Mt Davidson | aerial | grass and trees, not grey (W-18) |
| 33 | Ocean Beach and the Great Highway; Baker Beach | aerial | sand, not grey and not lawn (W-34) |
| 34 | Presidio forest, Crissy Field to the Golden Gate | street + aerial | forest; the Golden Gate Bridge silhouette (W-18, W-24) |
| 35 | Lands End, looking north to Marin | street | far terrain of the Marin headlands; no cut ridge (W-17) |
| 36 | Fort Point | street | the fort, no 65 m block (W-16) |
| 37 | Sutro Tower from Cole Valley | street | the lattice tower (W-25) |
| 38 | South edge from the Excelsior, looking south | aerial | San Mateo terrain beyond, no city edge floating over the sea (W-40, W-42) |
| 39 | The three worst ring borders at radius 60 (Presidio, Lakeshore bluffs, west of Twin Peaks) | street + aerial | no sea through the ground; no ledge (W-17) |
| 40 | Bayview / Hunters Point Shipyard hill; Mission Rock | aerial | post-2010 blocks present (W-04) |
| 41 | Glen Park, Outer Mission, Portola, McLaren Park, Seacliff, Japantown, Lone Mountain, West of Twin Peaks (one each) | street | districts never toured in the first audit: houses grounded, streets open |
| 42 | A 30 s full-speed drive across 3 tiles | chase, 1 frame every 3 s | no pop-in hole; far skyline does not pop (W-41) |

## Maintenance

- **New defects.** When a new defect is found, add its metric to the baseline file with its current value, and add a view to the tour if a person can see it.
- **Fixes.** When a fix lands, lower the baseline in the same PR and update `world-qa-status.md`.
- **New territory and waves.** A new territory step adds its districts to the drive-every-street, walk-every-path and ring tests automatically, because they iterate the manifest. It also adds 2 to 4 tour views.
- **Owner.** The gate's owner is Harness. Each test's owner is the track that owns its directory.

## Implementation (landed on qa/gate, baselined at 544f67c)

The gate above is implemented as follows. Where the implementation differs from the plan, the
difference is listed with its reason.

### Files and commands

| What | Where |
|---|---|
| The world as the game boots it, the road and walker followers, the meshopt GLB decoder | `tests/helpers/world.ts` |
| The ratchet's rules, the measurement record, the Vitest wrapper | `tests/helpers/world-gate/ratchet.ts`, `measured.ts`, `suite.ts` |
| Each suite's metric definitions and measurements | `tests/helpers/world-gate/{buildings,terrain,streets,cover,houses,edge,play,nightly,glb,far}.ts` |
| Reference fixtures (parcel points, Rec and Park outlines, lakes, 1 m DEM profiles, QA sites) | `tests/helpers/world-gate/fixtures/` (README; made by `scripts/golden/world-fixtures.ts`) |
| Per-PR suites (Vitest project `world-pr`, inside `pnpm test`) | `tests/golden/world/*.test.ts` |
| Nightly suites (project `world-nightly`, `FOG_WORLD_NIGHTLY=1`) | `tests/golden/world/*.nightly.ts` |
| Browser checks | `tests/e2e/car-pose.spec.ts` (per PR), `far-ring.spec.ts` and `world-tour.spec.ts` (nightly, `tests/e2e/nightly.config.ts`), probes in `tests/e2e/world-probe.ts` |
| The tour's views | `tests/e2e/world-tour.views.json` |
| The ratchet | `tests/golden/world-qa-baseline.json` (defects and metrics), `tests/golden/world-qa-runs.json` (runs that failed at the baseline) |
| Rewriting the ratchet | `scripts/golden/world-baseline.ts` (`pnpm world:baseline`) |
| The ratchet's own tests | `tests/golden/world-baseline.test.ts` |
| Nightly on GitHub | `.github/workflows/world-nightly.yml` |

- `pnpm test` / `pnpm verify`: the per-PR world suites run with the unit tests; `car-pose.spec.ts` runs in `pnpm e2e`.
- `pnpm world:pr`: the per-PR world suites alone.
- `pnpm world:nightly`: the nightly sweeps (one worker), then the ring and the tour.
- `pnpm tour`: the screenshot tour alone, to `test-results/tour/` (no assertions).
- `pnpm world:baseline [--check] [--accept-worse <id>,...] [--prune]`: lower the ratchet from the last measurement.

### How a lane uses the gate

1. Fix the defect. Run the suite that measures it (`pnpm world:pr`, or the nightly or e2e spec).
2. The suite fails with "beat its baseline by N%: the baseline is stale" when the fix moved a
   metric by more than 10%. Run `pnpm world:baseline`: it lowers the baselines (and shrinks the
   failing-run lists) from what the suites recorded in `test-results/world-gate/`, and refuses
   any metric that got worse unless it is named with `--accept-worse`.
3. When every metric of the defect is at its target, flip the defect's `status` to `fixed` in
   `tests/golden/world-qa-baseline.json` (by hand, in the same PR) and update
   `docs/qa/world-qa-status.md`. From then on the defect's targets are hard assertions.
4. A metric tracking several defects is enforced once all of them are fixed.

### Differences from the plan, and why

- **Where the tests live.** Rule 6 put each test in its owner's directory. The gate's
  measurements are Harness-owned and live in `tests/golden/world/` and `tests/helpers/world-gate/`,
  so one ratchet judges every metric the same way and no lane edits another's directory to land
  the gate. A lane that fixes a defect may add its own focused test in its own directory; the
  gate's metric remains the acceptance check.
- **Baseline build.** Measured at 544f67c (integrate/wave1 after the wall, sim and far-seam
  commits), not 54ee728.
- **Status changes found at 544f67c.** The kerbed corridors of de02d2f close every road gap
  (W-21: 0 of 156 turn runs and 0 walkers leave a corridor): W-21 is marked `fixed`. The
  two-sided walls cut the shore launch from 1,612 m to under 9 m (W-06: 98 of 1,182 sampled
  approaches still rise more than 1 m), and a placed car no longer launches (rise 0.34 m) but
  is still pushed out of a footprint by up to 23 m in one tick (W-51): both `partly`.
- **Hill routes without ambient traffic.** The routes run the full `step()` with the road graph
  withheld (no agents): the gate's follower deadlocks against robotaxis waiting at junctions on
  every route with traffic on. Traffic is exercised by the determinism suite (60 s of `step()`
  with agents, from the pack and from the JSON colliders). A traffic-aware driver belongs in
  `tests/helpers/drivers/` (the roadmap's closed-loop drivers).
- **Summits.** The check is the sim's maximum within 150 m against the 3DEP DEM (within 1 m); the
  published heights differ from the DEM by up to 47 m for several summits in the fixture, so they
  are listed in the details, not asserted.
- **Thresholds where the measure differs from the QA's.** Ram launches count airborne over 0.3 s
  or lifts over 0.5 m (the target), so 211 of 360 at 544f67c against the QA's 176 at 0.5 s or
  1 m. Grade-separation launches count airborne over 0.2 s. Pedestrian clearance counts edges
  with any sample within 0.75 m (62), not edges blocked both ways (33). The houses' blank band is
  the drawn first-storey line more than 2.5 m above the street at the front. Freeway runs count
  airborne over 0.3 s and landings over 3 m/s (the targets): 96 and 76 of 220 at 544f67c against
  the QA's 62 and 35 at 0.5 s. Street runs count the mainland only: 385 stopped at 544f67c (the
  QA counted 434 citywide at 54ee728).
- **House kit encodings the gate reads** (from `docs/qa/house-kit-spec.md`): per-wall classes in
  `_FACADE.w` (0 rear, 85 party, 170 front, 255 roof); anchor lists as GLB node extras named
  `bays`, `stoops`, `garages`, `storefronts`; a foliage node named `foliage`, `trees` or
  `canopy`; tunnels and stairs flagged on `roads.json` edges (`tunnel: true` or `kind: "tunnel"`,
  `stairs: true` or `kind: "stairs"`); road profiles as an edge `profile`; a street level as
  `meta.streetY`; a road underside as a collider `underY`; decks and tunnels through a sim
  `surfaceHeight(world, x, z, yHint)` when it exists (the gate falls back to `groundHeight`).
  A lane that chooses another encoding updates the gate's reader in the same PR.
- **Browser probes** read the scene through `?debug=1` (`window.__fogcityView`), in plain
  JavaScript, and never pixels. They see what the renderer draws: a far cell is no hit inside a
  tile that is in the scene (its shader discards it there), a single-sided face is hit only from
  its front, and the tour flies 80 m over each probe's point first so that point's tile is
  streamed (before that, half the park and landmark probes read the far stand-in).
- **The ring at radius 60** is seen from each side of each border in turn: the camera stands
  75 m inside one tile (the streamer loads every tile within 60 m of the camera, so a camera
  30 m from the border, as first planned, streams both sides and tests no near/far seam), after
  a trip 3 km away to drop the other side (the streamer keeps tiles 250 m past the radius). The
  20 degree rays are automated there (`probeRay` in `tests/e2e/world-probe.ts`). At 544f67c none
  of the 1,014 straight-down probes over land finds the sea, but 72 of the 506 rays do (40 of 200
  at the Presidio): the streamed tile's edge drops below the far terrain and the sea shows
  through the crack, as the QA saw.
- **The tour at 544f67c**: 85 shots, every view settled with no failed tile and no console
  error; its probes find the three lakes drawn as lawn or grey ground, both beaches as lawn,
  four of five park probes grey and four of four foliage probes bare, and Coit Tower and Sutro
  Tower drawn as plain building records and both bridges absent. The drive view follows Geary
  Blvd with the gate's road follower at up to 20 m/s (with the game's traffic), not at full
  throttle with the wheel held straight, which left the road within 15 s. At 544f67c it covers
  only 156 m in 30 s: the car is held behind robotaxis waiting at Fillmore (the same hold-up
  that keeps the gate's hill routes free of traffic; without traffic the first 700 m take 75 s).
  The contact sheet notes the distance each run. The summit views stand
  on the highest ground within 80 m of their point.
- **The nightly tier at 544f67c** agrees with the QA where both measured the same thing: every
  street is 26,792 runs (385 mainland runs stopped, 47 starting inside a footprint, 84 airborne
  for 0.5 s or more, the QA's 84); the ring steps up to 21.57 m (the QA's 21.5 m); 690 records
  have no far hull and hulls stand up to 122 m too tall (the QA's 690 and 122 m); the drawn road
  differs from the sim's surface by up to 3.84 m on Kearny St, where the car-pose spec finds a
  3.9 m wheel gap. Every wall rammed: 0 escapes (W-08 holds); the shore's water side: 668 of the
  approaches still rise more than 1 m, up to 22 m (W-06 is partly fixed).
- **Floating wall bottoms (L-02)** count buildings (not towers, which stand on their podiums)
  whose drawn wall bottom stands more than 5 cm above the tile's drawn ground mesh. At 544f67c
  only the two south-edge records over the void (L-03) do; L-02 is left open until a person
  confirms the QA's 38 by eye.
- **Not automated yet** (left to the tour's human review): ribbon seam gaps (L-11), the canopy
  share of park land, the completeness of `manifest.outside`, adjacent houses sharing a colour,
  the Painted Ladies override, the Transamerica silhouette.

<!-- metrics:start (generated from tests/golden/world-qa-baseline.json by scripts/golden/world-docs.ts) -->
### The metrics at 544f67c

141 metrics. "enforced": every defect it tracks is fixed (or it is a pass check), so its target is a hard assertion; "ratchet": it may not get worse than its baseline; "at target": already there while a defect it tracks is still open.

| Metric | Suite (cadence) | Tracks | Baseline at 544f67c | Target | State | What it measures |
|---|---|---|---|---|---|---|
| `A.accounting.keptMatchesRecords` | buildings (pr) | pass check | 0 | <= 0 footprints | enforced | |report.json kept - footprint records in the colliders| (the report and the tiles agree) |
| `A.accounting.unexplained` | buildings (pr) | pass check | 0 | <= 0 footprints | enforced | source footprint parts neither kept nor dropped for a counted reason (report.json) |
| `A.facade.firstStoreyOffStreet` | buildings (pr) | W-29 | 0.111 | <= 0.01 share of street-facing records | ratchet | street-facing buildings whose first-storey line (meta.streetY, else baseY) is more than 1.5 m off the ground at the wall nearest the street |
| `A.facade.storeys5m` | buildings (pr) | W-15 | 0.611 | <= 0.02 share of residential records | ratchet | residential records the GLB draws with storeys of 5 m or more (_FACADE storey height) |
| `A.ground.lowAboveGround` | buildings (pr) | W-05 | 83 | <= 0 records | ratchet | records 4 m or taller whose roof stands less than 2 m above the highest ground under them |
| `A.ground.relief10` | buildings (pr) | W-28 | 466 | <= 0 records | ratchet | drawn parts with more than 10 m of ground relief under one roof |
| `A.ground.roofUnderGround` | buildings (pr) | W-05 | 22 | <= 0 records | ratchet | records with the ground above the roof anywhere inside the footprint (1 m raster) |
| `A.ground.wallBottomAboveGround` | buildings (pr) | L-03 | 2 | <= 0 records | ratchet | records whose wall bottom (meta.footY) is more than 0.3 m above the lowest ground along their walls (0.5 m samples) |
| `A.landmark.bridgesMissing` | buildings (pr) | W-24 | 2 | <= 0 landmarks | ratchet | of golden-gate-bridge and bay-bridge-west, entries missing from content/landmarks.json |
| `A.landmark.coitHeightError` | buildings (pr) | W-27 | 0.199 | <= 0.05 share of 64 m | ratchet | Coit Tower's height against the published 64 m |
| `A.landmark.heroWithoutShape` | buildings (pr) | W-27 | 10 | <= 0 landmarks | ratchet | hero landmarks (Transamerica, Coit, Saints Peter and Paul, Palace of Fine Arts, City Hall, Grace Cathedral, Mission Dolores, the Conservatory, Dragon Gate, Sutro Baths) with neither a model nor an interim shape without the office window grid |
| `A.landmark.sutroRecordHeight` | buildings (pr) | W-26 | 3.44 | <= 10 m above ground | enforced | Sutro Tower's footprint records stay low plinths, never the solid 231 m slab |
| `A.landmark.sutroTowerTopM` | buildings (pr) | W-25 | 0 | >= 290 m above ground | ratchet | a sutro-tower landmark at 37.7552,-122.4528 whose model top is 290 m or more above its ground |
| `A.newer.cells3` | buildings (pr) | W-04 | 13 | <= 0 100 m cells | ratchet | 100 m cells holding 3 or more of those unmatched parcel points (a missing block) |
| `A.newer.missionRockTall` | buildings (pr) | W-04 | 0 | >= 4 records | ratchet | records 40 m or taller in the Mission Rock box (37.7740-37.7765, -122.3905..-122.3875) |
| `A.newer.publishedHeightFails` | buildings (pr) | W-04 | 4 | <= 0 towers | ratchet | towers whose tallest record within 30 m is not within 10% of the published height (Salesforce, Transamerica, 555 California, One Rincon Hill, 250 Howard, The Avery, 706 Mission, 33 Tehama, Fifteen Fifty) |
| `A.newer.unmatched` | buildings (pr) | W-04 | 122 | <= 10 parcel points | ratchet | post-2015 assessor parcel points with storeys and no building record within 25 m |
| `A.pack.recordMismatches` | buildings (pr) | pass check | 0 | <= 0 records | enforced | building records whose collider-pack copy differs from the tile JSON (footprint, baseY, topY) |
| `A.phantom.fortPointHeight` | buildings (pr) | W-16 | 64.61 | <= 25 m above ground | ratchet | Fort Point (201006.0000856 and its tower): roof above the ground at the centroid (the LiDAR caught the bridge deck above it) |
| `A.phantom.tallOnStreet` | buildings (pr) | W-16 | 11 | <= 0 records | ratchet | records more than 30 m tall standing on a surface street's centreline (no underside clearing the road) |
| `A.rings.coplanarRoofs` | buildings (pr) | L-01 | 24 | <= 0 pairs | ratchet | overlapping footprint pairs (2 m2 or more) whose roofs are within 0.1 m: z-fighting roofs |
| `A.rings.duplicates` | buildings (pr) | L-01 | 23 | <= 0 pairs | ratchet | footprint pairs overlapping by 90% or more of the smaller one (0.5 m raster; a podium and its own tower excluded) |
| `A.rings.nonSimple` | buildings (pr) | W-30 | 193 | <= 0 rings | ratchet | footprint and tower rings that cross themselves (double roofs, slabs outside the walls) |
| `D.beaches.sandShare` | cover (pr) | W-34 | 0 | >= 0.9 share | ratchet | share of the Ocean, Baker, China and Crissy beaches (land within 80 m of the sea, up to 8 m) drawn as sand |
| `D.foliage.parkTilesShare` | cover (pr) | W-18 | 0 | >= 1 share of tiles | ratchet | share of the tiles over Golden Gate Park, the Presidio, McLaren, Lincoln Park, Buena Vista, Glen Canyon, Sutro Forest and Mt Davidson whose GLB has a foliage node |
| `D.lakes.drawnGrassHa` | cover (pr) | W-11 | 5.06 | <= 0 ha | ratchet | lake surface (the eight hydro-flattened lakes) drawn as grass |
| `D.parks.greenShare` | cover (pr) | W-18 | 0.437 | >= 0.9 share of park land | ratchet | share of Rec and Park land (lattice vertices in the 255 properties) drawn as grass or forest |
| `D.parks.propertiesUnder10pct` | cover (pr) | W-18 | 240 | <= 0 properties | ratchet | Rec and Park properties less than 10% of whose land is drawn green |
| `D.shore.drawnGrassHa` | cover (pr) | W-18, W-34 | 31.07 | <= 0 ha | ratchet | shore land 1.5 to 8 m high within 80 m of the sea drawn as grass (beaches and bluffs painted lawn) |
| `F.determinism.hashMismatches` | determinism (pr) | pass check | 0 | <= 0 checkpoints | enforced | 60 s of step() with two players and traffic, twice from the collider pack and once from the per-tile JSON colliders: 600-tick state hashes that differ |
| `F.bridges.failingRuns` | drive (pr) | W-12 | 16 | <= 0 runs | ratchet | drives over the 3rd St, 4th St, 3rd St (Islais) and Illinois St bridges, both ways at 15 and 25 m/s, that dip below the lower abutment - 0.2 m, leave the ground or stop |
| `F.buried.carMaxJumpM` | drive (pr) | W-05 | 23.15 | <= 0.5 m | ratchet | cars driven at the 31 buried-roof sites: the most one tick moves a car beyond speed * DT (teleported out of a buried footprint) |
| `F.buried.walkerLowWallStops` | drive (pr) | W-05 | 29 | <= 0 sites | ratchet | buried-roof sites where a walker is stopped by a wall less than 2.5 m tall (an invisible wall at roof level) |
| `F.crossings.airborneRuns` | drive (pr) | W-14 | 66 | <= 0 runs | ratchet | street-over-freeway crossings, each driven straight at 15 m/s, that leave the car airborne for more than 0.2 s (trenches and humps) |
| `F.crossings.richlandAirS` | drive (pr) | W-14 | 2.33 | <= 0.2 s | ratchet | Richland Ave over I-280 (c11011002) at 16 and 20 m/s both ways: the longest airborne interval |
| `F.lake.mercedDrivenM` | drive (pr) | W-11 | 620 | <= 10 m | ratchet | metres a car drives across South Lake Merced's flattened surface (it should be stopped or towed at the water's edge) |
| `F.named.runsStopped` | drive (pr) | W-01, W-02, W-12, W-14, W-43 | 31 | <= 0 runs | ratchet | runs over the named streets (1st St, Howard, Kearny, Upper Market, Battery, Elk, Houston, Crescent, Mason, Winston, Walnut, the Broadway, Stockton and Toll Plaza tunnels, Lombard, the creek bridges, Richland, Twin Peaks Blvd, Filbert, Vermont), each allowed direction at the posted speed, that do not reach the end |
| `F.placement.maxJumpM` | drive (pr) | W-51 | 23.22 | <= 0.5 m | ratchet | the same placements: the most one tick moves the car beyond speed * DT (pushed out of a footprint in one tick) |
| `F.placement.maxRiseM` | drive (pr) | W-51 | 0.34 | <= 0.5 m | at target | a car placed at each of the 58 start-blocked street starts and at the 8 multiplayer spawn slots, then driven off: the most it rises above the ground |
| `F.ram.launches` | drive (pr) | W-23 | 211 | <= 0 rams | ratchet | of 360 seeded rams at 25 m/s into buildings on 15%+ ground (Russian Hill, west of Twin Peaks, Bernal), those that leave the car airborne over 0.3 s or lift it over 0.5 m |
| `F.sample.runsStopped` | drive (pr) | W-01 | 11 | <= 0 runs | ratchet | runs over the critic's seeded 300-edge sample of surface streets (every k-th edge by id, each allowed direction) that do not reach the end |
| `F.tunnels.failingRuns` | drive (pr) | W-02 | 6 | <= 0 runs | ratchet | drives through the Broadway, Stockton and Toll Plaza tunnels at 25 m/s that hit something, leave the ground or stray more than 1 m from the straight portal-to-portal line |
| `E.freeway.i280Stops` | edge (pr) | W-07, W-03 | 2 | <= 0 drives | ratchet | of I-280 northbound and southbound driven end to end at 25 m/s, drives that stop before the end |
| `E.freeway.landEdgesCrossingWalls` | edge (pr) | W-07 | 3 | <= 0 edges | ratchet | freeway (gradeSeparated) edges with both ends on land, crossing no more than 300 m of water, whose centreline crosses a wall (I-280 at the creeks) |
| `E.gaps.carRunsOffCorridor` | edge (pr) | W-21 | 0 | <= 0 runs | enforced | car runs (10 and 25 m/s, turning 30/60/90 deg either way on each road over water) that get more than 1 m outside the road's corridor on the water side |
| `E.gaps.maxOutOnWaterM` | edge (pr) | W-21 | 0 | <= 1 m | enforced | the farthest those cars get outside the corridor on the water side |
| `E.gaps.walkerRunsOffCorridor` | edge (pr) | W-21 | 0 | <= 0 runs | enforced | sprinting walkers turning off a road over water who get more than 1 m outside its corridor on the water side |
| `E.launch.maxRiseM` | edge (pr) | W-06 | 8.94 | <= 1 m | ratchet | the highest any of those cars rose above the ground |
| `E.launch.sampleLaunches` | edge (pr) | W-06 | 98 | <= 0 runs | ratchet | of cars driven at the shore wall from 2.5 and 6 m out on the water at 5/15/30 m/s (a fixed sample of 200 shore points), runs that rise over 1 m or jump more than speed*DT + 0.5 m in a tick |
| `E.net.buildingsWithoutStreet` | edge (pr) | W-42 | 911 | <= 0 buildings | ratchet | buildings with no drivable street within about 150 m (the Daly City strip south of the county line), unless their tile is listed as scenery-only (manifest.sceneryOnly) |
| `E.net.districtMinReach` | edge (pr) | pass check | 0.962 | >= 0.95 share of nodes | enforced | the lowest share, over mainland districts, of a district's street nodes a car can reach from the spawn (one-way streets obeyed) |
| `E.net.mainlandLargestShare` | edge (pr) | pass check | 0.995 | >= 0.97 share of nodes | enforced | share of the mainland's drivable street nodes (freeways, ramps and paths left out) in its largest connected piece |
| `E.net.outlineCoverFails` | edge (pr) | pass check | 0 | <= 0 10 m pieces | enforced | 10 m pieces of the built tiles' outline that boundary.json's edge runs cover other than exactly once |
| `E.net.seamDeadEnds` | edge (pr) | pass check | 0 | <= 0 nodes | enforced | road ends that stop exactly on a tile seam between two built tiles (a road cut by the tiling) |
| `E.push.excessLiftMps` | edge (pr) | W-06, W-23, W-51 | 0 | <= 0 m/s | at target | unit: the most a car pushed out of a building onto a 3 m bank, placed overlapping a footprint, or scraping a wall on a cross slope rises faster than |v| * grade + 1 m/s |
| `E.walls.sampleEscapes` | edge (pr) | W-08 | 0 | <= 0 ram tests | enforced | ram tests (car at 30 m/s at 0/+-30/+-60 deg, sprinting walker at 0/+-45 deg) from a fixed sample of 97 wall starts that cross a real wall or leave the built tiles |
| `F.walk.routesFailing` | foot (pr) | W-39 | 6 | <= 0 walks | ratchet | walks that fail: Filbert St up at 1.0 m/s or better, the Lyon St and Filbert steps both ways, 22nd St up, a seam on a slope, Pemberton Pl and Cottage Row both ways |
| `F.walker.verticalFails` | foot (pr) | W-52 | 2 | <= 0 checks | ratchet | unit: walking off a 3 m drop takes at least 0.7 s to land; a walker cannot climb a slope steeper than 100% taller than 1 m |
| `H.bays.anchorShare` | houses (pr) | W-49 | 0 | >= 0.9 share of candidates | ratchet | bay-window anchors drawn (GLB extras "bays") against the street-facing houses from 1925 or earlier |
| `H.cracks.sampleBoxPairs` | houses (pr) | W-36 | 291 | <= 0 pairs | ratchet | row-house pairs 5 to 60 cm apart (cracks opened by simplification) in the Sunset, Mission, Marina and Russian Hill sample boxes |
| `H.garages.anchorShare` | houses (pr) | W-48 | 0 | >= 0.9 share of candidates | ratchet | garage-door anchors drawn (GLB extras "garages") against the street-facing 1920-1960 houses of the Sunset, West of Twin Peaks, Outer Richmond, Excelsior and Marina rows |
| `H.palette.pre1915SaturatedShare` | houses (pr) | W-37 | 0 | >= 0.3 share | ratchet | share of pre-1915 houses drawn with a wall colour of saturation 0.3 or more (Victorian and Edwardian colours, not one pastel class) |
| `H.roofs.shapedShare` | houses (pr) | W-38 | 0 | >= 0.8 share | ratchet | share of single-family houses whose drawn roof is not one flat slab (roof vertices span more than 0.5 m: gables, hips, parapets) |
| `H.seawall.embarcaderoRampShare` | houses (pr) | W-35 | 0.94 | <= 0 share of shore samples | ratchet | Embarcadero shore samples (every 10 m, Pier 39 to the ballpark) where the promenade, 2.5 m or higher 10 m inland, falls below 2 m within 1 m of the shore line (a ramp into the Bay, no quay face) |
| `H.stoops.blankBandOver2_5m` | houses (pr) | W-50 | 834 | <= 0 houses | ratchet | street-facing houses whose drawn first-storey line stands more than 2.5 m above the street at their front (a blank plinth with no stoop, entry or garage storey) |
| `H.storefronts.shopBandShare` | houses (pr) | W-47 | 0.081 | >= 0.95 share of anchors | ratchet | share of the storefront anchors (storefronts.json) whose wall is drawn with shop glazing |
| `H.walls.frontClassedShare` | houses (pr) | W-46 | 0 | >= 0.9 share | ratchet | share of residential records with a wall drawn as the street front (_FACADE.w = 170), so fronts, party walls and rear walls differ |
| `F.routes.belowSurfaceM` | routes (pr) | W-22 | 0.173 | <= 0.1 m | ratchet | on those routes: the deepest the car goes below the surface under it |
| `F.routes.maxAirborneS` | routes (pr) | W-14 | 0.83 | <= 0.8 s | ratchet | on those routes: the longest airborne interval (real crests like Filbert allow up to 0.8 s at 25 m/s) |
| `F.routes.maxJumpM` | routes (pr) | pass check | 0.002 | <= 0.5 m | enforced | on those routes: the most one tick moves the car beyond speed * DT |
| `F.routes.rerunHashMismatches` | routes (pr) | pass check | 0 | <= 0 checkpoints | enforced | a route driven twice with step(): state hashes that differ at the 600-tick checkpoints |
| `F.routes.seamStepM` | routes (pr) | pass check | 0.003 | <= 0.1 m | enforced | on those routes: the largest jump in the car's height change at a tile seam |
| `F.routes.stopped` | routes (pr) | W-01, W-14 | 2 | <= 0 routes | ratchet | of the 11 closed-loop routes (Filbert up and Lombard down, California over Nob Hill, Market to Twin Peaks, 22nd St, Fillmore, Vermont, Great Hwy, 19th Ave, JFK Dr, 3rd St, a diagonal across the city), driven with the full step() (no ambient traffic), those held by a building or a wall before the end |
| `C.bridges.dippingDecks` | streets (pr) | W-12 | 4 | <= 0 bridges | ratchet | of the 3rd St, 4th St, 3rd St (Islais) and Illinois St creek bridges, those whose road surface dips more than 0.2 m below the lower bank (no deck) |
| `C.clearance.carriagewayEdges` | streets (pr) | W-01 | 384 | <= 0 edges | ratchet | surface street edges with a centreline sample within 0.95 m (the car's half width) of a footprint whose roof is over 0.5 m above the road and whose underside is under road + 4.5 m |
| `C.clearance.lombardEdges` | streets (pr) | W-43 | 2 | <= 0 edges | ratchet | of Lombard St c8448000 (the crooked block) and c8449000 (the approach from Hyde), edges whose centreline passes within 0.95 m of a house |
| `C.clearance.pedestrianEdges` | streets (pr) | W-39 | 62 | <= 0 edges | ratchet | pedestrian edges (stairways, paths) with a centreline sample within 0.75 m of a blocking footprint |
| `C.freeway.insideFootprintsM` | streets (pr) | W-03 | 435 | <= 0 m | ratchet | metres of freeway and ramp centreline inside footprints that block its surface |
| `C.freeway.maxGradePct` | streets (pr) | W-03 | 143.22 | <= 6 % | ratchet | steepest 10 m along any freeway (ramps excluded) on its drivable surface |
| `C.freeway.separatedCrossingsShare` | streets (pr) | W-03, W-14 | 0 | >= 1 share | ratchet | share of street-over-freeway crossings where the freeway's surface and the street's are at least 5 m apart (a deck or a cut, not an at-grade junction) |
| `C.piers.buildingsOnWater` | streets (pr) | W-13 | 103 | <= 0 buildings | ratchet | buildings at least half over open water with no deck under them (baseY under 1 m) |
| `C.piers.streetsAtSeaLevel` | streets (pr) | W-13 | 4 | <= 0 streets | ratchet | of Al Scoma Way, Pier 45 Vly, Pier 50 Vly and Unnamed 42, pier streets with road surface under 0.5 m (no pier deck) |
| `C.profile.edgesWithoutProfile` | streets (pr) | W-09, W-31 | 1 | <= 0 share of drivable edges | ratchet | drivable edges without a 2 m road profile in roads.json (one surface for the sim and the drawn ribbon) |
| `C.props.lampsOnRoad` | streets (pr) | W-44 | 0.095 | <= 0 share of streetlights | ratchet | streetlights standing on a road ribbon (+0.5 m), from the renderer's streetlightSpots |
| `C.props.treesInBuildings` | streets (pr) | W-44 | 0.058 | <= 0 share of street trees | ratchet | street trees standing inside a building footprint |
| `C.props.treesOnRoad` | streets (pr) | W-44 | 0.045 | <= 0 share of street trees | ratchet | street trees standing on a road ribbon (+0.5 m), from the renderer's streetTreeSpots |
| `C.sidewalks.tilesWithoutSidewalks` | streets (pr) | W-45 | 547 | <= 0 tiles | ratchet | tiles with streets whose GLB draws no sidewalk geometry (no sidewalks node) |
| `C.stairs.carDrivable` | streets (pr) | W-33 | 4 | <= 0 stairways | ratchet | of those present, stairways the car can drive end to end (the steps are drawn and driven as a smooth ramp) |
| `C.stairs.missing` | streets (pr) | W-33 | 2 | <= 0 stairways | ratchet | of the Filbert, Greenwich, Lyon, 16th Ave, Vulcan and Harry St stairways, those with no pedestrian edge in roads.json |
| `C.stairs.notMarkedStairs` | streets (pr) | W-33 | 4 | <= 0 stairways | ratchet | of those present, stairways whose edges are not marked as stairs |
| `C.tunnels.broadwayAbovePortalLineM` | streets (pr) | W-02 | 49.68 | <= 1 m | ratchet | how far the Broadway Tunnel's road surface rises above the straight line between its ends (it is draped over Russian Hill) |
| `C.tunnels.insideFootprintsM` | streets (pr) | W-02 | 578 | <= 0 m | ratchet | metres of Broadway, Stockton and Toll Plaza tunnel centreline inside footprints that block the road surface |
| `C.tunnels.unflagged` | streets (pr) | W-02 | 7 | <= 0 tunnels | ratchet | of Broadway, Stockton, Toll Plaza, MacArthur, YBI and the two Presidio Parkway tunnels, those whose road edges are not all flagged as tunnels |
| `B.coverage.badTiles` | terrain (pr) | pass check | 0 | <= 0 tiles | enforced | built tiles without a finite 51x51 heightfield and water mask on the 500 m grid |
| `B.grades.famousFails` | terrain (pr) | pass check | 0 | <= 0 blocks | enforced | famous steep blocks whose steepest 10 m on the drivable surface is outside the published grade's tolerance (Filbert, 22nd, Jones, Duboce, Fillmore) |
| `B.grades.hillsideLatticeFails` | terrain (pr) | W-31 | 4 | <= 0 roads | ratchet | hillside-crossing roads (Vermont c13216002, Twin Peaks Blvd c12770000, Vasquez c13186101, Kensington c7806001) whose steepest 10 m exceeds the 1 m DEM's by more than 5 points or whose grade break exceeds it by more than 10 |
| `B.groundParity.max` | terrain (pr) | W-22 | 1.175 | <= 0.02 m | ratchet | largest |sim ground - drawn ground| at the same 10,000 points |
| `B.groundParity.p99` | terrain (pr) | W-22 | 0.261 | <= 0.02 m | ratchet | 99th percentile of |sim ground - drawn ground| at 10,000 seeded land points (the drawn ground splits each 10 m cell into two triangles; the sim is bilinear) |
| `B.lakes.dryHa` | terrain (pr) | W-11 | 78.3 | <= 0 ha | ratchet | lake surface (the same eight lakes) that is dry land, hectares (one lattice vertex = 0.01 ha) |
| `B.lakes.minWaterShare` | terrain (pr) | W-11 | 0 | >= 0.9 share | ratchet | the smallest share, over Lake Merced, Stow, Spreckels, Pine, Elk Glen, Laguna Honda, the Palace lagoon and the Crissy marsh, of the lake's lattice vertices that are water at the lake's level |
| `B.seams.maxStep` | terrain (pr) | pass check | 0 | <= 0 m | enforced | largest height difference on a tile border (every 2.5 m) between the two neighbours' lattices |
| `B.summits.fails` | terrain (pr) | pass check | 0 | <= 0 summits | enforced | of 25 named summits, those whose sim ground maximum within 150 m is not within 1 m of the 3DEP DEM maximum (the published heights differ from the DEM by up to 47 m for known reasons and are listed in the details) |
| `G.carPose.pitchErrorDeg` | car-pose (e2e) | W-19 | 0 | <= 1 deg | enforced | on Filbert, Twin Peaks Blvd and Kearny: the drawn car's pitch against the sim's |
| `G.carPose.wheelGapM` | car-pose (e2e) | W-09 | 3.9 | <= 0.1 m | ratchet | on the same streets: the largest gap between a wheel's lowest point and the drawn road under it (the car sinks into the ribbon) |
| `G.far.cellsDrawnFromTwinPeaks` | car-pose (e2e) | W-20 | 13 | >= 4 far cells | enforced | from Twin Peaks looking north-east: far-LOD cells drawn in the last frame (the skyline beyond the streamed tiles) |
| `N.far.farAboveNearKm` | far (nightly) | W-17 | 83.26 | <= 0 km | ratchet | border length where the far terrain stands more than 1 m above the near ground (the sea shows through the crack) |
| `N.far.lowHullsP99M` | far (nightly) | W-41 | 8.3 | <= 5 m | ratchet | the 99th percentile of |far hull roof - roof| for records under 30 m |
| `N.far.outerLandUncovered` | far (nightly) | W-40 | 310 | <= 0 samples | ratchet | land samples on the city's outer edge (every 5 m) with no far terrain 1 m beyond them (the city edge floats over the sea) |
| `N.far.recordsWithoutHull` | far (nightly) | W-41 | 690 | <= 0 records | ratchet | records with no far hull or cluster over their centroid |
| `N.far.ringStepMaxM` | far (nightly) | W-17 | 21.57 | <= 2 m | ratchet | the largest such step |
| `N.far.ringStepP99M` | far (nightly) | W-17 | 7.44 | <= 1 m | ratchet | 99th percentile of |near ground - far terrain| across every built tile's border, every 5 m (the step at the streaming ring) |
| `N.far.sanBrunoSummitErrorM` | far (nightly) | W-40, W-17 | 402 | <= 10 m | ratchet | San Bruno Mountain's far-terrain summit against its 402 m (the far layer stops short of it) |
| `N.far.tallHullsOff3m` | far (nightly) | W-41 | 44 | <= 0 records | ratchet | records 30 m or taller whose far hull's roof over their centroid differs from their roof by more than 3 m (the skyline pops when the tile streams in) |
| `N.far.uncoveredTilesMinShare` | far (nightly) | W-40 | 0 | >= 0.95 share | ratchet | the lowest far-terrain coverage of t-16_21, t-4_21, t-3_21 and t7_-5 (land beside the built tiles that has no far terrain) |
| `N.freeways.airborneRuns` | freeways-all (nightly) | W-03 | 96 | <= 0 runs | ratchet | freeway and ramp runs at 25 m/s airborne for more than 0.3 s (draped viaducts launching the car) |
| `N.freeways.hardLandings` | freeways-all (nightly) | W-03 | 76 | <= 0 runs | ratchet | freeway and ramp runs with a landing harder than 3 m/s |
| `N.freeways.stuckRuns` | freeways-all (nightly) | W-03, W-07 | 17 | <= 0 runs | ratchet | freeway and ramp runs that stop before the end (buildings on the freeway, sea walls) |
| `N.glb.doubleRibbonShare` | glb (nightly) | W-32 | 0.062 | <= 0.005 share of road area | ratchet | road area (0.5 m raster) covered by two or more ribbons at once (junction overlaps that z-fight) |
| `N.glb.floatingWallBottoms` | glb (nightly) | L-02, L-03 | 2 | <= 0 buildings | ratchet | buildings (not towers on their podiums) whose drawn wall bottoms stand more than 0.05 m above the drawn ground; at 544f67c only the two south-edge records over the void (L-03) |
| `N.glb.freewayUnderGroundShare` | glb (nightly) | W-03, W-10 | 0.105 | <= 0 share of freeway area | ratchet | freeway ribbon area (1 m raster) under the drawn ground |
| `N.glb.groundSeamMismatches` | glb (nightly) | pass check | 0 | <= 0 vertices | enforced | ground border vertices whose height differs from the neighbouring tile's vertex at the same place (cracks) |
| `N.glb.groundThroughRoadsShare` | glb (nightly) | W-10 | 0.02 | <= 0 share of road area | ratchet | road ribbon area (0.5 m raster) where the drawn ground is more than 0.02 m above the ribbon |
| `N.glb.parityMismatches` | glb (nightly) | pass check | 0 | <= 0 records | enforced | building records without exactly one GLB range in the same order, or whose drawn roof and footprint extents differ from the collider by more than 0.1 m (invisible walls, ghost meshes) |
| `N.glb.roadSunkShare` | glb (nightly) | W-09 | 0.039 | <= 0 share of samples | ratchet | centreline and kerb-inset samples (every 2 m of every surface street) where the drawn road is more than 0.3 m above the sim's surface (the car sinks into the road) |
| `N.glb.roadSurfaceMaxM` | glb (nightly) | W-09 | 3.84 | <= 0.05 m | ratchet | the largest |drawn road top - sim surface| over the same samples |
| `N.glb.roadSurfaceP99M` | glb (nightly) | W-09 | 0.497 | <= 0.05 m | ratchet | the 99th percentile of |drawn road top - sim surface| over the same samples |
| `N.paths.walksBlocked` | paths-all (nightly) | W-39 | 77 | <= 0 walks | ratchet | walks along every pedestrian edge (stairways, paths), both ways, with stepFoot, that do not reach the end |
| `N.streets.airborneRuns` | streets-all (nightly) | W-14 | 84 | <= 0 runs | ratchet | street runs airborne for 0.5 s or more at the posted speed (no real SF crest is listed yet) |
| `N.streets.districtMinReachedShare` | streets-all (nightly) | W-01 | 0.843 | >= 0.995 share of runs | ratchet | the lowest share, over districts, of street runs that reach their end |
| `N.streets.mainlandStartBlocked` | streets-all (nightly) | W-01, W-51 | 47 | <= 0 runs | ratchet | mainland street runs whose start (and every start up to 20 m in) overlaps a footprint |
| `N.streets.mainlandStuck` | streets-all (nightly) | W-01 | 385 | <= 0 runs | ratchet | mainland street runs (every surface edge, each allowed direction, at the posted speed up to 20 m/s) that stop before the end |
| `N.walls.escapes` | walls-all (nightly) | W-08 | 0 | <= 0 ram tests | enforced | ram tests from all 771 dry wall starts every 100 m (car at 30 m/s at 0/+-30/+-60 deg, sprinting walker at 0/+-45 deg) that cross a real wall or leave the built tiles |
| `N.walls.launches` | walls-all (nightly) | W-06 | 668 | <= 0 runs | ratchet | cars driven at the shore wall from 2.5 and 6 m out on the water at 5/15/30 m/s, every 50 m of shore, that rise over 1 m or jump more than speed*DT + 0.5 m in a tick |
| `N.walls.maxRiseM` | walls-all (nightly) | W-06 | 22.04 | <= 1 m | ratchet | the highest any of those cars rose above the ground |
| `G.farRing.seaThroughProbes` | far-ring (e2e-nightly) | W-17 | 72 | <= 0 probes | ratchet | at radius 60, at the three worst near/far borders seen from each side: straight-down probes 2 m either side and 20-degree rays from the streamed side, over sim land every 5 m, that find the sea plane or nothing |
| `G.tour.beachesNotSand` | world-tour (e2e-nightly) | W-34 | 2 | <= 0 probes | ratchet | tour probes on Ocean Beach and Baker Beach whose drawn surface is not sand |
| `G.tour.lakesNotWater` | world-tour (e2e-nightly) | W-11 | 3 | <= 0 probes | ratchet | tour probes at Stow Lake, Spreckels Lake and Lake Merced whose drawn surface is not water |
| `G.tour.landmarksMissing` | world-tour (e2e-nightly) | W-24, W-25, W-27 | 4 | <= 0 probes | ratchet | tour probes at Coit Tower, Sutro Tower, the Golden Gate Bridge and the Bay Bridge whose topmost drawn surface is not that landmark's model |
| `G.tour.parksNotGreen` | world-tour (e2e-nightly) | W-18 | 4 | <= 0 probes | ratchet | tour probes in Golden Gate Park, Dolores Park, Buena Vista, Glen Canyon and Mt Davidson whose drawn ground is not green |
| `G.tour.parksWithoutFoliage` | world-tour (e2e-nightly) | W-18 | 4 | <= 0 probes | ratchet | tour probes in Golden Gate Park, Buena Vista, Mt Davidson and the Presidio with no foliage drawn within 60 m |
| `G.tour.viewProblems` | world-tour (e2e-nightly) | pass check | 0 | <= 0 views | enforced | tour views whose tiles did not settle, failed to load, had no far cell, or logged a console error |
<!-- metrics:end -->
