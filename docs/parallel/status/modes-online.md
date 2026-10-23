# Lane 6: Modes & online

## Now
Validated checkpoint: 95 targeted tests across 10 files and full TypeScript check pass. This is the match/relay foundation; integrated browser co-op, later modes and live provider deployment are still pending.

Building `lane/modes-online/wave4` from the published core interface (`9a6a107`) in `/workspace/fog-city-modes`. The user's request authorizes the remaining lanes. The original prototype and existing network branch are preserved.

## Done
- Inspected the lane handoff, match rules and prior relay implementation.
- Reused only owned server/network files from `codex/fog-city-multiplayer` (`b788d11`, original foundation `f471347`), with the reviewed room-reconnect correction. Unrelated QA/render/history is not imported.
- Adapted closed network controls to the shared wave-2 actions and optional finite aim. Legacy lobby UI stays with the UI lane.

## Next
Complete Bot Sweep's isolated match state and carry rules, connect a provider-driven simulation runner, validate the relay against the published core, then implement the later modes and server boundaries on stacked wave branches.

## Blocked on
- Shared commands and exact dependency pins are published (dependency-only commit `7dcacc1`). Core composition and physical actor adapters are being integrated.
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
- [x] Separate match simulation, allowlisted loadout carry, replay-safe payout IDs, Bot Sweep objectives/lives/revive and Clean Streets scoring.
- [ ] Bind approved instances and real actor rosters to browser match creation.
- [x] Authoritative relay/client replay accept the same injected gameplay runner; closed gameplay commands bind to server-assigned identity.
- [ ] Connect the final core gameplay composition and browser lobby.
- [ ] Loopback validation and headless match drivers.

### Acceptance tests
`pnpm typecheck` passed; 95 tests in 10 files passed, including local WebSocket transport, two-client rollback with jitter, identical driver hashes, command identity/sequence checks, match revival/timers/scoring/carry isolation and deterministic API checks. Full integrated `pnpm verify` remains a final gate.

### Contract changes
Shared changes are requested from core; this lane edits only its owned areas.

### Requests for other lanes
See the exact integration requests above.

### For the owner to judge
Local play and deterministic state are the review target. Online deployment remains unconfigured.

## Validated implementation details

- Bot Sweep requires remaining beta units plus a separate relay; converted units join the objective count. Three-second teammate revival, fifteen-second shared-life respawn and twelve-minute timeout are deterministic.
- Clean Streets uses eight-minute team scoring, penalties and interrupted-update tie-breaks.
- Match deadlines survive skipped global pause ticks. Payout `cashCents` is capped at 7,500 cents per elapsed minute and has a stable settlement ID.
- Rooms remain private, four-player, thirty-minute invitation rooms. Client controls and commands cannot submit player identity, chat, positions or arbitrary simulation events.
- Advanced mode IDs currently fail closed until their rule modules and drivers land.

## Wave 7: Hide in the Crowd rule checkpoint

The standalone `createCrowdState` / `stepCrowd` reducer validates hider and spotter roles, three active tasks, continuous timed interactions, delayed corner pings, six-minute halves, role swaps, limited scans, visible burst/flicker cues, survival points and ten-second replacement requests. A replacement requires a new core-approved body at least150m from Spotters; a melted body cannot be reattached. Pauses stop the logical clock. The movement owner must apply `crowdSpeedLimit`, supply accepted robot bodies and deliver these cues to bot perception. This is not yet a playable browser mode.

Validation: TypeScript plus54tests (6modecases and48deterministic API checks) passed.

Draft PR title: `Modes: implement deterministic Hide in the Crowd rules`
Base: `integrate/wave7` when published; currently stacked on the tested wave4foundation.
Body: Adds task, scan, score, role-swap and reconnect rules for robot-body Hide in the Crowd. Uses observed poses and core-approved replacement bodies; does not permit proximity-only respawn. Browser and bot adapters remain explicit integration gates.
