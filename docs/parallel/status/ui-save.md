# Lane 7: UI, audio and saves

## Now
Wave-3 persistence checkpoint on `lane/ui-save/wave3`, stacked on the published wave-2 UI. Worktree: `/workspace/fog-city-ui`; the previous prototype remains untouched. Approved renderer integration runs separately in `/workspace/fog-city-play-clean` on `lane/render-integration/clean` (checkpoint `25d7aa8`). The older `/workspace/fog-city-play` checkout is disposable and must not be merged: it includes unreviewed world-pack history.

## Done
- Read the lane rules, UI/save roadmap, input/HUD implementation and free-text safety contract.
- Selected the existing content crisis check and lint as the single safety implementation; UI will not duplicate them.
- Added `mountGameUI(host, options)`: HUD, objective, directed GPS minimap, Map/BotBounty/BotCheck phone, vendor, capped adverts, startup form, touch controls and performance display. All displayed data comes from an immutable `UiView`.
- Added held spray/scan, one-shot gadget actions, gamepad deadzone/edges, touch release handling, typing/modal suppression and disposable keyboard listeners.
- `gameplayCallbacks` sends validated `gameplay.command` events with monotonically increasing sequence and ID-only payloads; UI never mutates sim state.
- FreeTextBox runs crisis detection before length/lint, strips contact details and delimiters, and never calls a resolver for blocked or crisis text.
- Typecheck, 10 focused tests and both 390px Chromium integration tests passed. Browser checks exercise phone/map, hidden robot markers, purchase eligibility, recorded commands, crisis-before-length, typing isolation and teardown.
- Follow-up controls/command checks: 12 tests pass, including held interaction through a full refill and sequence one for first gameplay commands. Purchases can carry the actual vendor site ID.
- Added progression-only `SaveStore`: three manual slots plus autosave, schema/SIM_VERSION/content-hash metadata, corruption checksum, explicit migration hook, required host domain validation, confirmation-before-import, newest offline-cache selection and serialized writes. Whole simulations and transient actor fields are rejected.
- Added IndexedDB and memory backends, a host-provided private-page backend interface, a mounted save/load/import/export panel and coalescing autosave helper. Save-domain tests and typecheck pass; IndexedDB reload browser test is authored and awaits the next permitted browser window.

- Adversarial follow-up adds controller-only menu navigation, authored startup fallback choices, and a release barrier so held keys/pad buttons cannot fire or move after a menu closes. Gamepad feature-policy failures safely produce no input.
- Autosave now preserves the existing slot at initial boot, catches capture errors, and coalesces writes to the latest durable checkpoint. Typecheck and 20 focused input/command/save tests pass.
- Clean runtime `25d7aa8` mounts the real HUD, canonical player/combat projections, versioned save capture/restore and `createGameSystems({wave:2})`. Shared `buildLoadedWorld` loads gameplay, sidewalks and transit identically for browser/Node consumers; clean runtime typecheck and 21 focused tests pass.

## Next
The independent integration harness is checking actual SF mission/purchase/refill play-through against the clean runtime. Port this UI-only adversarial follow-up after its current run; later-wave apps/match panels remain gated on functioning mode providers.

## Blocked on
- Actual SF mission play-through and console-clean screenshots remain to be verified by the integration harness. The published approved SF manifest must receive reviewed gameplay metadata for authored refill sources.
- Later-wave mode and online UI remain gated on functioning mode providers.
- GitHub API access is unavailable in this environment; branches can still be pushed and PR text is recorded here.

## Requests for other lanes
- Core: `createGameSystems` is published and integrated in the clean runtime; no pending shared contract edits from this lane.
- Player: canonical projections and durable save whitelist are integrated; later-wave app state remains an owner dependency.
- Render: clean runtime mounts `mountGameUI` and combines sampled controls with the sim input frame. UI never directly moves sim bodies.

## Requests for Render-World / Assets
- A DOM layer above the 3D canvas with pointer events only on controls and panels.
- Licensed radio/sound files and nameplate anchor/occlusion projections for later waves.

## For the owner
No new service, hosting, licence or design decision is introduced by this lane.

## Draft PR
Base: `lane/ui-save/wave2`

Head: `lane/ui-save/wave3`

Title: `Saves: add versioned progression storage and import/export panel`

### Summary
Adds three-slot progression storage with autosave, IndexedDB fallback and a host-supplied private-page backend. Checksums detect corruption; import validates the record before asking for confirmation and never changes the running game directly. A mounted panel provides accessible save/load/import/export controls. The required domain validator and transient-state gate keep traffic, combat actors and raw simulation snapshots out of saves.

### Acceptance tests
`pnpm typecheck` and `pnpm exec vitest run tests/ui/controls.test.ts tests/ui/commands.test.ts tests/ui/menu-gamepad.test.ts tests/save --maxWorkers=2`: passed (20 tests). Earlier wave-2 browser tests passed (2 tests, 6.3s); the new IndexedDB reload test is pending the shared browser window. Actual SF rendering and gameplay validation remain separate integration work.

### Contract changes
None authored in shared simulation files; shared requests are listed above.

## Local mode UI checkpoint (wave 4 branch)
Worktree: `/workspace/fog-city-ui-modes`; branch: `lane/ui-modes/wave4`, based on clean gameplay `25d7aa8` with the controller follow-up. Adds a host-enabled Playlists menu for local Bot Sweep/Clean Streets, immutable match HUD data and an explicit result/return panel. The UI emits start/cancel/return callbacks; it does not create simulation state or payouts. The runtime host will preserve free-roam by value, run the isolated match driver, and settle validated rewards once on explicit return. Save/autosave must capture preserved free-roam while a match is active.

Draft PR title: `UI: add local match menu, status HUD and result screen`

Draft PR body: Adds controller-accessible local mode selection and match result presentation behind an explicit host enablement option. Runtime integration follows the canonical local-match API; no outcome or reward is injected by this UI. Existing free-roam UI remains on the clean renderer branch.

Validation for the local UI scaffold: full typecheck and 14 focused controller/command tests pass. The module uses existing authored copy keys and plain text DOM nodes. Actual mode creation, play-through, cancellation and settlement await the published runtime API and integration checks.

## Local match runtime integration
The isolated mode UI branch now composes the published local-match driver (`4bba79b`) with verified core mode/performance/pause seam (`f20d53d`). Playlists starts Bot Sweep or Clean Streets in a fresh simulation at the player's position. An unavailable arena leaves the city untouched and shows the existing error copy. The host retains the city by value, routes fixed ticks through `stepLocalMatch`, displays actual match status/results, and applies canonical payouts only on explicit return. Cancel restores the city unchanged. Save/autosave read the retained city during a match; load cancels the match. Audio cursors reset when switching simulations. Vendor eligibility calls the shared site predicate.

Verification: combined full typecheck passed. The settlement→save→restore→repeated-settlement regression passed, alongside input and storage tests. One existing rank expectation was updated from 2 to 4 to match the current authored 900-XP threshold; its narrow rerun is pending. Actual SF mode browser proof still awaits the integration harness/performance freeze.

Latest draft PR title: `Game: connect local Bot Sweep and Clean Streets to the HUD`

Latest draft PR body: Adds playable local-match entry and results to the phone, driven by the shared deterministic match runner and physical roster. The city simulation is retained independently; cancellation restores it and explicit return applies validated payouts once. Saves capture city progress during matches, and the persisted payout ledger prevents duplicate rewards after reload. Includes controller menu support, authored signup choices, canonical vendor eligibility and a settlement round-trip regression. Validation and remaining browser proof are recorded above.

## Recorded aim follow-up
Worktree `/workspace/fog-city-aim`, branch `lane/input-aim/wave4`. Canvas drag and the right stick produce bounded aimYaw/aimPitch fields on recorded SimInput. Chase and first-person cameras follow those same angles; left mouse sprays, middle mouse / gamepad Back recenters, and touch canvas drag aims without firing. Fly camera input is drained separately. Pointer cancellation and UI disposal release fire, while modal barriers suppress look input.

Validation: typecheck and 15 focused input/aim tests passed, including recorded-angle bounds, first-person bearing, modal suppression and pointer cancellation. The accepted source-only visual commits are included. Final combined verification follows the arena and Watch ownership patches; actual native-GPU frame rate has not been measured. Private relay transport is not exposed by a lobby UI in this candidate.
### High-rank loadout fix
The match API caps carried perks and streaks at three. A progressed city profile can unlock more than three, so the host now uses `loadoutForMatch`: first three unique entries in unlock order until an explicit slot-selection screen exists. This never edits the city profile. The regression launches both local mode kinds with a rank-25, four-perk/four-streak profile through the real match constructor. Focused verification is queued with the save round-trip check.

### Wave availability and convergence
The later local-mode host uses implemented wave 4; the clean wave-2 host remains wave 2. A shared UI campaign selector skips standalone authoring fixtures and exposes Launch Day after Hot Desk/Spill, then the rest of the implemented campaign in order. Higher-wave missions remain gated. Typecheck and seven focused campaign/loadout/save tests pass, including both high-rank local-mode constructors and duplicate payout prevention after reload. The Continue/reopen behavior matches the separately browser-verified clean fix.

Remaining integration dependencies: arena isolation, Watch following recorded aim, accepted visual polish, and the combined actual-SF browser pass. Private-room relay APIs exist, but this host does not expose a network lobby; only local Bot Sweep and Clean Streets are enabled here.

### Independent convergence review
Three fixes are complete: chase orientation now exactly follows recorded aim after positional smoothing; `ProgressionSession` preserves validated profile-v2 data across later captures; existing autosaves are recoverable via Load/Export in Settings. Typecheck and ten focused aim/profile/settlement/campaign/loadout checks passed, and all six Chromium fixture checks passed, including explicit autosave recovery and mission dialog reopening. The reviewer rechecked the fixes without finding another critical gap.

Final integration includes core weather/recovery `078188a`, source-only visual wave 9, isolated arena/refill admission `5e7447e`, and the mission phone-ack guard. The high-rank fixture now supplies a real authored refill. Missing arena water displays the authorized actionable copy. Waiting only on the owner's Watch direction fix before final combined tests and actual SF image capture.
