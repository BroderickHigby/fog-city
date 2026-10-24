# Reviewed release integration — 23 October 2026

This candidate combines the requested player controls, audio, visual changes, unlimited water,
street detail, traffic detours and multiplayer code. It is a release candidate until the final
combined checks pass and the production build is verified. Source inclusion, tests, a Git merge,
deployment readiness and public availability are separate outcomes.

The original starting point was the deployed Batch 1 source,
[`86dfb90`](https://github.com/BroderickHigby/fog-city/commit/86dfb9005c4f76d49ef28c79d4aa8c5bf5bd3846).
The candidate also preserves the subsequent public release base,
[`aae1f46`](https://github.com/BroderickHigby/fog-city/commit/aae1f46591ee04381fc1fe1e4751fb0cacd5d8c2),
including the [PR #63 credits](https://github.com/BroderickHigby/fog-city/pull/63) and
[PR #66 graphics recovery](https://github.com/BroderickHigby/fog-city/pull/66).
The integration preserves the existing physical city and its held-world exclusions.

## Included source

| Change | Source and exact reviewed head |
| --- | --- |
| Sprint and faster walking | [PR #40](https://github.com/BroderickHigby/fog-city/pull/40), [`b6060f5`](https://github.com/BroderickHigby/fog-city/commit/b6060f52f57ee4b3cef298be54ce4a631f60643c) |
| Drag camera orbit and hill clipping | [PR #48](https://github.com/BroderickHigby/fog-city/pull/48), [`93eb3d7`](https://github.com/BroderickHigby/fog-city/commit/93eb3d7152dce77987c88b8056b024cf0a61d487) |
| Hail, board and ride a robotaxi | [PR #58](https://github.com/BroderickHigby/fog-city/pull/58), [`c3c47e7`](https://github.com/BroderickHigby/fog-city/commit/c3c47e7e6fc0a4282cd9288695c28afcd813c739) |
| Car radio and one horn mixer path | [PR #36](https://github.com/BroderickHigby/fog-city/pull/36), [`9f81a52`](https://github.com/BroderickHigby/fog-city/commit/9f81a52d393feebabb24e2c7ac87aa2a95567608) |
| Player inner-voice subtitles and music continuity | [PR #37](https://github.com/BroderickHigby/fog-city/pull/37), [`1465f67`](https://github.com/BroderickHigby/fog-city/commit/1465f6727012f2f18b994e4d3416a2b799b62558) |
| Player avatar presentation | [PR #34](https://github.com/BroderickHigby/fog-city/pull/34), [`ac95ad9`](https://github.com/BroderickHigby/fog-city/commit/ac95ad95a6cab2dc7545ce3799a238ea7286a7d2), plus the upstream campaign-dialog wait repair [`33da7c9`](https://github.com/BroderickHigby/fog-city/commit/33da7c9b5bd292d84c6eccb7b9525b20753ae44e) |
| Foliage crowns | [PR #43](https://github.com/BroderickHigby/fog-city/pull/43), [`8327367`](https://github.com/BroderickHigby/fog-city/commit/8327367045eb0d16deacc3dda1e0cdffbd206a86) |
| Night lighting | [PR #46](https://github.com/BroderickHigby/fog-city/pull/46), [`27975a2`](https://github.com/BroderickHigby/fog-city/commit/27975a260d1613b23d93cce2b6e4d3c94df10b87) |
| Nearby skinned pedestrians | [PR #47](https://github.com/BroderickHigby/fog-city/pull/47), [`aa66a2a`](https://github.com/BroderickHigby/fog-city/commit/aa66a2ac28f017af1ae63dcf1e14d10a74f41be5) |
| Water-blaster prop | [PR #49](https://github.com/BroderickHigby/fog-city/pull/49), [`def368d`](https://github.com/BroderickHigby/fog-city/commit/def368d63f01e14a59021f3c32de68f8df8de7e4) |
| Unlimited water | [PR #44](https://github.com/BroderickHigby/fog-city/pull/44), [`2ed542d`](https://github.com/BroderickHigby/fog-city/commit/2ed542d6317acac44c41c6f3d8a89920f32a051c), behavior integrated at version 13 |
| Robotaxi/walker traffic detours | [PR #38](https://github.com/BroderickHigby/fog-city/pull/38), [`30ba1cd`](https://github.com/BroderickHigby/fog-city/commit/30ba1cd637a640d8b3356c34570e18903aa1fd60), plus reviewed stationary-body and junction repairs; behavior integrated at version 13 |
| Crosswalks and stop bars | [PR #41](https://github.com/BroderickHigby/fog-city/pull/41), [`e35daf3`](https://github.com/BroderickHigby/fog-city/commit/e35daf312bf963ed2c1d2a0194c1d2aca114caeb) |
| Signals and stop signs | [PR #52](https://github.com/BroderickHigby/fog-city/pull/52), [`938331c`](https://github.com/BroderickHigby/fog-city/commit/938331c78a4ab0f274eb5a3d98909a68af5df73e) |
| Street-name and kerbside signs | [PR #53](https://github.com/BroderickHigby/fog-city/pull/53), [`966fc66`](https://github.com/BroderickHigby/fog-city/commit/966fc66daed33f3991f553a74254bdb77174a589) |
| Real SF street-tree placement | Tree-only adaptation of [PR #55](https://github.com/BroderickHigby/fog-city/pull/55), [`a7147eb`](https://github.com/BroderickHigby/fog-city/commit/a7147eb06b48cac7cc81676c0783eec34be29f75); its OSM/landcover ancestors are excluded |
| Relay, lobby and online Bot Sweep | [PR #32](https://github.com/BroderickHigby/fog-city/pull/32), [`c38cc23`](https://github.com/BroderickHigby/fog-city/commit/c38cc23c5a803455d61f4c60c74815234c77cf9f) |
| Quick play, public rooms and bots | [PR #45](https://github.com/BroderickHigby/fog-city/pull/45), [`79b659a`](https://github.com/BroderickHigby/fog-city/commit/79b659ac7bb92ab4eaf121eb4960686d2adc60f6) |
| Clean Streets online mode | [PR #51](https://github.com/BroderickHigby/fog-city/pull/51), [`aa157c8`](https://github.com/BroderickHigby/fog-city/commit/aa157c82d20e63c061bb834b546d50acfb102c0c) |
| Credits preserved from the release base | [PR #63](https://github.com/BroderickHigby/fog-city/pull/63), [`08b53bb`](https://github.com/BroderickHigby/fog-city/commit/08b53bb49c9729a9b5e49a1fa481ec06de7e482c) |
| GPU tiers and context recovery preserved from the release base | [PR #66](https://github.com/BroderickHigby/fog-city/pull/66), [`90efd18`](https://github.com/BroderickHigby/fog-city/commit/90efd18574db87026234f6d04c8e5f2b9107caa5) |
| Bounded city catch-up and authoritative debug pause | [PR #72](https://github.com/BroderickHigby/fog-city/pull/72), [`00e1f30`](https://github.com/BroderickHigby/fog-city/commit/00e1f300679bc3e04ad6232fcd52d50501291bac) |

The street index contains only markings, furniture, signs and DataSF street trees. The tree-only
adaptation preserves the original tree producer, renderer, committed data and tests without
importing landcover, OSM data or OSM schema/index entries.

## Integration repairs and contract

- The camera follows an occupied taxi while retaining the hill-clipping fix; it does not inherit
  the parked own car's pitch. Both controls lists survive the content merge, with a recomputed
  content hash. The camera branch's accidentally tracked machine-local `node_modules` symlink
  is removed.
- A vanished taxi requests a safe exit at the last known ride pose. Taxi goal routing uses
  deterministic shortest paths through legal drivable directions to the nearest reachable road
  projection, with bounded derived-data caching. Ambient random routing keeps its existing path.
- Occupied robotaxis cannot begin or complete forced updates. Boarding during the windup cancels
  it; an empty taxi remains eligible after its rider leaves.
- Online matches retain the display and simulation timeline while the free-fly camera is active;
  camera movement sends neutral match controls and never advances or autosaves the free-roam
  city. The renderer uses the actual local seat, so first-person play as player two hides that
  player's body. The blaster, nozzle and audio hooks follow the displayed city or match state.
- Clean Streets applies distraction after bot input planning, so flowers suppress a bot's spray
  as they suppress a human's. Starting Clean Streets with one human guarantees at least one
  bot on the opposing team, while other modes and larger groups keep their selected bot count.
- The city frame pacer limits whole fixed ticks per rendered frame and discards excess wall-clock
  backlog. It never controls relay-ordered multiplayer ticks. Debug pause remains authoritative
  when a modal closes or queues a command. The graphics governor discounts only the simulation
  section and ignores frames catching up multiple city or confirmed online ticks; avatar,
  combat, audio and other render preparation remain part of its measured workload.
- Context recovery preserves the free-roam city save even while an online match owns the screen.
  A recovered GPU rebuilds the render environment; repeated loss reloads in the released safe
  graphics mode. Credits and the existing GPU tier selection remain available.
- Crowd admission measures actual loaded primitive/material costs, includes procedural overflow
  and retains the existing ambient draw budget. Spatial audio follows the occupied ride body;
  taxi chirp cooldowns survive brief changes between waiting and moving.
- The release uses **SIM_VERSION 13**. The chain is 10 to 11 (sprint), 11 to 12 (rides), then
  12 to 13 (the combined unlimited-water and traffic behaviors). All fields are preserved by
  these upgrades; traffic pass/detour fields are optional. Version 9 remains reserved for the
  held structural world. Historical fixtures remain separate and unchanged.
- The final version-13 composed golden is recorded from the complete combined simulation,
  including the audio/render and stationary-body traffic patches. This candidate does not reuse
  an earlier feature branch's version stamp or replace old fixtures to conceal a changed replay.

## Exclusions and public-online limit

[OSM/landcover PR #54](https://github.com/BroderickHigby/fog-city/pull/54) remains excluded:
its first OSM data use needs an owner decision and visible attribution. The stacked
[storefront PR #56](https://github.com/BroderickHigby/fog-city/pull/56) is also outside this
release. No OSM/landcover files are copied in the tree-only adaptation.

The failed structural-world candidate
[PR #30](https://github.com/BroderickHigby/fog-city/pull/30), historical world integration
[PR #1](https://github.com/BroderickHigby/fog-city/pull/1), and held Ferry showcase
[PR #3](https://github.com/BroderickHigby/fog-city/pull/3) are not reintroduced. This release
does not certify their physical-world gates or new generated geometry.

Multiplayer code and loopback relay tests do not establish public online service. A hosted relay,
its allowed origins, a successful health check and a static build configured with `RELAY_URL`
must be verified separately. Without that build setting the existing client boots single-player
and hides the online lobby; see [the relay deployment instructions](https://github.com/BroderickHigby/fog-city/blob/c38cc23c5a803455d61f4c60c74815234c77cf9f/server/README.md).
No hosted relay was provisioned or verified by this integration.

Inner voice remains subtitles until the held voice licensing/provider decision is resolved.
Software-renderer browser tests do not certify native-GPU frame rate or visual quality.

## Validation state

The isolated controls repair passed typecheck and 250 focused tests in 12 files on Node 22.22.2,
pnpm 9.12.0, one Vitest worker. Its existing ride journey passed within the unchanged 20-second
limit. The exact graph that exposed greedy routing is retained as a direct route-choice check;
a smaller single-taxi composed fixture proves a necessary detour and actual arrival. The
original large-graph full-traffic arrival encountered a dynamic blockage and is not certified
by that focused proof.

The streets/multiplayer/traffic candidate separately passed its focused suites and Node-22
typecheck. After combining those sources with the controls repairs, the intermediate source
passed another frozen-lockfile install and Node-22 typecheck. These separate results are not
a substitute for the final combined gate.

The combined audio/render/street/control source passed Node-22 typecheck and 96 focused tests
in 11 files. The subsequent multiplayer review repairs passed typecheck; both new regressions
failed before the fixes and passed afterward. Their complete two-file local run reported 29
passes and three timeouts in unchanged 20-second Clean Streets cases under host load. No
timeouts or assertions were relaxed. The stationary-body traffic branch separately passed its
four new regressions and typecheck; two existing overtake tests exceeded their unchanged
60-second limit, and its real-SF probe was interrupted. These are disclosed limits, not full
suite passes.

The browser suite now exercises real free-fly keys during an online match while checking the
city hash/tick stay frozen and the match progresses. It also checks first-person hiding for a
real second-player seat. These additions await the final browser gate.

The first combined CI passed 3,564 unit tests in 187 files after two mechanical repairs: the
browser-spec documentation index and the asset licensing guard. Its browser run was cancelled
when the public base advanced; the camera spec had passed, while the avatar spec had timed out
and the campaign spec was interrupted. That run does not certify the refreshed candidate.

After preserving the newer release base and adding city frame pacing, Node-22 typecheck and
64 focused tests in seven files passed. The focused files cover frame pacing, graphics tier and
governor policy, context recovery, held blasters, HUD/actors, avatar ground placement and the
browser harness wiring. The upstream campaign-dialog repair restores the documented 60-second
load-proof visibility waits in two places. No simulation assertion or timeout was changed.
CI now stops the browser suite after its first failure so traces can upload promptly; successful
runs still execute the complete suite, and informational screenshots run only after success.

Refreshed final CI, focused avatar/context-loss browser checks and final-head review readback
are pending. The earlier runtime preview predates the graphics/frame-pacing merge and is stale.
The public release base described above is preserved; this candidate's remote integration merge,
release-branch move and production deployment remain unverified.
