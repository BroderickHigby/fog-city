# Fog City recovery checkpoint

Prepared 27 October 2026 (Pacific). This is a work-in-progress recovery, not a release candidate.

## Start here

The interrupted chat was **Inspect Fog City handoff archive**. Its coordinator stopped with HTTP 413 while integration and diagnostic work were in progress. The substantive implementation was still on the iMac, mostly unpushed. The GitHub draft PR alone did not contain it.

Repository: https://github.com/BroderickHigby/fog-city

Recovery branch: `codex/fog-city-recovery-2026-10-27`

Existing consolidated draft: https://github.com/BroderickHigby/fog-city/pull/107

```sh
git fetch origin
git switch --track origin/codex/fog-city-recovery-2026-10-27
pnpm install --frozen-lockfile
pnpm typecheck
```

If that local branch already exists, switch to it and inspect its status before pulling. Do not overwrite another agent's modifications.

Read this document first, then `../2026-10-26-consolidated-game-upgrade/HANDOFF_PROMPT.md` for the original scope, `PR_DISPOSITION.md` for the 16 older drafts, and `IMPLEMENTATION_LEDGER.md` for historical progress. This recovery document supersedes stale status statements in those documents; it does not waive their acceptance requirements.

## What was recovered

Original checkout: `/Users/broderickhigby/workspace/fogcityworktree/consolidated-game-upgrade`.

Original local HEAD: `96048e15b486dc2a81c67b0e4677a6f5e415477c`. Three implementation commits were ahead of the original shared seed:

- `7d86a68d`: baseline and acceptance ledger.
- `163f011d`: consolidated gameplay foundations.
- `96048e15`: optimized licensed vehicles, landmarks and recorded audio.

The recovery also includes **116 pending files**, including modifications to 64 tracked files and 52 untracked files. `RECOVERED_FILES.json` records their exact SHA-256 hashes at capture. It preserves source, tests, generated robot GLBs, Coit recordings and tooling. The original checkout has not been edited by this recovery.

The shared GitHub branch remained at `ac834c34bf2b6e9b99f968125ea9cebead360a43`, containing two later documentation cleanups. The recovery includes those cleanups, including removal of the optional settings photo. GitHub PR107 was verified as draft and unmerged, with main at `66b1e6f51fd1799612d6319980fca7f2241b17a9`.

The recovery branch packages the complete resulting tree above that shared GitHub checkpoint. It does not rewrite PR107's branch or create another release PR. When integrated work is actually ready, update the existing consolidated branch/PR after checking its then-current head. Do not blindly cherry-pick a snapshot on top of competing implementation changes.

## Implemented, with acceptance still incomplete

| Area | Present in the recovered tree | What still needs evidence |
| --- | --- | --- |
| Mission/activity recovery | SIM21 compatibility path; Plain Words distinct boards; Office Hours booking/rewards; legal-parking producer; Coit viewer, observations, voice assets and QA driver | Full ordinary-control completion and final packed browser playback; see mission plan below |
| Vehicles/audio | Five distinct licensed vehicle families; recorded idle/acceleration/roll/road/brake layers; bounded audio lifecycle | Listening approval and native-browser loop/transition validation; actual taxi route success |
| UI/settings | Phone shell/navigation; persistent graphics preferences and restart checkpoint; hostile markers; loadout controls | Narrow/touch layouts, graphics recovery, real input and save/reload across features |
| Taxi | Isolated session state, pickup/dropoff/timeout/retry/exit, route selection and campaign-preservation logic | Successful physical fare, timeout, retry and exit through controls; traffic remains a blocker |
| Landmarks/robots | Recovered landmark models and viewpoints; industrial porter and collapsed-model updates | Correct real-world placement/support/collision, near/far continuity, robot motion/collapse and budgets |
| Story | Six actual opening MP3s, subtitles, skip/replay and voice queue wiring; Coit audio files | Playback/unlock/missing-audio/ducking tests; the older mission narration catalog remains largely text-only |
| Combat/progression | Modern-only gadgets/flowers/pause, earned rewards and loadouts, Doom Clock, match carry/settlement, placement/lure producers, tactical effects module | Integrated UI/world presentation and current-version replay, match entry authority, crowded-world placement/lure acceptance |

Source presence is not proof that a feature is complete. Some recovered modules were added after the earlier implementation ledger and have not received final combined-source acceptance.

## Where to resume, in order

1. **Establish the exact recovered baseline.** See `VALIDATION.md` for checks run during recovery. Keep SIM21 historical compatibility and fixture integrity. Do not replace old golden files to make new behavior pass. Re-read current simulation contracts before allocating any next version.
2. **Fix the remaining strict traffic junction.** Retained `src/sim/agents.ts` is the implementation that passed separate Marina and Fillmore runs. At junction `(-620, 746)`, seed1/wave3, actor2161 stood for2401 ticks against a strict limit of less than2400. Zero contacts does not clear this failure. Investigate connector/admission throughput at `n30735000`, preserving physical hulls, pedestrian rights, signals and deterministic behavior. A deferred-priority experiment worsened another car to3586 ticks and was reverted. Do not reapply it based only on its focused unit tests.
3. **Finish real mission/activity acceptance.** `evidence/mission-next-runs.md` gives detailed starting points for Coit, Launch Day, Demo'd Correctly, repeat Office Hours and Search & Park. Plain Words' fourth recorded attempt reached18 boards/all4 spinners in its progress log, not a proven20-board completion. Keep the authored300-second limit, protect bystanders and prove once-only rewards. Do not seed activity progress or teleport through route failures.
4. **Prove the taxi loop against the repaired world.** Complete a physical fare, a timeout and a retry with the campaign preserved. Historical taxi diagnostic scripts under `evidence/taxi-draft/` are evidence/reference copies and may require imports to be adapted to their new location; they are not claimed runnable as-is.
5. **Complete combat/progression presentation and integration.** Read `evidence/progression-draft/STANDARDS_AUDIT.md`, including its18:05 follow-up. Several initially missing backend producers were subsequently wired. Verify actual Tensor placement, lures, carried authority and earned streak behavior before declaring them done. The final source contains `src/render/tactical-effects.ts`; check its live consumers rather than assuming the older audit still describes the final renderer. Approved billboard surfaces, picked-point feedback and additional named modes need explicit source/runtime review. A type union is not a playable mode.
6. **Clear performance and structural holds.** Profile allocations before expanding detail. Separate JS heap, backing stores and GPU accounting. Run repeated-route native-browser measurements and the explicit1GB case, retaining failures. Recover strict route/deck/bridge/controller coverage without importing the held OSM dataset. The appearance of a bridge model does not establish traversable support. See the preserved diagnostic notes.
7. **Finish audio/visual acceptance and final integration.** Listen to idle, acceleration, cruise, braking, stop and car changes; verify mute/volume, pause/visibility and cleanup. Run the final packed artifact through desktop/touch, supported render backends, graphics tiers, save/reload, missions and landmarks. Complete full serial local validation and required independent reviews before changing PR107 from draft. Only then use the original reviewed release workflow.

## Known evidence and limits

- The historical full unit run reported4353 passed,17 failed,1 skipped before further repairs. This is neither a current final result nor17 confirmed current failures. The later source changed.
- Historical separate traffic runs: Marina2543 stationary ticks below2700; Fillmore3557 below5400; both zero contacts. One junction still failed at2401 against less than2400. Two other junction cases, taxi acceptance and final combined-source broad checks were still pending.
- The recorded driving sample is local-only at the original checkout: `test-results/consolidated/driving-review.wav` (22 seconds). Its metadata explicitly retains `qualityApproved: false`. Rendering a sample did not constitute listening approval.
- The opening recordings do not resolve the separate text-only mission-narration catalog.
- The last recorded static baseline was192 files/174.9MB. This is not a current build measurement. Packaging limits remain450 files/240MB/15MB per file; they are not RAM limits.
- Performance/allocation,1GB capacity, strict structural/bridge proof and the OSM/ODbL policy hold remain open.

`EVIDENCE_MANIFEST.json` hashes the portable evidence copies. These preserve selected reports and source diagnostics. New QA screenshots and the driving sample remain local-only because automated upload review did not approve media export; manifest entries mark them `local_only`. They are not required to build the recovered source. Original owner references already on the shared branch remain intact. Large duplicated world snapshots, raw caches, node_modules and generated build directories are deliberately not part of the source commit. Original full captures remain under the original checkout's ignored `test-results/` directory; never assume they exist on another computer. Hashes and old report paths describe the original measured run, not an automatic test pass on this branch.

## Scope and delivery guardrails

- The current request is to recover/push a branch and hand off unfinished work. No merge, production release or old-PR closure is part of this checkpoint.
- Keep the owner's single consolidated release PR107. Retain the16 old drafts until their replacements are actually reviewed and landed.
- Hosted Actions remain excluded. Use `[skip ci]`; skipped checks are not passes. Do not modify billing or trigger reruns.
- Run heavy builds, simulations and browser tests serially. Keep physical and memory limits intact.
- Audit licenses/provenance before adding assets. Preserve the SF world, authored humans, current saves and deterministic historical behavior.
- Check current remote heads before continuing, since another computer can be working on the project.
