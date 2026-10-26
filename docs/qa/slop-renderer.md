# Fog City local renderer and encounter QA

Status: **local functional, rendering and packed-build checks complete at the recorded source; the allocation/performance hold remains open.** The owner requested Slop New York rendering methods/style, the accumulated traffic/people/taxi/building/grass changes, and robots that engage the player and can be fought. The work was prepared locally for one consolidated PR to main. CI is intentionally not run. No production or public-release result is implied.

## Source and preservation

- Commit: [67c422ab](https://github.com/BroderickHigby/fog-city/commit/67c422abeab63f0e29bfe67e31780b48cc9b5195); clean Git tree: `73718f843b9cebb5c042aa1ffb30ed8fe99e0c90`.
- Renderer tree: `7a20139599252bb2a8ca4d612f46569d6229f897`. Simulation tree: `c08d342c477d5cda798ea861f33bdb56588f3f1b`. Content tree: `8db5281d88bfab9514b912add7377bfbba65a31f`.
- The rendering adaptation pins [Slop New York at 64ad030](https://github.com/mrdoob/slop-newyork/tree/64ad03022bee9065a170ea286e2fd8e9d2b9a268). WebGPU/TSL, physical sky/PMREM, two sun cascades, filtered facades/room interiors, SSR/bloom and open foliage are implemented. The complete MIT notice is retained in source; the builder copies it into packed third-party notices, verified byte-for-byte in the final packed third-party notices. No NYC/OSM geography is imported; SF roads, footprints, landmarks and collision/navigation data are preserved.
- Prior integrated car artwork, approximately 30-second safe civilian admission, 3.5 m/s jog / 8 m/s sprint, shoe support/toe alignment, H taxi control, targeting-only reticle, building detail, mapped grass, saves, missions and multiplayer remain included. This is a whole-main integration, not solely a renderer patch.
- SIM_VERSION 17 adds proactive eligible on-foot encounters within 18 m and fixes ambient firmware sampling. Only rogue ground robots initiate; good robots, people and animals are not new enemies. Reactive pursuit, sight/fog/LOS, protection and physical admission remain in force. Proactive checks inject no enemies of their own. Existing director incidents can create their normal actors sooner: new-player schedules begin 15–20 s, known time/body mode constrains card selection, and at most eight ranked legal placements are attempted. An empty-endpoint fallback samples actual sidewalk edges; crosswalk cards remain crosswalk-only. There is no new spawn mechanism, probability increase or cap/clearance relaxation. The availability repair preserves the authored 2% base share and assigned firmware. Same-tick actor counts are not identical: the v17 service pin changes 2→6 through earlier existing incidents.
- Existing saved schedules/later cadence and v16 paths are retained; historical golden files remain unchanged. Only the unreleased v17 composed pin changes. Protection queries are reused at unchanged actor coordinates. A private weak polygon-projection cache validates numeric vertices, length and projection origin; mutable edits still produce the original projection/even-odd results, with no geography change.

## Local checks completed

Node 22, pnpm 9.12; initial and focused runs used one worker, final full run used two capped workers with no candidate browser alongside it (`NODE_OPTIONS=--max-old-space-size=2048` per worker); heavy jobs were serialized; commands below run from the repository root. Results are separate batches and must not be summed into one full-suite pass.

| Scope | Result |
| --- | --- |
| Initial complete unit suite at [c43d510](https://github.com/BroderickHigby/fog-city/commit/c43d510107782d7fa695fa16ddcbbd50984f5cb4) | 245 files passed / four failed; 3,976 tests passed / four failed / one skipped, about 1,016 s. Failures: UI-copy provenance, night-bloom restraint, Marina discovery timing, allocation guard. |
| Provenance and bloom repair |60 tests passed. Canonical copy hash corrected; night bloom 0.29 now meets the existing strict <0.3 contract. Tests/limits were not loosened. |
| Real-SF availability |Four hubs passed after repair (FiDi, SoMa, Marina, North Beach; seed 7; about 104 s). Each district meets first bad robot <30 s / 150 m, average ≥2 within 300 m; incidents and zero-contact assertions retained. This is a controlled district-start fixture, not a player travel recording. |
| Final director/placement/current17 and old16 batch |51 tests passed, including all six old-v16 composed scenarios. |
| Content/projection cache | 1,186 passed / one skipped across 25 files; five new reuse/mutation/original-math equivalence checks. Separate old-v16 run: six passed, seven current-pin cases intentionally skipped. |
| Final complete unit suite at 67c422ab |251 files passed / one failed; 3,995 tests passed / one failed / one skipped, 660.28 s. The sole failure is the unchanged allocation guard; every functional test passed. |
| Typecheck and independent review |Typecheck passed at67c422ab; independent exact-head Standards and Spec each found zero actionable introduced defects. |

Reproduction entry points:

```sh
pnpm typecheck
pnpm exec vitest run tests/content/provenance.test.ts tests/render/lighting-presets.test.ts --maxWorkers=1
pnpm exec vitest run tests/sim/agents/bad-bots-sf.test.ts --maxWorkers=1
pnpm exec vitest run tests/sim/player/city-life-director.test.ts tests/sim/agents/incident-placement.test.ts tests/sim/agents/encounter-protection-cache.test.ts tests/sim/agents/robot-encounter.test.ts tests/golden/composed.test.ts --maxWorkers=1
pnpm exec vitest run tests/content --maxWorkers=1
pnpm exec vitest run tests/golden/composed.test.ts --maxWorkers=1 --testNamePattern 'preserves the recorded v16'
```

## Current CPU fight proof

Fresh 67c recorder fingerprint: `824061cbb1f2d0a39526b5b8ef771afc00cb6937820eca156a7a2953574baf94` (SHA256 over 188 files: simulation/content/geo TypeScript plus content JSON). Fresh SF seed 1 / wave 3, p1, initial tick 0 / hash `75b959f3`; normal recorded input/UI events, no teleport, forced firmware/hit/rust or injected actor state. Comparison with the preserved prior recording confirms equal inputs, events, route, actor, milestone hashes and combat outcomes.

| Existing actor agent:538 milestone | Tick | State hash |
| --- | ---: | --- |
| Player-targeted ad-blast windup |3932|`33252cfa`|
| Resolution and player ad effect |3980|`05c668c0`|
| Actual water shot / first rust |3981 /4000|`ac108128` / `311aff8f`|
| Rust 0.60 / seizure |4138 /4242|`3ccfa43a` / `06279848`|
| Slump / heap |4272 /4362|`a4a5ea0c` / `12a94c7b`|

This records logic through heap in 72.7 simulated seconds, with the first player-targeted robot windup at 65.5 s. The separate exact-source browser proof below verifies selected rendered milestones and real close-button behavior. Source tests cover resolved owned ad projection and exact live-ID close pulses, stale/cross-owner refusal, provider overrides and legacy boolean behavior.

## Rendering, resource and performance limits

Native Apple/metal-3 captures at the recorded renderer checkpoints show SF golden/noon/night scenes, two allocated cascades and completed SSR/bloom. A repaired node-WebGL probe is clean; portable sprite paths preserve lamp/particle sizes. Actual F/W/Shift and E/release input observations are smoke checks, not exhaustive shoe/taxi/recovery acceptance. Earlier failed headless native requests actually fell back to legacy and are not native evidence.

The [513f checkpoint](https://github.com/BroderickHigby/fog-city/commit/513f4f341a6e6d9f2ab4bf7ba81545026e6f8314) two-cycle native lifetime assessment accepts the specific storage/instance-color/skinned-object retirement fixes. Repeated outbound state matches: 734 UBOs / 221,136 B; 194 storage attributes / 3,492,416 B; 906 vertex attributes / 31,402,453 B; 410 programs. Comparing every numeric backend-memory field leaves only two late textures / +218,398 B. The raw strict report remains `passed:false`, `bufferPlateau:false`: return cameras differ 13.45 m and their resources differ. This is not a whole-scene plateau, physical resident-RAM result, full-city soak or hardware FPS/parity claim.

The latest repair-tree allocation measurement still fails the unchanged guard: **6,108,174.8 B/tick > 5,978,783.2**, about 2.16% over. Ratio **5.302 passes 8.536** (best 4.79 ms/tick versus 0.90 ms calibration). Baseline ratio 5.335 / allocation 4,599,064 B and margins 1.6 / 1.3 are unchanged. This is the sole failure in the final complete 67c unit run; the result is not wholly green. Allocated bytes/tick are churn, not resident memory. The older [PR93](https://github.com/BroderickHigby/fog-city/pull/93) hold failed timing while allocation passed; this is a different metric and no identical-cause or machine-noise attribution is established. Neither the current failure nor the broader inherited performance hold is cleared. One uninstrumented run followed each concrete allocation repair; no baseline rewrite or blind retry was used.

```sh
FOG_PERF_UPDATE=0 pnpm exec vitest run tests/sim/perf-budget.test.ts --maxWorkers=1
```

## Final local evidence

- **Rendered combat/ad close — passed at 67c.** One node-WebGL SwiftShader browser, 960×600 CSS / actual 480×300 buffer at pixel ratio 0.5, reproduced every input/hash through `12a94c7b`. Actual visible bot, attack popup, blue water, warm oxidation, seizure and collapsed heap were captured and manually inspected. Normal held chase-camera orbits avoided real UI/avatar occlusion without changing simulation hashes. The selected advert `agent:538:3` queued the real close-ad command at tick4363/sequence2; one neutral normal frame emitted `ad-blast:closed` and popup -1, left zero cards, hash `8925f6e1`. No graphics/page/network errors or forced state/look calls. This is reduced-load selected-milestone mechanics QA, not continuous animation timing, startup or FPS acceptance.
- **Graphics recovery — passed.** A small dev-world software probe restored the legacy context with paused hash `841ac9e9` unchanged. An actual node-WebGL context loss/restoration saved progression and reloaded once into legacy with safe-mode flag1; the wallet (cash, runway, reputation, paid IDs, owned items/sites, command sequence) matched exactly. The intentional reset warning was recorded; no unexpected errors. The first attempt reached legacy restore but timed out at a30-second node startup allowance; the bounded90-second startup retry passed. This does not test a physical Metal device reset or same-backend node context restoration.
- **H taxi — passed on native Metal at 67c.** Ordinary F/walk/hail/board reached existing ambient taxi73. Actual trusted H events enabled manual mode; actual W accelerated above4 m/s, and60 ordinary steering frames turned/moved that same taxi. A second H retained manual control; actual F exited safely. Taxi identity/ride poses agreed, own parked-car x/y/z/heading stayed unchanged, contacts0, and errors were empty. Actual app renderer was node-WebGL on ANGLE Metal / Apple M4, with no software or legacy fallback. The optional phone-map waypoint portion was explicitly omitted from this H-focused regression. Earlier SwiftShader attempts stalled at a short H observation and then during approach/rendering; they remain failed artifacts, not functional passes. The final run used normal completed frames, canvas focus and real UI dismissal when needed; no blocked-input or simulated-state override.
- **Final full units — complete with the allocation hold.** At clean 67c, `pnpm exec vitest run --maxWorkers=2` completed all252 files /3997 tests:251 files and3995 tests passed, one test skipped, and the allocation guard failed as recorded above. No CI ran and no thresholds were rewritten. This is not a `pnpm verify` or complete browser-suite pass.
- **Packed build/loading — passed from clean 67c.** `node scripts/build-web.ts --out test-results/local-preview-67c422ab --no-sourcemap` produced190 files /176,742,149 bytes, within450/240MB limits, with no source maps. All187 runtime asset/index files matched accepted867 byte-for-byte. The complete Slop MIT notice is present. Preflight HTTP matched the local index. Actual packed native Apple WebGPU boot showed SIM17, packed assets/collider pack, two4096×2048-atlas cascades and completed SSR/bloom; golden/night views and graphics logs were clean. Packed legacy boot also reached ready with zero failed tiles and no graphics errors. Native captures are paused style/loading probes, not a gameplay/FPS soak. Artifact index SHA256:`1f451a83405cb55e1d09024247a63bd84a979e6da0abaf5c07d29ac629f83528`; asset-index SHA256:`560fabad335940f1cc4020505d0f8c33f64546142eb9057089fc61302737a33e`. The QA-only commit after this build does not change compiled source/runtime assets; canonical service selection uses guarded ownership and exact HTTP content checks. Build completion is distinct from production verification.
- **Durable local combat evidence.** Raw reports, replay, recorder comparison, scoped README and13 images are retained under the task’s `fog-city-slop-refactor/combat-final-67c422` artifact directory. These local artifacts supplement the source/fingerprint, measured values, commands and raw failed criteria recorded here; they are not published game assets.

The committed [evidence index](https://github.com/BroderickHigby/fog-city/blob/codex/slop-city-render/docs/qa/evidence/README.md) includes replay inputs, compact raw results and representative images. The task retains full local reports and failed attempts. Production verification is a separate outcome after merge/deploy; no CI or complete browser-suite/physical-device-reset/full-city-soak acceptance is claimed.
