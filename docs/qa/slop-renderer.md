# Slop New York renderer refactor

Owner request: make Fog City look much more like [Slop New York](https://mrdoob.github.io/slop-newyork/) and use its methods and procedures. Latest release direction: build and commit locally; no interim pushes, CI or deployment; open one consolidated PR to main once all requested work is ready.

## Intended result

- A substantive renderer/material migration uses the reference's WebGPU/TSL approach, physical sky-derived environment lighting, near/far sun shadows, filtered facade/room materials and restrained post-processing. Report the backend actually in use. Keep a working supported fallback; avoid a constructor-only renderer swap that silently loses GLSL effects.
- Dense SF streets gain readable masonry, window depth and interiors, plausible exterior attachments, darker textured asphalt, clear paving/curbs and more open, branch-shaped trees. Preserve San Francisco footprints, road geometry, landmarks and mapped lawns.
- Golden-hour and midday comparisons include actual shadows. Choose a real street canyon, not only the open Ferry plaza. Night rooms, glass, foliage and grass remain coherent without static, flicker, floating geometry or buried feet.
- The HUD is compact and legible, with existing counters, objectives, map, modal controls and targeting-only reticle preserved. Display real street names when available. No fake or disconnected mode buttons.

## Existing game remains intact

Keep painted/art cars, periodic civilian traffic, grounded people, running speed/orientation, H robotaxi takeover, save/spawn handling, grass, building identity, missions and multiplayer behavior. Do not change SIM_VERSION, replay goldens, collision data or city geography for this render work.

## Source and validation

Pin the inspected reference commit and preserve its complete MIT notice in the source and packed distribution. No NYC/OSM data import or moving CDN dependencies.

Use local type/build checks and actual browser runtime/visual checks, not CI. Verify renderer initialization, shader readiness, context/graphics recovery and fallback; day/golden/night street and pedestrian/car views; finite travel/unload/return resource behavior; and packed-asset loading. Observe scene-count and resource budgets, and do not assert software-renderer FPS as hardware performance. Keep existing measured limitations explicit without treating waived CI as a release gate.

All remote writes, main integration and production publication wait until the full local request is ready. Earlier PRs are ready but remain unmerged; their source is already included in this branch.

## Robot encounters (separate gameplay change)

The owner also requested robots that engage the player and can be fought. SIM_VERSION 17 adds proactive rogue encounters and a corrected deterministic firmware roll; the renderer migration itself does not change simulation rules. Existing v16 observations, firmware assignments, historical replay pins and saved progression fields remain intact.

Bad ground robots may initiate within 18 m only after their normal sight cone, fog range and building line of sight pass. Known protected or in-vehicle players stay ineligible, including mixed-player target selection. No additional robot population is spawned. Good robots, people and animals do not become enemies. Existing wind-ups, slapstick effects and water rust/seize/slump/heap behavior provide the fight loop.

The actual SF seed-1 CPU proof used normal recorded inputs from fresh spawn, without teleports, extra enemies or forced hits/rust: F exit, street movement, agent:538's player-targeted windup at tick3932 and resolution at3980, real water at4000, seizure4242, heap4362. The simple route follower took about65 seconds to the first attack and72.7 seconds through the heap. This establishes gameplay logic; the renderer's attack/water/rust/grounding presentation still needs browser QA.
