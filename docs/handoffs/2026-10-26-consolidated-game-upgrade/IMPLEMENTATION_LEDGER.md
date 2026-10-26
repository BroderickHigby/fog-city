# Consolidated implementation ledger

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
| 1 | Integration | Refresh and disposition all 16 older PRs | Read-only audit in progress | File/test mapping and retained holds for each PR |
| 1 | Integration | Recover missions and side activities | Auditing selective port | Twenty distinct Plain Words boards through controls, Office Hours repeat payout, legal parking, full Coit viewer/audio |
| 2 | Integration | Movement, combat readability and capacity | Baseline in progress | Matched drive/walk/fight route, hostile identification and once-only rewards, repeated-route memory, 1 GB case |
| 3 | Integration | Vehicle registry, body families, recorded audio | Pending | Rights/source/hash records, wheel/contact normalization, listening proof and lifecycle checks |
| 4 | Integration | Configurable timed taxi mode | Pending | Safe pickup, trip, fare, next passenger, timeout, retry, exit and campaign preservation |
| 5 | Integration | Phone shell and graphics preferences | Pending | Responsive screens, persistent tiers, override precedence, recovery, preserved progress |
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
