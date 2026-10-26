# Fog City continuation handoff

Prepared 23 October 2026, Pacific time. Repository: <https://github.com/BroderickHigby/fog-city>.

This document supersedes the branch/version/status instructions in the older `docs/handoff.md`. Read `docs/design.md` and `docs/roadmap.md` for design intent, but reconcile their historical status claims with this snapshot and actual code. A lane report is evidence of that lane's checkpoint, not proof that its code is integrated or playable.

## 1. Goal and current truth

The goal is a believable, high-definition San Francisco open-world game, with the visual coherence and street-level detail of the owner's Slop New York reference, enjoyable missions, a real human avatar, reliable gameplay, and a hosted playable build.

The current integration is a working gameplay checkpoint, **not a completed visual-parity release**. It still uses the older SF geometry. The newer world and renderer remain isolated because the world has verified regressions. Content on disk is not necessarily a feature in the live game.

**Correction to a recent chat answer:** Slop New York's source was inspected earlier at `039a32796faf6ff914a07946b3d3d058d291e251`, and its grading/material ideas informed shipped rendering changes. Saying it had never been inspected/adapted was inaccurate. Its entire renderer was not ported, and an equivalent visual result has not been demonstrated.

Standing owner preferences to preserve:

- Continue autonomously with routine implementation, QA and fixes; merge validated work and build/publish when possible.
- The owner abandoned the personal-likeness request. Use the licensed generic human avatar. Historical likeness instructions in `CLAUDE.md` and older handoffs are superseded by this decision.
- Licensed online assets and scanned materials are acceptable. Preserve source/licence/redistribution records; do not copy NYC geography or assume a code licence covers third-party assets.
- People, children, animals, seated people and mobility-aid users must retain the game's no-run-over/no-harm protections. The existing water/robot/flower design remains the gameplay contract.
- Do not disguise a failed world gate by accepting worse baselines, raising limits or calling a software screenshot a hardware performance test.

## 2. Start here: stable checkpoint and evidence

| Item | Exact checkpoint / location |
| --- | --- |
| Last tested gameplay checkpoint | `80a05c40f6ceaac82ebbca8ed8607408f482d612` on `origin/integrate/wave2`; later handoff commits change documentation only |
| Application source tested | `c34e38328cf001b58a7996d907fad8a419fa7bf2` |
| Subsequent test-driver-only repair | `371fd72450ebd8636998e3c2942ac94a3c0ae0a0` |
| Local canonical checkout | `/workspace/fog-city-integration`, clean at handoff |
| Simulation / enabled game wave | `SIM_VERSION = 8`; production `GAME_WAVE = 3` |
| Detailed current QA report | `docs/parallel/status/integration-wave3.md` |
| Tested static ZIP | `test-results/fog-city-integrated-wave3.zip`, 76,219,928 bytes |
| ZIP SHA-256 | `0d026f97bb13bbe7fb96036b73d9853b0770381e9c4575d2b6409a8526f9dc59` |
| Build contents | 126 files; 124,985,247 raw bytes; largest hosted file 12,349,300 bytes |
| Public deployment | No current hosted release was published by this session |

Completed QA: TypeScript; **3,270 unit tests passed**, one existing opt-in skip; **45 Chromium checks passed** across the full run and the corrected campaign/UI rerun. Ten Firefox/WebKit cases were skipped because those engines were absent. The current gameplay index is byte-identical: 583 tiles, 5,205 refills, 807 anchors, 10 territory rows.

The real-control browser campaign completed Hot Desk, the first upgrade purchase and Spill acknowledgement. Its full replay has **15,551 frames / five commands**, tick 1 to 15,552, with expected and actual hash **`2c322366`**, zero protected contacts and zero safety failures. All 1,858 source/data/test/asset files were verified unchanged during each browser run.

An initial campaign failure was a test driver exhausting its recovery budget across an entire long walk. Normal controls could escape the taxi; the corrected driver reached the desk from the exact snapshot. Preserve the fix: reset recovery after measured progress while retaining consecutive-stall and total input limits. Do not restore that obsolete failure by reverting the harness.

**Already integrated; do not rebuild from scratch:** real agents/combat/player registration, core save upgrades, bounded actor retirement, blocked-actor quarantine, physical combat movement limits, actual parking/calendar providers, per-player mission guidance, fresh retry actors, once-only rewards, generic human avatar, detailed street foliage, scanned road/sidewalk materials, current HUD, controls and progression saves.

## 3. Reference implementation and visual work

References:

- Live target: <https://mrdoob.github.io/slop-newyork/>.
- Canonical repository: <https://github.com/mrdoob/slop-newyork>.
- New read-only source audit at this handoff: `12593c9963f141665fe91881b1b4a2290db51d15` in `/tmp/fog-slop-reference-handoff`.
- Existing reuse/provenance: `assets/imports/slop-new-york/README.md` and `LICENSE.md`; implementation report: `docs/parallel/status/render-avatar.md`.

The canonical repository was inspected. If the owner's earlier push refers to a different fork or revision, identify that exact repo before assuming the canonical head is their desired source. The live reference returned a proxy 403, and the earlier local mirror did not draw correctly on the software GPU. There is no verified side-by-side visual or performance comparison yet.

The reference uses Three.js **WebGPURenderer/TSL**: coherent physical sky/environment lighting, cascaded shadows, reflections, filmic grading, procedural facade and interior materials, detailed instanced vegetation, actor geometry/animation, spatial culling and shadow proxies. Relevant modules are `js/main.js`, `lighting.js`, `post-processing.js`, `tsl-materials.js`, `trees.js`, `pedestrians.js`, `actor-models.js` and `scene-culling.js`.

Fog City currently uses **WebGLRenderer + EffectComposer**. Copying one post-processing file or adding large textures will not reproduce the reference. Its code is MIT; geographic data and third-party assets have separate terms. The reference's mutable Three.js `dev` CDN dependency is not a suitable version pin for a stable game build.

### Visual implementation work

1. Establish a repeatable **Ferry/Market vertical slice** before replacing the whole renderer. Capture matching camera coordinates, field of view, weather and time of day at 1920×1080 or higher on actual GPU hardware.
2. Decide and document the rendering approach: adapt selected techniques to the current backend, or add a tested WebGPU path with an intentional fallback. Keep renderer dependencies pinned and simulation independent.
3. Finish coherent materials, lighting and geometry together: readable facades/windows/interiors; building foundations and roof silhouettes; believable trees/palms; lane markings/crosswalks/curbs; sky, fog and water; cars and characters at consistent scale.
4. Review Ferry Building/Embarcadero, Painted Ladies/Alamo, Mission, Sunset/Richmond, downtown, Twin Peaks, bridges and tunnel interiors. Check near/far transitions, shadows, night exposure and material scale at street level.
5. Upgrade remaining simple combat presentation: wetness, splashes, readable rust progression, collapse/heaps, decals and cleanup. Preserve actor height, tell/bag and light-flicker signals already exposed by the runtime.
6. Continue improving the existing Rocketbox human's animation/grounding/clothing as needed. It already replaced the block avatar: this is polish and art direction, not a missing initial avatar import.

**Done when:** matched high-resolution captures meet the reference brief on real hardware; the world correctness gates pass; camera/render changes preserve simulation hashes; measured frame time, memory, draw-call and texture budgets hold. Propose an explicit hardware/resolution/frame-rate target before claiming performance parity. Software Chromium proves behavior, not a 60-fps guarantee.

## 4. Held world: highest-priority correctness work

| Work | Branch / head | Status |
| --- | --- | --- |
| Structural world and regenerated SF | `qa/world-integration` / `4556f8a4573bbab41f8239dea92e6821ceef8a00` | Pushed; not in playable integration |
| Structural-world renderer | `qa/world-render-integration` / `103942048fb889aa28c8f1eb0c51ad31d80ccb84` | Pushed; not production-wired |
| Surface-aware agent patch | `qa/agent-surfaces` / `fb915d6e01c0f1bc24a0e22656f2d700a5a7836a` | Preserved as a remote review branch; not integrated; cherry-pick only this commit |
| Combined visual QA checkout | `/workspace/fog-city-world-render-qa`, detached `cda3be0` | Has temporary `main.ts` edits; not a clean release branch |

World history: `76c1bc0` imports structural data/physics, `17b0159` adds the band-aware line sweep, `d4b9fc2` restores strict historical gates, and `4556f8a` fixes unsupported lake propulsion.

### First restore reproducibility

The original pinned raw SF cache is absent. Full `build-world --offline --check` fails on missing DataSF building-cache input (`ynuv-fyni`). Recover the trusted cache from an earlier build environment or restore source access. Preserve snapshot provenance; do not silently refresh to today's data. Do not hand-edit generated GLBs/packs to conceal defects.

### Fix the actual geometry and motion defects

The initial strict run was **53 passed / 78 failed / seven skipped**. Of 116 numeric metrics, 66 improved, 37 stayed equal and 13 worsened. Some failing tests indicate improved-but-stale baselines, so inspect each result; 78 is not the number of newly introduced defects.

| Priority defect | Evidence / required outcome |
| --- | --- |
| Freeway/bridge profiles | Maximum freeway grade rose 143.22% → 345.06%. Repair disconnected approach/deck geometry, including the unfinished Golden Gate approach; align drawing, collision and driving support. |
| Road/ground disagreement | Worst rendered-road vs simulation surface difference rose 3.84 → 6.6 m. Reconcile Broadway's contradictory tunnel/deck and other surface producers. |
| Broken routes | Stopped closed-loop routes rose 2 → 3, including the Market/Twin Peaks obstruction. Fix the physical source, not a test route that avoids it. |
| Placements and crossings | Placement rise 0.34 → 1.69 m; airborne crossings 66 → 70. Eliminate launches, floating starts and inconsistent supports. |
| Far buildings | Hulls over 3 m wrong rose 44 → 110. Use consistent building bases/heights for near and far representations. |
| Other regressions | Duplicate footprint pairs 23 → 26; buried walker stops 29 → 30; below-surface travel 0.173 → 0.404 m; smaller motion/height regressions are recorded in the world report. |
| Real county boundary | Corrected southern-boundary probe shows **2.1978 m overshoot** against the unchanged **0.02 m** limit. Fix the collision/sweep, keeping the assertion. |
| Lake shores | Lake propulsion is fixed, but visual shorelines remain coarse heightfield-cell quads. Add credible contours without reintroducing water/ground disagreement. |

Preserve the successful Lake Merced fix: **780 → 0 m driven on unsupported water**, passing codec and cross-format replay checks. Do not reintroduce propulsion or relocate a car arbitrarily to a bank.

### Complete height-aware integration

- Apply only the intended `fb915d6` patch after the structural helpers exist. Preserve the current quarantine, lifecycle, combat and per-attempt mission IDs when resolving conflicts.
- `src/sim/motion.ts` still has unbanded walker admission/movement checks in the structural candidate. Use the actor's actual vertical band in both admission and accepted movement; add real deck/bore/stacked-actor tests.
- Audit `clearCarSpot`, save/join/spawn recovery, player enter/exit and mission parking for elevated support. Current `clearCarSpot` uses ground-oriented recovery without a surface-height hint; do not snap a bridge/tunnel/roof save to unrelated terrain.
- Test accepted body positions, not only movement proposals. Include cars, pedestrians, mission actors, buses, service vehicles, projectiles and multiplayer joins.

**Version collision:** the shipped gameplay contract is **8**. The isolated structural candidate also provisionally uses 8. Reserve **SIM_VERSION 9** for the combined structural integration, with a tested **8→9 migration** and new v9 goldens. Retain the older v7/v8 fixtures. If another versioned change lands first, reconcile the chain and use the next unused version rather than reusing a stamp. Never publish incompatible physical behavior under the existing version-eight stamp.

## 5. Finish renderer wiring and its pending checks

Do not merge the old Ferry branch's whole `main.ts`, `step.ts` or shared contracts. Preserve the working version-eight gameplay registry while bringing over reviewed rendering/structural changes.

Required production wiring from `qa/world-render-integration`:

- Import `houseKit` from `virtual:fogcity-assets`, pass it as `RenderOptions.houseKit`.
- Pass `boundary: files.boundary` and `sidewalks: files.sidewalks`.
- Load `tiles/<world>/storefronts.json` with an empty-list fallback and pass its `storefronts`.
- With the structural world, pass `cameraGround: (x, z, nearY) => surfaceAt(world, x, z, nearY, false).y`.
- Preserve the producer's `manifest.rendering.bakedGround` marker. It prevents the old runtime tint/seam logic from modifying already-baked ground twice.

Already tested on that candidate: 467 focused renderer/content/schema/model tests, 20 later foliage/hosted-asset tests, and a four-view software browser rerun. The exposed cone/diamond tree prototypes were fixed by correctly admitting and scaling `foliage-broadleaf` and `foliage-conifer` instances. Keep those fixes.

**Not yet run:** the final height-aware camera tests and the dedicated inside-the-tunnel browser probe. The old Broadway street screenshot was outside the tunnel and is not evidence for tunnel visibility. Run the focused camera tests, then `tests/render/world-integration.config.ts` (use `--grep 'height-aware camera'` for the tunnel probe) on the properly wired combined candidate.

Reports and committed screenshots live on the held branches:

- `docs/parallel/status/world-integration.md`
- `docs/parallel/status/world-render-integration.md`
- `docs/shots/world-integration/README.md`
- Agent patch notes: `docs/parallel/status/agents-surfaces.md` on `qa/agent-surfaces`.

## 6. Missions, weather and activity backlog

1. **Finish real-SF/browser acceptance for Launch Day and Demoed Correctly.** Their composed simulations and real-SF parking checks pass, but the full browser campaign currently proves Hot Desk, purchase and Spill acknowledgement only. Exercise actual routes, scan/watch/melt, legal parking, retries, saves/reloads, two-player identity isolation and reward deduplication in the city.
2. **Finish the deliberately unavailable activities:**

   | Activity | Missing production path |
   | --- | --- |
   | `search-and-park` | Physical/legal stop → `parking.legalStop` and complete activity flow |
   | `office-hours` | Real `demo.robotPresented` outcome forwarded into activity facts |
   | `plain-words` | Physical boards, washing detection and `board.washed` |
   | `coit-recon` | Recon objects/detection and `recon.signalFound` |
   | Legacy `ramen-house` marker | A real supported objective rather than a generic unfinishable start |

   Keep `src/sim/activities/availability.ts` until each feature has its producer, objective/UI, outcome and tests. Existing `embarcadero-sprint` and `hill-delivery` routes remain available.

3. **Integrate real weather.** Current `src/sim/fog/index.ts` always returns zero, even though the page enables wave three. Spatial `fogAt` hooks are ready. `origin/lane/core/wave3` (`1ec428f`) has seeded weather work to review; reconcile it with the current registry/version. Rain traction, shelter and tide geometry need complete producer/consumer coverage.
4. **Bring in later missions one stage at a time.** Authored content is already present for wave-four `demo-day`, `fleet-week`, `hill-climb`; later `marine-layer`, `acqui-hire-offer`, and `comeback-round`. This does not establish playability. Review missing bell-duel/pitch-window/vehicle-ownership/cable-car, teleoperation/delivery/disconnection, giant/fireboat/joint/fleet-restoration producers before enabling them.
5. **Reconcile later economy and equipment work.** Review Doom Clock, faction deliveries, match isolation, equipment bridges and repair attribution from the held player branches. Subscription renewal/cancellation, foil/cargo physics, specialist encounters and the physical apology/escort-to-kiosk path still need work. Preserve accepted-body validation, ownership, persistent payouts and once-only settlement.

## 7. Multiplayer and modes

Current `src/sim/modes/systems.ts` registers an empty list. The shipped tree has no actual relay/server implementation. Multiplayer stepping tests do not establish a live network game.

Existing work to salvage/review instead of rewriting blindly:

| Source branch | Checkpoint / purpose |
| --- | --- |
| `lane/modes-online/wave4` | `fdcf693`: private invitation-room relay, client/replay and isolated modes |
| `lane/core/mode-seam` | `f20d53d`: core/mode isolation seam |
| `lane/mode-arena/wave5` | `5e7447e`: arena work |
| `lane/modes-playable/wave5` | `30ccf98`: usable mode/provider integration |
| `lane/ui-modes/wave4` | `b1628d5`: local mode menus/results; not a complete network lobby |
| `lane/online-integration/wave6` | `a0cc746`: later integration candidate |
| `lane/modes-online/wave7`, `lane/fog-royale/wave7`, `lane/modes-online/wave8` | `b929e8d`, `8e32193`, `3e39f20`: later rule/adaptor work |
| `lane/server-ai/wave6` | `a033b24`: server/AI boundary; no live deployment certified |

Required end-to-end acceptance: browser lobby; invite/join/rejoin; correct player ownership and current sim version; safe arena geometry; lag/disconnect/reconnect; cancel/return; city progression preserved during matches; payouts once, including after reload. Re-run security and abuse-limit checks for the actual exposed relay/provider. Headless/loopback tests on old branches are not substitutes for this combined test.

## 8. Music, sound and ElevenLabs voices

Current `src/audio/mixer.ts` loads five local synthesized cues. Spray, heap and seized sounds are wired. Splash and the jingle are loaded but untriggered. `setVolume` exists, but `main.ts` does not connect preference controls to it. There is no full music/radio or mission-voice system.

Remaining work:

- Source or create energetic music with explicit game-distribution rights; record provenance and attribution. Do not assume a service's generated output is automatically free to redistribute.
- Create a mission/speaker/line-ID audio manifest, subtitle timing, preload/stream budgets and a queue that handles interruption, retry and reload.
- Validate access to the owner's authorized ElevenLabs credential source (Doppler, Vercel or the named project's local environment). No usable credential or provider deployment was verified in this handoff; do not log or bundle secret values.
- Generate voices through a server/build-time process, or ship pre-generated licensed files. Never expose the API key in browser assets.
- Preserve the existing user-gesture unlock; add separate music/effects/voice volumes, ducking, mute, cancellation, bounded concurrency and text fallback on failure.
- Keep audio out of deterministic simulation decisions: failed or slow playback cannot prevent a mission from progressing.

Existing provenance/tests: `assets/audio/README.md`, `public/audio/manifest.json`, `tests/assets/audio.test.ts`. Coordinate music/voice size with the static build budgets.

## 9. PR disposition and merge discipline

At the last fetch, exact PR heads **#7, #8, #10, #12, #13, #18, #23, #24, #26** were ancestors of the playable integration. #9/#11 functionality is present or patch-equivalent. #16 was selectively repaired/integrated, not merged wholesale. #1/#3 world work is held. Other full heads, including later-wave stacks, are not certified as merged.

Read `origin/docs/parallel-resync:docs/parallel/RESYNC.md` and the `pr-<N>.md` review files, then compare the current head and actual code. Old reviews and branch names are not current CI status. GitHub API access was unavailable in this environment, so PR approval, closure and check status were not certified.

Before closing #5 or #17 as duplicates, recheck their current heads and unique changes. The historical coordination instruction was to preserve useful lobby work from #5 and avoid duplicate mission code from #17. No PR was closed by this session.

Use one coordinator for integration. Keep isolated worktrees for contributors; land by dependency (core/contracts → content/data → agents/combat/player → modes/online/UI). Preserve the working registry and migrations. Do not resolve conflicts by replacing shared files with an old lane's complete version. Do not raise `GAME_WAVE` merely because JSON or isolated tests exist.

## 10. Environment, reproducibility and QA commands

This executor used Node 24.19.0, pnpm 9.12.0, `/usr/bin/chromium` with SwiftShader, and no working Firefox/WebKit or native GPU. Package requirement is Node ≥22.18; dependencies are exactly pinned. Managed-runtime status showed no configured secret bindings/outbound identities and an unknown network-policy enforcement state; actual command results remain the authority. Git fetch/push works. DataSF, the live reference page and GitHub API returned denials in prior checks. Recheck current access rather than treating these as permanent service outages.

Do not bypass the managed proxy or edit `/etc/codex/network-policy.json` to try granting access. Recover trusted caches or use the supported environment-configuration workflow where needed. There is no literal unlimited-compute/network grant.

Every heavy job must share **`/tmp/fog.lock`**: builds, world scripts, typechecks, unit tests, browser tests and large SF probes. Multiple agents may read/review or edit isolated files, but do not run several city-sized jobs at once. Use `NODE_OPTIONS=--max-old-space-size=8192`, Vitest `--maxWorkers=2`, Playwright `--workers=1`. Keep browser-test source frozen; do not let Vite hot reload invalidate evidence. Allocate a unique port per checkout.

Baseline commands, from the intended checkout:

```bash
pnpm install --frozen-lockfile
export NODE_OPTIONS=--max-old-space-size=8192
flock /tmp/fog.lock pnpm typecheck
flock /tmp/fog.lock pnpm exec vitest run --maxWorkers=2
flock /tmp/fog.lock node pipeline/build-gameplay.ts --check
```

For browsers, install the required Playwright engines or explicitly configure the installed Chromium executable. Require all available game prerequisites rather than silently skipping missing SF/render hooks:

```bash
export E2E_PORT=4235
export E2E_GAME_WAVE=3
export E2E_REQUIRE=sf,dev-city,foot,render-debug,landmarks,landmark-ids,roads,step-frames
flock /tmp/fog.lock pnpm exec playwright test --workers=1
flock /tmp/fog.lock pnpm exec playwright test --config tests/ui/browser.config.ts --workers=1
flock /tmp/fog.lock pnpm exec playwright test --config tests/ui/game.config.ts --workers=1
```

The local fallback configs/scripts are `/workspace/.fog-city-tools/wiring-playwright.config.ts`, `/tmp/fog-wiring-unit.sh`, and `/tmp/fog-wiring-campaign-retry.sh`. They reference specific old checkout paths; inspect and update those paths before reuse. The temporary `node_modules` symlink was removed from the clean canonical/release worktrees; install normally or recreate an explicitly ignored local link. Do not commit the link.

On the **structural candidate**, additionally run its `world-pr` project, nightly world sweeps, camera/tunnel probes, tour review and the full producer check:

```bash
flock /tmp/fog.lock node pipeline/build-world.ts --world sf --offline --check
flock /tmp/fog.lock pnpm exec vitest run --project world-pr --maxWorkers=2
```

The producer check requires the missing original source cache. The stable gameplay branch does not currently contain this structural gate project; do not cherry-pick the gate alone onto the old physical world and call its expected failures new gameplay regressions. Tighten reviewed improvements only after inspecting them; never use `--accept-worse` to clear a release blocker.

After each real change, test the affected seam, then freeze the combined release for full verification. Include save migrations, deterministic Node/browser replays, protected actors, long-session retirement, real missions, packed sub-path boot, split/missing packs, resource disposal and visual inspection. Add Firefox/WebKit and real-GPU measurements when available. Do not sum unrelated lane tests as if they tested one combined build.

## 11. Hosting and release

The current ZIP is ready to serve locally (`python3 -m http.server 8000` in the extracted folder), but there is **no new live hosted URL**. Older handoffs mention a Claude artifact; it was not republished or certified by this session.

Choose/configure the actual deployment target and access, publish the exact validated static artifact, then test its public URL: default SF boot, asset requests below the deployed base path, correct MIME/decoding, driving, save reload and full mission flow. Remove obsolete files when the host preserves them between updates. The current packer budgets are 450 files, 240 MB raw total and 15 MB per file; these are packer limits, not a guarantee of another host's limits. Verify the chosen host's actual constraints.

A relay/AI service is a separate deployment with its own authenticated configuration and health/abuse checks. A working static page alone does not publish multiplayer or ElevenLabs generation.

## 12. Recommended next sequence and completion bar

1. Preserve the current known-good branch and artifact. Refresh branch/PR refs and confirm the intended Slop reference revision.
2. Capture a real-GPU visual baseline and implement the bounded Ferry/Market slice. In parallel, recover source inputs and repair structural generator/collision defects.
3. Reconcile structural physics as version nine, complete actor/surface recovery, wire the renderer, and pass strict world plus camera/tunnel gates.
4. Validate Launch Day/Demoed Correctly in the actual city; finish weather and the currently unavailable activities before exposing them.
5. Integrate one later gameplay/mode/relay layer at a time, with real producer/consumer/browser tests and migration coverage.
6. Finish soundtrack, mission voices, audio controls and readable combat/character presentation.
7. Run a frozen combined release pass, inspect high-resolution captures and hardware performance, publish, then smoke-test the actual hosted URL.

The finish line is not “all branches merged” or “all unit tests green.” It is: the SF visual brief is met in real captures; the strict world gate has no unresolved release defects; enabled missions/activities can be completed through real controls; saves/replays and protected-body rules hold; the intended online/audio features work end-to-end; and the published URL plays the tested build.

### Paste-ready continuation brief

> Continue Fog City from `origin/integrate/wave2` (`80a05c4` gameplay checkpoint), not an old showcase or wave-one integration. Read `docs/FOG_CITY_HANDOFF.md` and `docs/parallel/status/integration-wave3.md`. Preserve the tested version-eight game and generic human avatar. Work toward verified Slop New York-style SF visuals; some source-informed rendering already exists, but parity is not achieved. Keep the held world/renderer isolated until geometry, height-aware motion and camera gates pass; their physical merge requires version nine with an 8→9 migration. Recover the pinned source cache, repair verified world defects without accepting worse baselines, and build a matched high-resolution Ferry/Market slice. Then finish real-city wave-three mission coverage, disabled activity producers, weather, staged multiplayer and music/voices. Use isolated worktrees and one shared lock for heavy work, freeze source during browser tests, validate each real gameplay seam, and publish only the combined tested artifact. Follow the owner's current instructions over stale likeness, version and branch instructions in historical docs. Report remaining blockers honestly; do not equate content files or isolated tests with a playable feature.
