# Private multiplayer foundation validation

Core: `f471347`, simulation version 5, protocol version 1. This adds private free-roam rooms;
it does not complete Bot Sweep or change the world-continuity gate's status.

## Passed

- TypeScript check, including `server/`.
- 57 tests across eight files: relay protocol, real loopback sockets, client prediction,
  scheduler, world identity, backpressure, keyboard focus and existing browser-harness tests.
- Two simulated minutes of two-client play with up to 100 ms jitter, delayed input, intentional
  client-state corruption and an invalid snapshot. Both clients end at the exact server hash;
  prediction stays at eight ticks or fewer, and retained history stays at 7,200 frames.
- Real sockets reject chat/state injection, spoofed player IDs, invalid/version-mismatched
  input, a fifth player, expired codes, excessive messages, oversized frames and unapproved
  origins. World-load failures do not reveal server filesystem paths.
- Chromium with SwiftShader, two separate contexts: create/join, remote driving, two-player
  roster, leave and rejoin, no page errors. Passed in `dev` (26.9 s) and real `sf` (1.6 min).
  The SF flow verifies browser/server agreement on the loaded city fingerprint.
- Firefox and WebKit: all eight cross-engine pure-simulation checks passed in 36.6 s.
  Each engine matches Node for deterministic math/state hashing and multiplayer replays
  in dev (3,600 ticks), dev-city (1,200 ticks) and SF (900 ticks). This does not test the
  relay or rendered multiplayer UI in those engines.
- Static build: 158 files, 170.9 MB, within the current 450-file / 240 MB host budgets.
  A separate Chromium smoke check joined a private SF room through the packed frontend
  and live relay without page errors.
- Container built as `fog-city-relay:local`; non-root runtime answered `/health` and completed
  a real private-room WebSocket handshake with simulation version 5. The temporary container
  was stopped after verification.

Commands (repository root, with the environment's pinned pnpm/Corepack cache):

```sh
NODE_OPTIONS=--max-old-space-size=8192 flock /workspace/.cache/fog-city-heavy.lock \
  corepack pnpm typecheck
NODE_OPTIONS=--max-old-space-size=8192 flock /workspace/.cache/fog-city-heavy.lock \
  corepack pnpm exec vitest run tests/net tests/server/net tests/e2e/harness.test.ts --maxWorkers=2
PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright \
  NODE_OPTIONS=--max-old-space-size=8192 flock /workspace/.cache/fog-city-heavy.lock \
  corepack pnpm run e2e:net
MULTIPLAYER_WORLD=sf PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright \
  NODE_OPTIONS=--max-old-space-size=8192 flock /workspace/.cache/fog-city-heavy.lock \
  corepack pnpm run e2e:net
docker build --secret id=build-ca,src="$NODE_EXTRA_CA_CERTS" \
  -f server/deploy/Dockerfile -t fog-city-relay:local .
```

The browser screenshots are local QA outputs:
`test-results/multiplayer-two-players.png` and
`test-results/multiplayer-sf-two-players.png`.

## Limits and remaining work

The full repository/world gate is not asserted green; inherited failures are recorded in
`2026-10-23-integration-status.md`. No benchmark or real-hardware frame-rate claim is made.
Firefox/WebKit multiplayer browser flows were not run; Chromium was used for the two-context
integration proof. The pure-simulation checks ran in both other engines using the unchanged
pinned Playwright binaries. Required Debian libraries were extracted into the workspace
after verification against authenticated APT metadata; no system installation or TLS/signature
bypass was needed. Runtime instructions: `/workspace/.cache/browser-libs/README.md`.

No external deployment, paid service, account system, persistence, public matchmaking, chat,
AI proxy or Bot Sweep objective framework is included. Room codes grant private-session access
and expire after 30 minutes. Production hosting and AI handling remain owner decisions.

Minimal `src/main.ts`, keyboard and Vite hooks are separated for Lane R/Lane 7 review, as listed
in `docs/parallel/status/modes-online.md`. The existing offline workflow is retained.
