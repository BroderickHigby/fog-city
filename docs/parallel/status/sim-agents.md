# Lane 3 — Sim-Agents

## Current work

Active branch: `lane/sim-agents/completion`, in `/workspace/fog-city-lane3`. The original `/workspace/fog-city` prototype is preserved.

The earlier policy implementation remains on `lane/sim-agents/wave2` at `083f685`. This branch incorporates the published wave-2 interface and the `feature/dodge` ground/clearance work, then connects the agent policies to the live game. Validation and performance work are in progress. This is not a declaration that the complete game or all lane acceptance gates pass.

**Shared contract change: SIM_VERSION 7.** This combines the published v6 gameplay inputs with the v3 ground/v4 dodge fields. Migration preserves v6 mechanics and unknown extensions. Legacy v4 motion hashes are retained, alongside v7 hashes; the original recorded v2 input log has an explicit v7 replay fixture. Shared integration and rendering changes are included on this isolated review branch because the live runtime needs them. Nothing is merged into `main` or an integration branch.

## Implemented runtime

- Serialized opt-in activation; main starts the combined runtime. Population/fidelity, sidewalk motion, robot decisions, combat, effect application and the final mixed-body clearance run in a defined order.
- People, pigeons, leashed dogs, bad/good robots, physically routed vans/buses, drones, rogue taxis, Patrol units, swarms, theft, Tidy, sign-spinners and associates have runtime adapters. Recruit boarding/taxis preserve separate physical identities and truthful arrival/restoration acknowledgements.
- Calendar routines and Conference Week density, player robot-body control, and named finale weak points/footfall gates use recorded simulation state. Authored finale commands are validated; threat-5 Walker fallback derives a physically checked patrol from the world.
- Added pre-movement and join/exit checks for runtime vehicles and animals, not just a post-step correction. Carried riders have no independent collision body. Final landing receipts are recorded after clearance.
- Existing authored GLBs are reused for supported runtime types. Controlled robot players, finale joints, carried heaps, dog leashes, lanyards and native-resolution bus wraps have render adapters. Advanced procedural models still need final art review; there is no blanket claim that all assets are HD.
- Optional gameplay world metadata now survives loose/packed loading and reaches Node/browser world construction. Missing owned safehouse data remains an explicit pending restoration dependency; no purchased property is invented.

## Validation and hardening checkpoint (2026-10-23)

Commands are serialized with `/tmp/fog.lock` and `NODE_OPTIONS=--max-old-space-size=8192`. Unit tests use two workers, browser tests one. Local HTTP checks require loopback access.

- Typecheck passed. Complete unit/integration suite: **128 files passed; 3,183 tests passed, one skipped**, 105.96 seconds. This includes world/collision/fuzz, asset contracts, runtime continuity, services, combat and renderer tests.
- Native **1920 × 1080** runtime contact sheet rendered all 20 runtime kinds in Chromium without browser errors. The five expected authored kinds loaded from their GLBs. Shared shader joints retain geometry and animate independently. The contact sheet is a review artifact, not final art approval. Reproduce with `pnpm exec playwright test --config tests/e2e/runtime-art.config.ts`: `test-results/hd-art-review/runtime-gallery-1080p.png` and `runtime-gallery.json`.
- Complete Chromium rerun: **35/35 passed**, including all SF world/streaming/input/clearance checks, 1,800-tick integrated Node/browser parity, and ordinary/split packed-build paths. The prior 46-call failure is fixed by shared shader joints; the live scene passes the 40-call actor budget. Geometry and independent animations are retained.
- Integrated service soak: 1,500 measured + 60 warm-up ticks, exact full-state replay match, zero recorded contacts and zero independently checked final-body overlaps. A van physically delivered two units on time; all three observed buses moved. Two later van requests were rejected, rather than faking arrival.
- Integrated driving soak: 1,200 measured + 60 warm-up ticks, exact full-state replay match, zero recorded contacts/overlaps and no counter resets. Discrete footprint checks complement the existing swept-clearance tests; they are not a proof against unrecorded between-frame motion.

The latest 180-tick real-SF performance sample remains **failing**. The documented p95 target is 0.7 ms; the JSON target is 1,500,000 bytes. Do not relax these targets to call this complete.

| Active player anchors | Median step ms | p95 step ms | Peak JSON bytes |
| --- | ---: | ---: | ---: |
| 1 | 3.212 | 9.348 | 115,245 |
| 4 | 8.991 | 21.865 | 349,155 |
| 24 | 69.077 | 86.002 | 1,518,798 |

The corresponding earlier 24-anchor p95 was 506.563 ms and peak JSON was 1,974,353 bytes. Profiles exposed unused citywide recruit sight checks and repeated world-wide spawn scans. Exact spatial queries now preserve candidate ordering, and default combat records/duplicated actor poses are omitted with tested reconstruction. Further performance work is pending.

Additional correctness fixes include good-robot reactions respecting movement limits; Patrol using actual sensory memory and cancelling Terms on disable/restore; physical rogue-taxi arrival; independent robot-body emote/tell presentation; and overlapping population caps rechecked after final clearance. The asset audit is in [sim-agents-assets.md](sim-agents-assets.md).

## Current integration pass (QA complete)

The working tree now connects per-player conversion scopes (including protected SF districts), authored robot goals and seven implemented tells, travel to real repair kiosks, associate sensory memory, two-second blocked-movement recovery, owned-safehouse/reputation adapters and source Muni routes. Muni service follows a bounded local segment and a legal road return; it is not a reproduction of every complete Muni line. Unsupported catalog goals/tells remain explicitly pending. A repair arrival does not itself invent healing or a restoration acknowledgement.

Recorded combat microclimate spheres now occlude visual observations, including robot/recruit sightings, without changing sound or remembered positions. This is a consumer of actual recorded gadgets; weather and gadget activation are still separate dependencies. Large external sight rays use a bounded collider scan instead of enumerating empty world cells.

The new 100 m square/epoch population path uses a serialized `ambientMode: "squares-v1"` marker. The live entry point, benchmark and integrated browser replay select that path. Active squares keep their entry bucket across reloads and time-bucket changes; after leaving every radius, they use the current bucket on re-entry. Compact provenance drives appearance, child/adult classification, firmware, catalog, speed, RNG and route choices. Numeric IDs survive while live or significant; a disposed ambient actor gets a new monotonic ID on regeneration, so obsolete combat records cannot reattach. Existing sessions keep their previous population rules. Initial legacy residents are retained until naturally disposed; subsequent births use the square source.

Wet/rust/scan/recruit evidence is promoted before pruning. New ambient residents reserve promotion capacity within the shared 2,000-agent limit. Taxi, routine and finale births respect those slots and pending van deliveries. Capacity-denied requests remain pending without false acknowledgements. Parked cars remain spawn obstacles even when their owners are on foot. Already over-budget imported snapshots retain explicit capacity diagnostics; the reserve guarantee is for normally admitted populations.

Metadata compaction reconstructs descriptions from their existing owners while retaining tick-local observations. Transforming the captured 24-anchor state reduced JSON from 1,643,210 to 1,410,970 bytes with exact metadata equality. The final fresh-runtime sample, including square provenance and the service fixes, passes the 1.5 MB snapshot limit at all three tested scales. CPU performance remains failing:

| Active player anchors | Median step ms | p95 step ms | Peak JSON bytes |
| --- | ---: | ---: | ---: |
| 1 | 3.078 | 4.947 | 113,370 |
| 4 | 9.376 | 11.882 | 336,073 |
| 24 | 58.541 | 67.625 | 1,397,264 |

These are 180 measured + 10 warm-up ticks on real SF, seed 7. Complete final state replay matches at each scale, with zero final body overlaps, contacts or counter resets. The 0.7 ms four-anchor target is still unmet; this is not a production performance sign-off.

The extended idle service run found a real queue behind a parked car and airborne birds incorrectly blocking road traffic. Dispatch now considers checked parallel lanes before spawning, ground traffic tests actual height bands, and return routing preserves the chosen lane's position. The final 1,500 + 60 warm-up tick run delivers two units in **16.72 seconds** against the unchanged 20-second deadline, with three physical buses, exact replay and zero overlaps/contacts. Occupied routes may still legitimately miss a deadline; no arrival is fabricated.

The runtime art pass replaces placeholder Patrol/Tidy/drone/finale geometry, reuses additional authored robot/heap models, and retains shared materials and joints. Its updated native-1080p contact sheet passes, as do 26 focused art tests. The final Chromium run also passes the live-scene rendering budgets.

Final unit validation: **150 files passed; 3,351 tests passed, one skipped**, 110.79 seconds. The skipped case is the opt-in `UPDATE_BANNED_PAIRS` content-regeneration command, not a missing gameplay check. Final typecheck passed. The earlier head-light assertion was corrected to check the independently turning authored head; status-light geometry was retained.

Final Chromium validation: **35/35 passed**, 4.7 minutes, including 1,800-tick integrated Node/browser parity, real-SF driving/clearance and ordinary/split packed builds served from a sub-path. The report-only software FPS probe was excluded; this is not a hardware frame-rate claim. Firefox/WebKit remain blocked as described below.

The final driving soak ran **1,800 measured + 60 warm-up ticks**, matched complete replay state, delivered two units on time, observed four moving buses, and recorded zero contacts, overlaps or counter resets. The durable machine-readable results, including failed CPU budgets and pending production gates, are in [sim-agents.json](../results/sim-agents.json). Raw run logs are retained locally in `test-results/quality/lane3/`.

## External and cross-lane dependencies

- Firefox/WebKit binaries could not be downloaded under the current network policy. Their earlier installation returned HTTP 403 from the Playwright download hosts. Chromium is available. No cross-engine pass is claimed until all requested engines run.
- GitHub API access previously returned Forbidden, preventing draft PR creation. Git transport works. The saved environment draft adds the API/browser hosts but must be published before the running environment receives them.
- Player/economy/mission owners must supply authoritative threat/VC inputs, purchased safehouses and mission/finale commands. Lane-3 adapters do not substitute fabricated progression.
- Full art sign-off, real-device graphics performance, multiplayer hosting and the remaining other-lane roadmap work are separate acceptance work.

## Completion rule

Report the actual typecheck, unit, browser, real-world clearance, delivery and performance results after they finish. Keep failing gates and unavailable checks visible. Push the review branch and attach a PR if API access permits; do not merge protected branches.
