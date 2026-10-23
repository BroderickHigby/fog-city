# Campaign and high-detail integration — 2026-10-23

This is an integration candidate on `feature/campaign-hd`, not a release certification. The inherited world gate is a release blocker; see [the prior review](pr-merge-review.md). No world thresholds or generated terrain were changed to hide it.

## Lane audit

Remote heads were fetched and rechecked on 2026-10-23. The candidate includes the earlier PR 1/2/3/5 integration plus:

| Lane | Reviewed remote head | Result |
| --- | --- | --- |
| Ferry showcase | `bd9032d8c2f1d72c441509910959016fcbf7a9c5` | Latest landmark/house-kit assets merged; raised curbs, HD bodies and dodges retained. |
| Core/combat | `ee21b4d1162a8ad7a0d95768c00f0ff84fce0613` | Merged typed actions, extensions, combat and system registration; retained versions 3–5 migrations and terrain/dodge behavior under version 6. |
| Content | `5b40bb5d3a0d278ce6f51c378935b9f17b168e75` | Merged catalog and schema coverage without dropping house/landmark validation. |
| Agent policies | `7767d57620fb7ededf9999eed2f87de7ad7848e3` | Merged deterministic policies; campaign robots consume perception/brain decisions. Other policies remain unregistered. |
| Pipeline gameplay metadata | `1f41c22e2f4cbf11fa45005f4b586e03ef5cbf91` | Merged refill/anchor metadata, preserving storefronts and current terrain. |
| Modes/online | `fdcf693b9b1bd269fcc636ff241e9210c2aac8e6` | Documentation-only continuation. Existing private relay retained. Public modes and campaign co-op are not implemented. |
| Player and UI/audio/save | No delivered lane branches | This candidate adds campaign UI, controls, radio and mission rendering. Vendors, garage progression, persistent campaign saves and the full planned player lane remain unfinished. |

Main remained `2d132ab0f0da1d2bd1bb46beaa10174b608c548e`. No main merge was performed. GitHub API review/CI metadata remains unavailable in this environment.

## Playable changes

Ten sequential campaign entries now execute through a deterministic reducer: start, location triggers, travel timers, actor staging, continuous watching, scanning, water rust, cone objectives, dialogue/form choices, retries, rewards and unlocks. The eight newly authored later missions are first playable encounters, not the full cinematic/boss implementations proposed in the design document. Private multiplayer remains free roam; the UI prevents starting the solo campaign while connected.

Robots render from the existing model assets, respond through the agent brain and show rust/collapse state. Projectiles and destination markers render in the world. The road-derived minimap marks objectives. `F` enters/exits, held `E` sprays, `Q` scans, held `R` watches, `G` throws a cone and held `T` refills. The ordinary view hides the debug statistics; `?debug=1` restores them.

High graphics replaces instanced cone/diamond trees with branched, leaf-card bay-laurel/cypress silhouettes, retaining cheap geometry in the default tier. Crosswalk paint uses a crisper coverage cutoff. Existing licensed Poly Haven PBR scans, shadows, ambient occlusion, water reflections and three lighting presets remain integrated. This is a visual improvement, not a claim of AAA equivalence or hardware performance certification.

`Neon Tide` is an original 124 BPM stereo procedural electro-funk loop, released under CC0 with its source and credits. Radio starts from a player gesture, supports mute and ducks during narration. ElevenLabs generation is build-time only (`node scripts/build-voices.ts`); keys never enter the browser or repository. The authorized environment/local-file sources contained no key, so no ElevenLabs call was made. The shipped registry is empty and narration uses the browser's installed speech voices when available.

## Adversarial fixes and evidence

- Watching resets when released and requires range, facing and an unobstructed building line of sight.
- Duplicate/out-of-order command sequences cannot replace an active mission or mint cash; campaign order is enforced.
- Retry staging creates fresh actor IDs instead of inheriting a previously defeated actor's combat state. Retry cooldowns are honored.
- Waypoints use destination terrain height. Actor placement avoids water and occupied building footprints where a valid nearby point exists.
- Keyboard focus releases held controls. Radio/mission button clicks return focus to play.
- Recorded physics goldens retain the v5 behavior while validating v6 save migration separately.

`tests/sim/missions/playthrough.test.ts` completes all ten missions through recorded watch/scan/fire/cone/refill controls and verifies reward idempotency. Its harness relocates the player between destinations and refill stations; it proves objective/runtime integration, not driveability of every real-world route. Separate focused checks cover purity, schema/actor references, facing, sequence replay, retries and vegetation bounds.

Production build and typecheck passed before the final verification run. The packed build contains 178 files, 182.0 MB, below the configured 450-file/240 MB limits. Final regression and browser results are recorded below when complete.

## Remaining release work

The existing missing ballpark, road/terrain continuity and building-ledger failures require valid source data/pipeline regeneration. DataSF/elevation requests and pinned cross-browser downloads were blocked by environment network policy in the earlier review. The full nightly/world tour, real-GPU profiling, independent visual review, campaign persistence and later mission depth remain outstanding. No live site publication or main merge should be inferred from the build artifact.

## Final verification record

The full regression run completed in 409 s: **3,414 passed, 97 failed, 1 skipped across 165 files**. Five failures were intake issues: schema routing for `gameplay.json` in two suites, the stale committed gameplay index in two tests, and the missing documentation entry for the high-graphics browser spec. These were repaired without disabling assertions. The resulting focused rerun passed **713 tests in four files**. The index now matches 581 committed tiles, 5,292 refill points and 800 anchors; `build-gameplay.ts --check` confirms byte identity. Only gameplay metadata was regenerated, not world geometry.

The remaining full-run failures are the already documented world/content gate, including the absent ballpark. The latest PR #5 head `1f752fe2730d9bbc444bcba4969a76dec6c53e36` was then fetched directly from its PR ref and merged. Its baseline edit changes a measurement description, not a threshold. Its stronger network recovery regression is included in the final focused run. This report does not relabel the full suite as green.

The real-SF placement probe passed all **18 staged actors**, and its check is retained in `tests/sim/missions/sites.test.ts`. The first 1920×1080 packed-build render passed: six PBR sets, both HD character assets, shadows, post-processing, reflections, all lighting presets, no failed tile loads and no browser/HTTP errors. Radio loading succeeded. The close material-detail screenshot is in [the capture directory](../shots/campaign-hd/README.md). Camera location is explicitly recorded; it is not claimed to match the owner's old screenshot.

The multiplayer browser pass caught an ambiguous `canvas` selector after adding the minimap. The game canvas now has a unique ID and label; the test clicks that specific view. A control regression checks that clicking the minimap cannot fire the blaster. Final browser/network results follow below.

### Reproduce the candidate

Use the pinned pnpm version from `package.json`, install with `pnpm install --frozen-lockfile`, then run `pnpm build` and `pnpm preview`. Open `/?world=sf&gfx=high&tod=golden`. Start Hot Desk from the mission panel. `pnpm exec vitest run tests/sim/missions tests/render/vegetation.test.ts` runs the campaign and canopy checks; `pnpm exec playwright test --config tests/e2e/net.config.ts` runs the private-room browser flow when the pinned browsers are installed. This environment uses an external config selecting system Chromium because the pinned download is blocked.

Final results on the frozen source (`8e8032c`):

- Typecheck and production rebuild passed again: 178 files, 182.0 MB, within the host limits.
- Campaign, real-SF sites, network recovery and vegetation focused run: **13 tests / five files passed**. Every campaign mission completed in the recorded-control harness.
- Canopy distribution regression and geometry checks: **three tests passed**. Visual inspection of the first full-resolution capture found clustered leaves; the deterministic visual hash was corrected and the final capture shows complete canopies.
- Keyboard ownership checks: **two tests passed**, including map clicks versus game-view firing.
- Final packed-build browser smoke passed at **1920×1080 / pixel ratio 1**, all three lighting presets, actual HD assets, zero console/HTTP errors, and radio loading. See [the final plaza capture](../shots/campaign-hd/ferry-golden-1920.png).
- Final private-room browser test passed: create/join, two players, remote movement, leave and rejoin. The intermediate recheck was interrupted after a source reload invalidated its open lobby; the final run used frozen source and passed.
- All four current PR heads were rechecked as ancestors of the candidate; main was not changed.

The full suite and release gate remain **red**. No live publication, GPU frame-rate claim, full-world nightly certification, ElevenLabs recording, or complete GTA-level asset-quality claim is made.
