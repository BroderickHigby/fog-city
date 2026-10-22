# Handoff — 2026-10-22 22:30 UTC

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
   `node scripts/build-web.ts --no-sourcemap` (≤ 64 MB / 255 files per publish; pass `null` for
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
