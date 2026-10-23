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

## Validation in progress

Commands are serialized with `/tmp/fog.lock` and `NODE_OPTIONS=--max-old-space-size=8192`. Unit tests use two workers, browser tests one. Local HTTP checks require the execution environment to allow loopback sockets.

Initial full integration run: 3,038 tests passed; failures included old v4 schema assertions, new in-progress fixtures, omitted gameplay-layer loading, and sandbox `listen EPERM` failures. Those findings are being fixed and rerun. Earlier focused runtime run: 402 passed, 2 failed; both failures were assigned fixes before the final rerun. These are intermediate results, not a green final gate.

The first completed real-SF stress sample measured p95 step times of 9.668 ms / 25.414 ms / 901.349 ms for 1 / 4 / 24 anchors. Peak JSON at 24 anchors was 1,903,807 bytes. These fail the documented performance targets. A CPU profile identified repeated route searches, spawn retries and geometry checks; follow-up optimizations and measurement are in progress. The short sample also prompted service activation/route fixes. A rejected infeasible van journey is not reported as a delivery.

## External and cross-lane dependencies

- Firefox/WebKit binaries could not be downloaded under the current network policy. Their earlier installation returned HTTP 403 from the Playwright download hosts. Chromium is available. No cross-engine pass is claimed until all requested engines run.
- GitHub API access previously returned Forbidden, preventing draft PR creation. Git transport works. The saved environment draft adds the API/browser hosts but must be published before the running environment receives them.
- Player/economy/mission owners must supply authoritative threat/VC inputs, purchased safehouses and mission/finale commands. Lane-3 adapters do not substitute fabricated progression.
- Full art sign-off, real-device graphics performance, multiplayer hosting and the remaining other-lane roadmap work are separate acceptance work.

## Completion rule

Report the actual typecheck, unit, browser, real-world clearance, delivery and performance results after they finish. Keep failing gates and unavailable checks visible. Push the review branch and attach a PR if API access permits; do not merge protected branches.
