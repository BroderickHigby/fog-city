# Lane 7: UI, audio and saves

## Now
Wave-3 persistence checkpoint on `lane/ui-save/wave3`, stacked on the published wave-2 UI. Worktree: `/workspace/fog-city-ui`; the previous prototype remains untouched. Actual renderer integration runs separately in `/workspace/fog-city-play` on `lane/render-integration/wave2`.

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

## Next
Finish actual SF browser play-through with the shared core composition; mount save controls with the player's whitelist projection/restore adapter, then later-wave apps and match panels.

## Blocked on
- Real player/mode projections and render mounting must come from the owning lanes.
- GitHub API access is unavailable in this environment; branches can still be pushed and PR text is recorded here.

## Requests for other lanes
- Core: publish `createGameSystems` composition (main currently calls `step` without its optional systems argument).
- Player: progression export/apply callback and later-wave app state; `playerView` projection is agreed.
- Render: mount `mountGameUI`, update its presentation snapshot, combine sampled controls with the sim input frame, and call `dispose` on teardown. UI must never directly move sim bodies.

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
`pnpm typecheck` and `pnpm exec vitest run tests/save tests/ui/commands.test.ts --maxWorkers=2`: passed (6 tests). Earlier wave-2 browser tests passed (2 tests, 6.3s); the new IndexedDB reload test is pending the shared browser window. Actual SF rendering and gameplay validation remain separate integration work.

### Contract changes
None authored in shared simulation files; shared requests are listed above.
