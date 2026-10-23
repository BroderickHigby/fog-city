# Lane 7: UI, audio and saves

## Now
Wave-2 browser interface on `lane/ui-save/wave2`, based on core `9a6a107` plus published core `8c6dff9` and content `5b40bb5`. Worktree: `/workspace/fog-city-ui`; the previous prototype remains untouched.

## Done
- Read the lane rules, UI/save roadmap, input/HUD implementation and free-text safety contract.
- Selected the existing content crisis check and lint as the single safety implementation; UI will not duplicate them.
- Added `mountGameUI(host, options)`: HUD, objective, directed GPS minimap, Map/BotBounty/BotCheck phone, vendor, capped adverts, startup form, touch controls and performance display. All displayed data comes from an immutable `UiView`.
- Added held spray/scan, one-shot gadget actions, gamepad deadzone/edges, touch release handling, typing/modal suppression and disposable keyboard listeners.
- `gameplayCallbacks` sends validated `gameplay.command` events with monotonically increasing sequence and ID-only payloads; UI never mutates sim state.
- FreeTextBox runs crisis detection before length/lint, strips contact details and delimiters, and never calls a resolver for blocked or crisis text.
- Typecheck, 10 focused tests and both 390px Chromium integration tests passed. Browser checks exercise phone/map, hidden robot markers, purchase eligibility, recorded commands, crisis-before-length, typing isolation and teardown.

## Next
Separate render-integration branch: mount the tested UI in the ferry-showcase renderer, feed shared player/combat snapshots and queue recorded commands. Progression-only saves, later-wave apps and match panels follow.

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
Base: `integrate/wave2`

Head: `lane/ui-save/wave2`

Title: `UI: add guarded browser controls, HUD and phone panels`

### Summary
Reusable browser UI consumes immutable presentation data and emits recorded controls. Adds HUD/objectives, directed GPS, phone and vendor panels, accessible modal focus handling, touch/gamepad controls and disposable keyboard input. The sole free-text component runs the existing crisis check before all parsing, validation and submission, then strips contact information before the content resolver. Display text comes from the content lane's UI catalog.

### Acceptance tests
`pnpm typecheck` and `pnpm exec vitest run tests/ui/controls.test.ts --maxWorkers=2`: passed (10 tests). `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm exec playwright test --config tests/ui/browser.config.ts --workers=1`: passed (2 tests, 6.3s). Production mounting remains separate render-integration work.

### Contract changes
None authored in shared simulation files; shared requests are listed above.
