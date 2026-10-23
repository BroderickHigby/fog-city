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

Adversarial follow-up: ordinary robot scans now spend charges and return noisy results, so resource changes cannot reveal hidden players. Replacement bodies require confirmed control and every Spotter pose; disappearing bodies reset task channels. Tick-and-ID cursors preserve late same-tick facts. Regression batch: TypeScript and62tests passed (Hide9, Vibes5, deterministic rules48).

## Wave 8: Vibes Night rules

`createVibesState` / `stepVibes` run 2–8 timed three-robot demos, score observed calls/melts/incidents, accept one non-self vote per player, and request a separately authenticated award. `chooseVibesAward` keeps its key server-side and records a match/request-bound winner. Model roasts never affect demo scores or votes. Global cast IDs and per-presenter event windows prevent stale incidents crossing demos. The eight-client headless rule driver completes all90-second demos and voting, including an independently keyed tied vote; pause and replay regressions pass. Browser stage actors and lobby selection remain integration gates.

Draft PR title: `Modes: add Vibes Night demos, voting and keyed award results`
Base: `integrate/wave8` when published; stacked on the reviewed earlier mode rules.
Body: Implements simulation-owned demo scoring, locked votes and server-only keyed ties. Separates presentation roasts from gameplay and binds external award facts to the active match request. Validation: fiveVibes cases passed plus cross-mode/determinism suite.

## Integrated rule adapters

The registered modes system now supports fresh, separate Crowd, Royale and Vibes instances through explicit context providers. Only six named loadout fields cross into a match; financial and unrelated-player fields are dropped. All three modes emit stable settlement IDs only once on completion. Providers still own approved instance geometry, actor casts, authoritative awards, bot controls and confirmed physical attachments.

Adversarial fixes also accept a real bot-associate duel loss immediately, preserve +1/+3 Royale runway rewards above the starting18months, and reject one-founder online wins. Final validation: TypeScript and86tests across7mode/determinism files passed.
# Playable local match integration

Branch: `lane/modes-playable/wave5`.

`createLocalMatch`, `stepLocalMatch` and `localMatchView` provide a fresh Bot Sweep or Clean Streets instance without copying free-roam finances. The actual 120-robot roster and Bot Sweep relay enter through the shared allocator and physical preparation. Clean Streets includes a rival founder driven by visible observations, completed scans, normal movement and flower alt-fire. Respawns use the normal clearance-checked player join path. Finished matches expose stable payout IDs for the profile owner to settle after returning to the saved city state.

The integration rejects excluded areas, arenas without room for every objective, and arenas lacking a reachable authored water refill. An immutable bounded world view suppresses ambient population, clips navigation, constrains physical movement and permits conversions only within the admitted roster. The original city is unchanged. The UI host is in the separate UI lane. Advanced mode rule modules remain separate from this local launcher; this change does not claim playable Royale, Crowd or Vibes integration.

Validation: TypeScript and 111 focused checks pass, including real actor admission, bot exit/movement, arena boundary constraints, deterministic interleaving, return-state isolation, respawn placement, correct flower input and update-interruption attribution. Real-SF boot admits 121 Bot Sweep actors or 120 Clean Streets actors with four usable authored refills; the interleaved replay hashes match. Core performance fixes and AGI pause adaptation are included. Combined UI browser validation is tracked by the UI lane.

Draft PR title: `Modes: connect local Bot Sweep and Clean Streets to physical gameplay`

Draft PR body: Add bounded local arenas, ordinary simulated robot objectives and a perception-driven rival founder. Preserve the saved city, require usable authored refills, return stable settlement IDs and route respawns through core clearance. Fix rival flower input and update-interruption attribution. TypeScript and 111 focused checks pass; real-SF actor admission and interleaved replay pass. Final integrated UI validation is tracked by the UI lane.

## Service admission repair intake

The local-playable branch includes `5e8bf5b` as `e7f08eb`: full service-vehicle hull checks, player foot/car blockers, shared pending-spawn clearance and safe deferred retries. This fixes the second Ferry bus overlap found by the canonical Hot Desk probe without bringing in later threat dispatch, flight or Tidy features.

Validation after intake: TypeScript and **8 files / 39 tests** pass, covering service/transit admission, physical van/bus behavior, local playable matches, session isolation, bounded arenas and Crowd rules. Existing real-SF roster and UI validation above remains separate evidence.

Final convergence intake: `c9b4b98` aligns legacy taxi admission with the drawn `ROBOTAXI_BODY`; `bc30b99` sweeps runtime walkers against every vehicle hull; `50e57fd` settles activity rewards before publishing completion. These are included without later feature expansion.

Final branch validation: TypeScript and **5 files / 19 tests** pass for activity reward ordering, local playable/session behavior, runtime walker clearance and service admission. The earlier pre-order contact batch also passed 27 focused tests. This standalone branch lacks the save host, so its activity regression keeps the real delivery producer, immediate wallet/XP settlement, 120 later ticks and duplicate mode-payout rejection; serialized save/restore proof remains in the combined build.
