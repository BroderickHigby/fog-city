# Visual stream (Lane R): status

Owner's brief: `docs/FOG_CITY_HANDOFF.md` §3 (visual work, including combat presentation and avatar
polish). The coordinator assigned it on 2026-10-23. Approach, slice and targets: `docs/visual/README.md`.

## Rules this stream follows
- Branches are `work/visual/<topic>`, cut from `integrate/wave2`.
- Draft PRs go into `integrate/wave2`. A PR is marked ready only with CI green and a clean merge state. Never merge.
- One heavy job at a time under `flock`:
  - `NODE_OPTIONS=--max-old-space-size=8192`
  - vitest `--maxWorkers=2`
  - playwright `--workers=1`
- Never loosen a test.
- Render changes preserve sim hashes.
- Renderer dependencies are pinned.
- Every asset records its source, licence and redistribution terms.
- SIM_VERSION 9 belongs to the World stream.

## Now
| PR | Branch | State |
|---|---|---|
| (opening) | `work/visual/ferry-slice` | Slice harness, GPU memory accounting, renderer decision and target, baseline shots |
| (next, first) | `work/visual/bottom-blur` | Owner bug: the lower ~40% of the screen is soft on foot |
| (next) | `work/visual/lighting` | N8AO (pinned), a 4096² shadow map centred ahead of the camera on the high tier |
| #33 | `work/visual/combat` | Rust, wetness, topple-and-squash collapse, heap puddles, water splashes; render-only |
| #34 | `work/visual/avatar` | The player body eases its turns; hair is cut out instead of blended |
| #35 | `work/visual/weather` | Light from the game clock; fog, rain, wet roads, puddles and King tide (stacked on #29) |

## Owner priorities (coordinator, 2026-10-23 22:05–22:20)
1. The bottom-of-screen blur (bug, its own PR, first).
2. The Slop New York look: lighting, materials, grade, coherence.
3. Trees that are not see-through: cut-out instead of blended, sorting, translucency, LOD.
4. NPC pedestrians as good as the player's Rocketbox avatar, with variety, LOD and instancing. Coordinate with the Dodge stream (session_018jNDGsP8HczyRRV3vD22e3).
5. Realistic robotaxis and cars: a licensed EV SUV with a roof pod and side lidars in Fog City livery; PBR paint, glass and lights.
6. A real night: no inverted clouds, a proper exposure curve, readable people under street lights, head- and taillights.
7. A held squirt-gun prop on the player's right hand, with the spray from its nozzle.

Street signs, signals, crosswalk geometry, land cover and tree placement moved to the World detail stream.
The static build's budgets are at most 15 MB a file, 240 MB raw and 450 files.

## Coordination
- **World stream** (`qa/world-render-integration`) already carries most of the old Ferry showcase:
  - `showcase.ts`: crosswalk and stop-bar paint, kerbs, palms, the F-line, plaza pavers;
  - `detail.ts`: CC0 PBR detail;
  - sidewalks with kerbs;
  - the house-kit facade shader;
  - structures.

  The Visual stream does not port those into wave2 separately; they arrive with the World renderer.
  Ferry-line pieces only this stream holds:
  - the N8AO + bloom chain;
  - the graphics tier and auto-governor;
  - the lit-office-floor night windows (`feature/ferry-showcase` b0914fb, in `facade-shader.ts`);
  - the `415-mission` and `600-montgomery` landmark models;
  - the VAT crowd.
- **Requests for Lane R** from other streams: see below (checked 2026-10-23 22:20 UTC).

## Baseline (integrate/wave2 ff7db5b, SwiftShader, 1920×1080, `gfx=high&shadows=1&gpumem=1`)
From `docs/shots/visual-stream/00-baseline/slice.json`. Every view settled with no page errors.
Texture and render-buffer figures come from GL allocation accounting (`src/render/gpu-memory.ts`):
width × height × format bytes, plus mipmaps. The frame times are SwiftShader software figures and
**not GPU results**.

| View | Draw calls | Triangles | Programs | Texture MB | Render-buffer MB | Software frame median/p90 ms |
|---|---|---|---|---|---|---|
| ferry-plaza-golden | 206 | 1.29 M | 42 | 140 | 22 | 1733 / 1933 |
| ferry-plaza-night | 178 | 1.22 M | 44 | 146 | 25 | 1667 / 1767 |
| market-street-noon | 259 | 1.69 M | 44 | 152 | 28 | 3916 / 4067 |
| crosswalk-noon | 175 | 1.19 M | 44 | 152 | 28 | 2316 / 2433 |
| embarcadero-north-golden | 163 | 1.31 M | 44 | 152 | 28 | 2400 / 2467 |
| ferry-from-bay-golden | 201 | 1.09 M | 44 | 152 | 28 | 1933 / 2100 |
| ferry-from-bay-night | 228 | 1.05 M | 44 | 152 | 28 | 1933 / 2017 |
| downtown-415-noon | 166 | 1.73 M | 44 | 152 | 28 | 3416 / 3500 |

Every view is well inside the proposed high-tier budgets in `docs/visual/README.md`: at most 1,500
draw calls, 6 M triangles, 512 MB of textures and 120 programs. There is room to spend on detail.

## Gaps seen in the baseline images (ranked)
1. **Ground planes read as empty slabs.**
   - The Ferry plaza is one uniform blue-grey paver field.
   - The crosswalk view has no crosswalk paint, no stop bar and no kerb ramp.
   - Plazas and sidewalks carry no furniture.
   - The World stream's `showcase.ts`, `sidewalks.ts` and `detail.ts` cover most of this when its renderer lands (§5).
2. **Facades are flat extrusions.** They repeat punched windows with no depth, interiors, cornices or roof
   detail, and ground floors are blank. The towers read as untextured boxes (`downtown-415-noon`: 415 Mission
   is a generic box, because the wave2 renderer loads only 2 landmarks here). The house kit (World) covers
   low-rise; towers need curtain wall plus interior mapping (this stream).
3. **Building bases do not meet the ground.** `embarcadero-north-golden` shows a wavy seam where the
   sidewalk meets the facade, and the sea views show buildings standing on bare shoreline with no quay.
   Foundations and skirts arrive with the World renderer.
4. **The night is too dark at street level.** The ground is near black and facades are unlit apart from
   windows. Street lights make small pools, and a hard orange blotch shows in the foreground
   (`ferry-plaza-night`).
5. **No ambient occlusion or contact darkening.** Trees, poles and robots float on the ground
   (the N8AO pass is on `work/visual/lighting`).
6. **Sky.** At noon the cloud layer streaks into long parallel smears. Fog is a flat haze with no
   aerial-perspective tint.
7. **Weather is not drawn.** The sim's fog, rain, puddles and tide are invisible (Gameplay request; see below).
8. **Scale and life.** Plazas are nearly empty of people; the few figures and cars read small against
   the 62° FOV.

## Requests for Lane R from other streams
- **Gameplay** (`work/gameplay/weather`, PR #29): weather presentation: sim time of day, fog volume,
  rain, wetness, puddles, King tide and rain capes. Being built on `work/visual/weather`, stacked on #29;
  rain capes are not done yet.
- **Sim-Combat** (status file): Footman and Trundle drawn at most 40% of their height within 2 s of
  seizing. A render-level proof is on `work/visual/combat`. The browser gate belongs to Lane 2.
- **Audio** (PR #28): review its `main.ts` and `build-web.ts` hook-ups.

## Requests from Lane R to other streams
- **World:** pick up the night-window strips (`feature/ferry-showcase` b0914fb) when the house-kit
  facade shader lands, or leave it to this stream afterwards.
