# Historical handoff — 2026-10-22 22:30 UTC

**Superseded for current status:** read [FOG_CITY_HANDOFF.md](FOG_CITY_HANDOFF.md) and [the current integration report](parallel/status/integration-wave3.md) first. The branch/version, likeness and release instructions below describe an older checkpoint; they are retained as history.

Fog City: a browser open-world game of San Francisco. Read `CLAUDE.md`, `docs/design.md`,
`docs/roadmap.md` and `docs/qa/` first. Repo: `BroderickHigby/fog-city`.

## Why work stopped
The org hit its monthly spend limit mid-run (weekly limit resets 2026-10-27 02:00 UTC).
Everything below is committed and pushed; no work is uncommitted.

## Owner's standing requests
- Expand the territory across all of SF; make it realistic and fun like GTA.
- **World QA gate is a hard rule**: houses and landscape feature-complete with hills and
  continuity; no territory step or wave merges until every verified blocker/high/medium world
  defect is fixed and the gate tests pass (`docs/qa/` on `qa/gate`). Re-audit until dry.
- **Textured facades** are the next visual priority (wood siding, stucco, brick, curtain wall,
  real sashes; generated textures only, never photos).
- **Crazy Taxi rule**: nobody can ever be run over (built, see `feature/dodge`).
- **Rusted robots visibly fall down or melt** (design + roadmap updated; built in wave 2 combat).
- Wave 8 sky: warmer blue, clouds, blimps and banner planes with invented startups' ads.
- The player is the owner's stylised likeness (consented; photos never in the repo).
- Owner's deadline for this run was Friday 2026-10-23 12:00 PT.

## Update 2026-10-23 00:10 UTC: house-kit review paused for the Ferry showcase
The owner made the Ferry Building showcase the top priority (branch `feature/ferry-showcase`,
draft PR into `integrate/wave1`). The `qa/housekit` review (next step 1) stopped part-way:
- Done: typecheck and the five house-kit test files pass on 0352655 (70 tests). Street-level
  screenshots were taken in all nine districts (Mission/Liberty St and Mission St at 20th, Alamo
  Square, Sunset 30th Ave, Pacific Heights, Russian Hill, Bernal Heights, the Marina, the Richmond,
  downtown Montgomery St). The facades, palettes, garages, bays and cornices read plausibly as SF.
- Preliminary findings, not yet put through the adversarial verify pass:
  1. **K8 pitched roofs were never built.** Every detached and Sunset house is still a flat box roof,
     and no test covers the spec's "80% get a pitched roof" (`docs/qa/house-kit-spec.md` K8).
  2. **Mission St shopfronts are sparse, not continuous** (K5, tour view 17). Only 70 buildings on
     the 1.25 km from 16th to 24th carry a storefront anchor, and shop glazing appears only on an
     anchor's own wall. Corridor ground floors without a registry anchor show house windows.
  3. **K9 night occupancy has no test** (the spec asks for at least 1 lit window per 3 houses).
  4. Water tanks and boxes sit on 3-4 storey Pacific Heights residential roofs. Check the
     4-storey rule against those records.
  5. The Alamo Square shot was taken from inside the park's trees; the Painted Ladies need a
     closer shot from Steiner St.
- Still to do: an independent reviewer judges the saved shots against the spec, with an
  adversarial verify pass (the owner opted in to a workflow for this step: one reviewer per
  neighbourhood, 2-3 skeptics per finding, agents read only, heavy jobs solo under the lock). Then
  fix the confirmed findings and run the full suite.
- Tooling: there is no Blender binary in the container, and download.blender.org is blocked. Blender
  4.5 LTS runs as the `bpy` module from PyPI (Python 3.11 venv) behind a `blender` shim, so
  `assets/blender/build.sh` works headless. CC0 texture hosts (Poly Haven, ambientCG) are blocked
  by the network policy until the owner allows them.

## Branches (all pushed)
| Branch | Head | State |
|---|---|---|
| `integrate/wave1` | 90b60e7 | Integration branch, PR #1 (draft) into main, CI green |
| `feature/dodge` | 8c9b7a2 | Crazy Taxi dodge + walker-pop fix, PR #2 into integrate/wave1, CI green at d24adcb; two adversarial review rounds passed (0 contacts) |
| `qa/gate` | f1f9d78 | World-continuity gate (ratchet baseline, per-PR + nightly suites), reviewed |
| `qa/sim` | 419bdef | Sim quick fixes + surfaces (decks, tunnels, lakes walled, stairs walk-only); SIM_VERSION 4; reviewed |
| `qa/pipeline` | 51a48bc | Structures (A) + landscape/house data (B), regenerated world; reviewed |
| `qa/render` | fba01ef | Ground classes, lakes, foliage, skirts, sidewalks, decks/tunnels; reviewed |
| `qa/assets` | 10655c5 | Landmarks (both bridges, Sutro, Coit, City Hall, ...) + house-kit props; reviewed |
| `qa/content` | d86bdbd | Palettes, Painted Ladies, landmark tags, storefront kit |
| `qa/housekit` | 0352655 | House kit K1-K9 + textured facades — **built, NOT yet reviewed** |

`wip/*` branches are older backups; ignore them.

## Next steps, in order
1. Review `qa/housekit` (independent reviewer: street-level screenshots in every residential
   district vs `docs/qa/house-kit-spec.md`, budgets, full suite); fix findings.
2. Integrate into `integrate/wave1` in this order: qa/gate, qa/sim, qa/pipeline, qa/render,
   qa/assets, qa/content, qa/housekit. Regenerate `public/tiles/sf` with the pipeline only if
   pipeline/tile files conflict (`--check` must be byte-identical). Full suite + per-PR world
   gate; flip fixed defects' ratchet entries to hard assertions; run `pnpm tour`.
3. Re-audit (data, play, visual), adversarially verify findings, fix; repeat until dry.
4. Merge `feature/dodge` into `integrate/wave1`. **SIM_VERSION clash**: both the dodge and
   qa/sim use version 4; renumber the later one to 5 with an upgradeState step and re-pin replays.
5. Republish the playable artifact https://claude.ai/artifact/9rdkPHC3vuUFnwZZrdtNhW from
   `node scripts/build-web.ts --text --no-sourcemap` (the artifact host serves only text-like types; ≤ 64 MB / 255 files per publish; pass `null` for
   `tiles/sf/world.colliders.bin.gz.b64.txt` and any vanished pack if the collider pack is now split).
6. Then: wave-2 tracks (combat with the fall/melt, etc.), territory expansion, wave 8 sky.

## Operating rules learned the hard way
- The cloud container (16 GB, 4 CPU, no GPU) restarted **five times** from memory exhaustion
  when several agents ran heavy jobs at once. Run **one agent at a time**; every heavy command
  (typecheck, vitest, playwright, builds, tile regeneration, any script loading the sf world) in
  the foreground under one lock (`flock <lock> <cmd>`), `NODE_OPTIONS=--max-old-space-size=8192`,
  vitest `--maxWorkers=2`, playwright `--workers=1`, never under 8 GB free, commit often.
- A memory watchdog and a cgroup memory cap were both refused by the permission system; the
  owner may allow one in settings to run lanes in parallel again.
- CI screenshots step uses Playwright `--global-timeout` (a step timeout fails the job even
  under continue-on-error).
- Commit trailers and PR body footers per the session's attribution rules; no model ids in commits.

## The reasoning behind the main decisions
- **Pure deterministic TypeScript sim, plain-JSON state** (not Rapier): saves, replays and
  multiplayer rollback need bit-identical stepping across Node and every browser; cross-engine
  determinism tests enforce it. Physics libraries are allowed only for cosmetic render effects.
- **Real SF open data only** (DataSF footprints with LiDAR heights, street centrelines, assessor
  roll, business registry; USGS 3DEP elevation). Google/Apple/OSM-derived 3D is licence-barred or
  share-alike; Street View photos are barred, which is also why facades are generated, not photographed.
- **Tiles in plain git, meshopt-compressed**; a citywide collider pack for the sim; far-LOD cells
  for the skyline. The page host serves only text types, so the static build gzips+base64s
  binaries into `.txt` packs and splits any file over 14 MB into parts (host limit 15 MB/file).
- **The world-QA gate exists because the owner asked for continuity first**: a six-dimension
  audit found 52 blocker/high/medium defects (streets walled by buildings, hills through roofs,
  draped tunnels, freeways on the ground, missing bridges, dry lakes, render/sim ground mismatch,
  near/far seams). Each fix carries an acceptance test that fails on the old code, and a ratchet
  baseline makes any regression fail CI. Territory expansion waits on this gate on purpose.
- **Lanes by ownership** (Pipeline, Sim-World, Render-World, Assets, Content, Harness), each on
  its own `qa/*` branch and worktree, merged in dependency order; every lane gets an independent
  reviewer because builder self-reports were repeatedly over-optimistic.
- **Dodge design**: predicted swept footprints plus dives, and a hard post-move override that
  tuning cannot remove, so contact stays at exactly 0 by construction; adversarial reviewers
  found and closed exits beside robotaxis, spawns, joins, shoves, roofs and a 2x perf cost
  (now ~1 ms/tick). Cars are never slowed by people; people always get out of the way.
- **Facades**: chosen by era/use/district from the assessor roll, scaled to the storey grid,
  varied per building by seed, within texture-memory and draw-call budgets tested in CI.
- **Taste and legal rules are non-negotiable** (CLAUDE.md): non-violent (water rusts robots,
  flowers in PvP), no real brands, original robot and car designs, the owner's likeness as the
  only real-person exception, satire punches up at tech/VC culture.
- **Detailed history**: `docs/design.md` decision log (dated entries), `docs/qa/world-qa-report.md`
  (every defect with evidence, cause, fix and test), `docs/testing.md`, and each branch's commit
  messages, which explain the why of each change.

## Why this project exists (the goal)
Fog City is the owner's game: a drivable, satirical San Francisco about five years out, built
from the real city's data so it reads as *their* SF, with GTA-style freedom and fun but
non-violent play (water rusts bad robots; flowers in PvP; nobody is ever hurt). The near-term
goal is a city that feels continuous and real at street level (hills, houses, landscape,
landmarks) before more territory and features are piled on, because broken continuity
(falling through ground, walled streets, floating houses) ruins every other feature.

## Evaluation criteria (definition of done)
Every step is done only when its criteria hold **and** `pnpm verify` (typecheck, unit, e2e) is
green, CI is green on the pushed branch, and an independent reviewer agrees.

| Step | Done when |
|---|---|
| House-kit review | Street-level screenshots in the Mission, Alamo Square (Painted Ladies), Sunset, Pacific Heights, Russian Hill, Bernal Heights, Marina, Richmond and downtown read as San Francisco per `docs/qa/house-kit-spec.md`: storey grid, garage doors, bays, stoops, cornices, era/district palettes, textured facades (siding, stucco, brick, curtain wall) that vary per building; no hill through a roof, no gap under the downhill side; texture-memory, tile and draw-call budget tests pass. |
| Integration | All seven `qa/*` lanes merged into `integrate/wave1`; tiles regenerate byte-identically (`--check`); the per-PR world-continuity gate passes with every fixed defect flipped from ratchet to hard assertion; `pnpm tour` PNGs reviewed by eye. |
| Re-audit | Three auditors (data, play, visual) re-run every W-01..W-52 reproduction and hunt for regressions; an adversarial verifier confirms findings; the round ends **dry**: zero verified blocker/high/medium defects. Closed-loop drives (Filbert, Lombard, Twin Peaks, Great Highway, I-80, I-280, Broadway Tunnel, 3rd St bridge, a 40-seam diagonal) and on-foot routes (Filbert, Lyon St steps) never float, sink, launch, stop on ghost walls or leave the world. |
| Dodge merge | Zero vehicle-person contacts in the per-PR and nightly clearance soaks, the seeded fuzz and the multi-car optimiser; clearance >= 0.75 m outside counted override episodes; the cross-engine determinism tests and pinned replays pass after the SIM_VERSION renumber; sim cost within the design budget (`scripts/bench/sim.ts`, about 1 ms/tick dodge overhead today). |
| Playable republish | The static build fits the host (file count, total, per-file size, extensions); the hosted page boots `?world=sf` with no console errors, streams tiles, draws the far skyline, and drives. |
| Wave 2 and later | Each wave's acceptance tests in `docs/roadmap.md` (for example: the hunter driver melts 3 bad robots in 10 minutes on pinned seeds; a melted Footman and Trundle drop to at most 40% of standing height within 2 s with their heap drawn; no water ever reaches animals, children or seated people). Territory steps also need the world gate green and no open verified defect. |

Things only the owner can judge (frame rate and feel on real hardware, whether it reads as SF,
whether jokes land) are reported to them with screenshots, never claimed as passed.

## Prompt to continue (paste into a new Claude Code session on this repo)

> You are continuing Fog City, a browser open-world game of San Francisco in
> `BroderickHigby/fog-city`. Read `CLAUDE.md`, then `docs/handoff.md` on branch
> `integrate/wave1` (it lists every branch, the reasoning, the operating rules and the next
> steps), then `docs/design.md`, `docs/roadmap.md` and `docs/qa/`. Follow the operating rules
> exactly: one agent at a time, every heavy command in the foreground under a single `flock`
> lock with `NODE_OPTIONS=--max-old-space-size=8192`, vitest `--maxWorkers=2`, playwright
> `--workers=1`, never under 8 GB free, commit and push often. Then work the "Next steps" list
> in order: (1) independently review `qa/housekit` against `docs/qa/house-kit-spec.md` with
> street-level screenshots in every residential district and fix what it finds; (2) integrate
> the QA lanes into `integrate/wave1` in the listed order and make the full suite and the world
> gate green, flipping fixed defects to hard assertions; (3) re-audit data, play and visuals,
> adversarially verify each finding, fix, repeat until nothing new; (4) merge `feature/dodge`,
> resolving the SIM_VERSION 4 clash with an upgrade step and re-pinned replays; (5) rebuild the
> static web build and republish the playable link; (6) continue with wave 2 (combat, including
> robots that visibly fall or melt when rusted), territory expansion and the wave-8 sky. Keep
> PR #1 and PR #2 green, push to the existing branches, and send the owner screenshots of
> monuments and street-level houses after each visual milestone.
