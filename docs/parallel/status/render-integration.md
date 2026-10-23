# Render integration

## Now
`lane/render-integration/clean` in `/workspace/fog-city-play-clean` applies only UI/input/save/main/presentation source changes to approved core `a86ac61` (including kernel `b7c412c`). No pipeline or public tile changes are included, and shared simulation changes come only from the published core. The original prototype and disposable Ferry merge remain untouched.

## Done
- Applied the isolated UI/save/runtime commits to the approved kernel renderer. This branch does not assume Ferry-only graphics APIs.
- Mounted immutable HUD/phone/vendor/mission panels with recorded ID-only commands and a shared keyboard.
- Added pooled water/cone/flower projectiles, existing audio samples, actual tank capacities and hold-to-refill controls.
- Added runtime-actor presentation adapter for accepted poses, visible bag/light tells and combat height changes.
- UI projection throttles to 10 Hz; GPS uses cached adjacency and a heap rather than repeatedly scanning all edges.
- Loads optional gameplay metadata and passes it into the shared world.
- Settings mounts the actual save panel; canonical capture/restore whitelists durable player fields, retains settled-mode payout IDs and restores into a fresh initialized world. Added a read-only defensive-copy command log for the browser harness.
- Uses the published `createGameSystems({wave:2})` composition and renders accepted runtime actors through existing models, including bag/light tells and rust height changes.
- `buildLoadedWorld(files)` is the shared pure world builder; browser/Node callers supply optional raw gameplay, pipeline sidewalks and transit. Missing declared layers fail the load. Keyboard U, gamepad and touch bind the shared gear bit.

## Validation
The source changes passed typecheck and 8 persistence/canonical restore tests in the disposable integration tree. The first clean check found the kernel's required dodge field and newly typed extension records; both adapters are corrected, and the final clean check is queued. UI2 has 12 focused control/command tests passing. Actual SF canvas booted in the disposable Ferry merge and produced `test-results/sf-hud.png`; it is reference evidence only. High-GFX software rendering saturated the browser during interaction, so that bounded run was stopped. The next functional run uses this clean branch and a smaller viewport.

## Next
Merge final `createGameSystems` composition, connect accepted runtime actors and transit/sidewalk metadata, separately add reviewed gameplay data to the approved manifest, then run actual SF movement/exit/phone/spray/refill and a mission loop. Capture final screenshots and console results.

## Draft PR
Base: `integrate/wave2`

Head: `lane/render-integration/clean`

Title: `Game: mount progression HUD and controls in the SF renderer`

Body: Connect the published SF renderer to shared gameplay systems and immutable UI projections. Player actions become recorded ID-only commands; the HUD exposes missions, water, cash, navigation and nearby vendors. Adds bounded projectile/audio presentation while preserving the existing renderer assets. Final core composition and actual-play validation are in progress.

## Save audit follow-up
Canonical save capture now reads `economy.settledModeIds` at the extension root and restores the ledger to that root, preventing a repeated match payout after reload. Advanced nozzle/gear enums are accepted. Optional durable Doom clock fields (months, resets, winters, stopped and faction counts) survive reload, while deadlines/cursors reset against the fresh world's calendar. Existing saves without those fields remain valid.

Validation: full typecheck and three focused canonical progression save tests passed. No changes to the simulation, world data or renderer accompany this fix.

## Controller, signup and purchase acceptance
Controller menu navigation and held-input release barriers are now mounted in the clean runtime. Hot Desk's authored multiple-choice answers let a gamepad-only player complete signup through the same gated resolver. `?perf=1` also enables the performance readout. The UI and economy use the same planar, low-speed site eligibility helper, so hill vendors no longer advertise a purchase that the reducer rejects.

Validation: full typecheck; 23 input/command/save tests; 2 focused purchase tests (UI-to-economy at elevated terrain and speed rejection); and 4 real Chromium fixture tests passed. Browser tests verify mobile UI, startup crisis gates, disposal, IndexedDB reload and gamepad-only signup with no held action leaking on close. These fixture tests supplement the independent actual-SF mission harness; they do not claim the SF campaign is complete.

## Mission interaction recovery
Closing a mission dialog or signup no longer strands its active step. The objective card and phone both offer Continue while the interaction remains active. All five Chromium fixture tests passed, including dismiss/reopen through both entry points, gamepad signup, input suppression and IndexedDB reload.

## Campaign handoff selector
Automatic selection now filters authored campaign missions before ordering, so Hot Desk leads to Spill and the standalone Ramen Pitch fixture is never selected. The clean runtime remains wave 2. Three direct selector checks pass (initial, after Hot Desk, after both); the matching focused Vitest regression is queued behind the current full harness gate.
