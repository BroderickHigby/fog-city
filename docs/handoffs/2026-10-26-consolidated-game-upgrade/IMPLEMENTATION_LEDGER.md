# Consolidated implementation ledger

> Recovery update,27 October2026: implementation continued after this ledger's last entry. Read [the recovery handoff](../2026-10-27-recovery/HANDOFF.md) and [fresh validation](../2026-10-27-recovery/VALIDATION.md) for the captured source, remaining blockers and current184-test focused pass. The statuses below are historical and do not describe a completed release.

Working branch: `codex/consolidated-game-upgrade`, seeded at `010e0a9b795c97cf70796bb5298c4963a4867a2d`.
Fetched baseline: `origin/main` at `66b1e6f51fd1799612d6319980fca7f2241b17a9` (26 October 2026).
Integration PR: https://github.com/BroderickHigby/fog-city/pull/107 (draft, documentation seed).

## Delivery rules

Local commits first; reuse PR107 for final integration. Hosted Actions excluded; commits use `[skip ci]`.
Keep all old drafts open until their replacement lands. Retain historical fixtures, strict physical gates,
SF geography, authored humans and saves. A running preview is not release or performance acceptance.

## Ordered tasks

| Priority | Owner | Work | Status | Acceptance evidence still required |
| --- | --- | --- | --- | --- |
| 1 | Integration | Refresh and disposition all 16 older PRs | Source audit complete; see PR_DISPOSITION.md | File/test mapping and retained holds for each PR |
| 1 | Integration | Recover missions and side activities | Selected port and regression repairs in progress | Twenty distinct Plain Words boards through controls, Office Hours repeat payout, legal parking, full Coit viewer/audio |
| 2 | Integration | Movement, combat readability and capacity | Baseline in progress | Matched drive/walk/fight route, hostile identification and once-only rewards, repeated-route memory, 1 GB case |
| 3 | Integration | Vehicle registry, body families, recorded audio | Pending | Rights/source/hash records, wheel/contact normalization, listening proof and lifecycle checks |
| 4 | Integration | Configurable timed taxi mode | Pending | Safe pickup, trip, fare, next passenger, timeout, retry, exit and campaign preservation |
| 5 | Integration | Phone shell and graphics preferences | Implementation in progress | Responsive screens, persistent tiers, override precedence, recovery, preserved progress |
| 6 | Integration | SF landmarks and robot models | Pending | Correct position, silhouette, support/collision, reachable viewpoints, rights, LOD and collapse |
| 7 | Integration | Recorded opening story | Pending | Licensed/consented actual audio, skip/replay, subtitles, voice volume, missing/slow/unlock recovery |
| 8 | Integration | Contributor guide and integrated QA | Pending | Final packed artifact, serial local verification, independent Standards/Spec review, exact-head deployment/public checks |

## Initial local evidence

- Clean isolated linked checkout; original `feature/controls-menu` checkout preserved.
- Node 24.19.0, pnpm 9.12.0, Three.js 0.186.1 installed from frozen lockfile.
- Typecheck passed before source edits.
- Baseline packed build: 192 files, 174.9 MB, largest 12.2 MB; unchanged 450-file / 240 MB / 15 MB limits.
- Machine: Intel iMac, 128 GiB RAM, AMD Radeon Pro 5500 XT (8 GB), 5120×2880 display.
- Isolated Chrome 156.0.8078.48, 1100×700, DPR1, WebGPU. Paused startup seed1/tick0 hash `e64e6b7d`.
  No page errors. 330 sim agents, 261 drawn, 12 authored crowd models loaded. JS heap snapshot 956,630,301 bytes.
  This is boot evidence only: no sustained timing, route plateau, audio or 1 GB capacity acceptance.
- Raw local baseline: `test-results/consolidated/baseline.json`, `baseline.png`; packed bytes in `test-results/consolidated-baseline/`.

## Retained holds

- Performance/allocation and 1 GB capacity acceptance remain open.
- PR54 OSM/ODbL policy hold remains separate; no OSM-derived data imported.
- Plain Words real-control completion, Coit full authored scope and structural-route proof remain open.
- No new gameplay commit pushed, no draft closed, no merge or deployment performed.

## Focused validation during implementation

- 161 tests passed across 25 files: current player reducers, Office Hours booking boundaries, distinct boards, collapsed silhouettes, SIM20 continuation, graphics preference and provenance.
- 93 tests passed across five files: exact restart checkpoint/continuation, original board geometry/lifecycle, silhouettes, SIM20 migration and provenance (overlapping prior coverage; totals are not additive).
- Four isolated graphics UI browser tests passed: persistence, input/focus isolation, pending selection, retry and fallback reporting.
- These are focused checks; full local verification and packed-runtime feature acceptance remain pending.

## Local feature tranche, 26 October 2026

- SIM21 selective mission port, separate legacy activity reducer, distinct board qualification,
  protected collapsed silhouettes, Office Hours quota/save and shared legal parking are implemented.
- Phone handset/navigation, persistent graphics/controller and full restart checkpoint are wired.
  Taxi has an isolated protected-passenger/physical-car reducer, real legal SF curb circuit,
  Controls entry, shift HUD, retry/exit settlement and exact campaign/reload checkpoint ownership.
- Hostile warning diamonds and shape-based confirmed map cues use current firmware/phase;
  neutralized/protected/benign actors are excluded. Existing scanner guesses do not paint targets.
- Original project landmark GLBs recovered selectively with immutable source/output hashes,
  named map viewpoints and render-only near/far fallback ownership. Existing Palace/Ferry/R-evolution
  are retained. This is not structural bridge/support or final visual-route acceptance.
- Five CC0 Kenney vehicle families and recorded driving layers are connected. Actual body/hub,
  material, batching and lifecycle checks pass; listening approval remains pending.
- Six actual original stock-voice opening MP3s total60.01s /724,690 bytes. Existing voice queue,
  subtitles/ducking, skip/replay and disclosure are wired. The319 separate mission manifest
  entries remain text-only; opening files do not falsely count as recorded mission dialogue.
- Contributor guide added at `docs/CONTRIBUTING_FEATURES.md`.

Validation: first complete unit run4353 passed/17 failed/1 skipped (4371 total).
An untouched `origin/main`66b1e6f control reproduced all12 physical/performance failures,
including exact deterministic traffic numbers; inherited does not mean accepted. Manifest,
Palace schema/provenance and forbidden-API integration errors were repaired. Subsequent focused
batches include65 passing mode/checkpoint/marker/opening tests,28 asset/privacy/opening tests,
50 director/queue/graphics tests and the separate vehicle-owner focused checks. These batches
overlap and are not a full-suite replacement. Typecheck passed after current source integration.

Plain Words controls evidence: first attempt8 boards/1 spinner; second16/all4; third18/all4.
All had zero protected contacts/failures, genuine negative timeouts and no payout. Third source
fingerprint `3c7a0e26ff92f29ada60456ec10e0fd2ef36c7b9a340258223227ceab5c719f2`.
Driver timing/navigation faults are being repaired while the authored300s limit remains strict.
Full20-board acceptance, packed browser replay, full Coit scope, legacy core progression/combat,
traffic/source repair, low-memory/performance, final screenshots/listening and independent review
remain OPEN. No gameplay push, merge, production deployment or old-PR closure occurred.
