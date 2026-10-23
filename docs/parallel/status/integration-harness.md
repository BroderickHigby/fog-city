# Integration harness

## Now
Preparing independent verification on `lane/harness/wave2` from immutable physical-kernel checkpoint `b7c412c`. The original `/workspace/fog-city` prototype and other lanes' worktrees are untouched. Full gameplay composition and its renderer consumer are still being prepared.

## Done
- Read the repository, ownership, deterministic simulation and memory rules.
- Reviewed the existing browser/replay harness and the visible integration's main-loop adapters.
- Identified two integration gates: browser replay must use the same registered gameplay systems as the game; Node/browser world loaders must both load the manifest's gameplay metadata.
- Reported those gates to Core and UI. No full-suite result is claimed.

## Next
1. Merge the immutable composed core and render checkpoints into this isolated worktree.
2. Adapt the replay helpers to use the same pure runner and the same world metadata.
3. Verify first purchase, startup form and Hot Desk/Spill with real controls or recorded input frames. Do not mutate debug state or teleport the player to satisfy an objective.
4. Verify protected water targets and vehicle-person clearance, command ownership and replay consistency.
5. Run typecheck, full unit tests and browser tests once the integrated snapshot is stable; retain failure artifacts and exact environment limitations.

## Blocked on
- Core's final composition checkpoint after the validated physical kernel.
- UI's committed renderer/main consumer of that composition.
- Firefox and WebKit are not installed in the current executor; Chromium is available at `/usr/bin/chromium`. Any missing-engine limitation will be reported rather than treated as a pass.

## Requests for other lanes
- Core: publish one immutable pure gameplay runner or system factory used by browser and replay.
- UI: publish the matching main-loop checkpoint and expose a read-only log of recorded UI commands for replay validation.
- Render/UI: load the gameplay manifest data in the browser and include it in the packed web build.

## For the owner
This is verification work in an isolated checkout. No release branch or protected integration branch is being modified.

## Draft pull request
Base: `integrate/wave2`

Title: `Harness: verify integrated gameplay controls and deterministic replay`

Body:
Adds independent integration checks for the registered gameplay runner, UI commands, mission progression and safety invariants. Replays use the same world metadata and simulation composition as the running browser. Final acceptance results and any unavailable-engine limitations will be recorded here after the integrated snapshot is tested.
