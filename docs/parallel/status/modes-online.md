# Lane 6: Modes & online

## Now
Building `lane/modes-online/wave4` from the published core interface (`9a6a107`) in `/workspace/fog-city-modes`. The user's request authorizes the remaining lanes. The original prototype and existing network branch are preserved.

## Done
- Inspected the lane handoff, match rules and prior relay implementation.
- Reused only owned server/network files from `codex/fog-city-multiplayer` (`b788d11`, original foundation `f471347`), with the reviewed room-reconnect correction. Unrelated QA/render/history is not imported.
- Adapted closed network controls to the shared wave-2 actions and optional finite aim. Legacy lobby UI stays with the UI lane.

## Next
Complete Bot Sweep's isolated match state and carry rules, connect a provider-driven simulation runner, validate the relay against the published core, then implement the later modes and server boundaries on stacked wave branches.

## Blocked on
- Core owns dependency pins and shared gameplay commands. Existing reviewed relay needs `ws`, its types and the shared SHA-256 package.
- Hosted deployment and live AI provider/key selection remain owner decisions. No paid service, secret or external deployment is being used; local/solo work continues.

## Requests for other lanes
- Core: publish gameplay commands and a shared authoritative runner usable by server and prediction; add reviewed network dependencies and include server files in typecheck.
- Agents: provide match robot factories and bots through the same movement/clearance path as human players.
- Combat: Update Relay needs the equivalent of 0.2 starting-stream rust rate so it lasts 20 seconds; shared resistance metadata is requested from core.
- Player: carry in loadout/unlocks; carry out only XP, capped cash, achievements and one winning-faction clock move. Do not mutate the saved free-roam simulation during a match.
- UI: use `RelayClient` and stable mode/lobby state; all typed input and names stay behind the shared text gates.
- Content: provide instance polygons, mode strings, safe generated names and score tables with stable IDs.

## For the owner
No hosting or AI spending is proposed. Local matches and the loopback-tested relay are implemented before any deployment decision.

## Draft pull request
Base: `integrate/wave4` when published; interim stack base is the current core interface.

Title: `Modes: add isolated Bot Sweep matches and the reviewed private relay`

### Summary
Adds deterministic match state and private invitation rooms without changing the saved free-roam world. Reuses the existing bounded relay and adapts its controls to the shared interface.

### Roadmap deliverables
- [ ] Match carry rules, Bot Sweep objectives/lives/revive and allowed instances.
- [ ] Authoritative relay and client replay with the same gameplay runner.
- [ ] Loopback validation and headless match drivers.

### Acceptance tests
Pending implementation checks. Previous network evidence is documented on the source branch and is not treated as verification of this integration.

### Contract changes
Shared changes are requested from core; this lane edits only its owned areas.

### Requests for other lanes
See the exact integration requests above.

### For the owner to judge
Local play and deterministic state are the review target. Online deployment remains unconfigured.
