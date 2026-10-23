# Modes & online status

## Now

Reviewing a private free-roam relay prototype on the coordinator's `codex/fog-city-multiplayer`
branch, against the combined simulation version 5. This is working ahead under Lane 6's
prototype permission; it is not the completed wave-4 Bot Sweep deliverable or a wave merge.

## Done

Core implementation: `f471347`. The minimal browser integration is the separate coordinator
commit containing this status file, for Lane R and Lane 7 to review independently.

- Input-only WebSocket protocol; four-player invitation rooms with 30-minute codes and
  generated names; bounded queues, messages, connections and rooms; heartbeat cleanup.
- Authoritative 60 Hz simulation, recorded join/leave events, per-second hashes/snapshots,
  at most eight predicted ticks, acknowledgement-based replay and divergence recovery.
- SHA-256 world identity works on plain HTTP LAN addresses as well as secure origins.
- Loopback tests cover remote movement, leave/rejoin, fifth-player and expired-code refusal,
  malformed/oversized/flooded messages, spoofed players, bad input sequences and origin checks.
- Two simulated minutes with 100 ms input/delivery jitter converge exactly after deliberate
  client divergence and a corrupt snapshot. The scheduling test measures exactly 7,200 ticks
  over two minutes and caps catch-up after a stalled timer.
- Separate coordinator integration hooks provide a minimal lobby and two-browser proof;
  these are proposed to their owning lanes rather than a replacement for their UI work.

Validation: 57 network/control/harness tests pass; private rooms pass two-context Chromium
flows in both `dev` and real `sf`; the container builds and its health/room handshake pass.
Evidence: `docs/qa/2026-10-23-multiplayer-foundation.md`. No new simulation fields, event kinds
or SIM_VERSION changes.

## Next

- Lane 2 independent review, including rebase to its wave-2 interface when available.
- Build the match framework, carry-in/out, Bot Sweep timer/lives/revive/Update Relay, excluded
  areas and mode drivers once the owners' contracts exist.
- Follow the roadmap for public modes, accounts, reporting/mute/block and age policy; none of
  those are supplied by this private-room prototype.

## Blocked on

- **Owner:** hosting provider, region, budget and deployment authorization before hosted play.
- **Owner:** AI provider/key and spending/retention policy before any live AI routes; this
  prototype uses no paid services or secrets.
- **Lane 2:** match/state extension interfaces and wave-2 simulation integration.
- Lane 2 has published the schema-6 interface on `lane/core/wave2` (`9a6a107`). Its status
  explicitly reserves the QA/dodge migrations for integration. This prototype stays on the
  verified schema-5 base until those migrations are combined by the integrating lane. When
  adopting schema 6, update the closed network input validator for its optional aim fields
  and re-run world identity, replay and browser convergence checks; do not silently accept
  a different simulation version.
- The inherited world/ballpark regeneration and other world QA defects remain tracked in
  `docs/qa/2026-10-23-integration-status.md`; the relay does not waive their gate.

## Requests for other lanes

- **Lane R — `src/main.ts`:** retain `localPlayerId` rather than assuming `p1`; the relay's
  `onState(state, id)` callback replaces the rendered state and updates the followed player;
  render all IDs already present in state. `onDisconnect` restores the saved solo state. These
  minimal hooks are isolated from the server commit for review. No model or world edits.
- **Lane 7 — lobby:** `src/net/client.ts` exports `RelayClient`. Construct it with the loaded
  world, world name, SHA-256 from `worldFingerprint(files)`, and `onState/onStatus/onDisconnect`.
  Call `connect(sameOriginWebSocketUrl, optionalCode)`, `sample(input)` and `disconnect()`.
  `ConnectionInfo` supplies safe names, room code, connection state and player ID. The small
  `src/net/lobby.ts` menu is a testable placeholder for Lane 7's designed lobby/nameplates.
- **Lane 7 — `src/input/keyboard.ts`:** `release()` on lobby focus/blur clears held keys and
  one-shot actions. A form must not swallow keyup while leaving movement stuck.
- **Coordinator — package/config:** pin the listed dependencies, include `server` in typecheck,
  proxy `/relay` from Vite using `RELAY_URL`, and run the dedicated net browser config. These
  package/config edits are integration necessities, not ownership of other lanes' features.

## For the owner

Local/LAN free roam is the validated scope. The relay is memory-only, invitation-based and
serves no public matchmaking or chat. Do not treat the prototype as public-service readiness.
See `docs/multiplayer.md` for commands and deployment boundaries.
