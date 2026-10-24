# Multiplayer stream status

**All checks pass (2026-10-23):** the two-browser e2e against a locally started relay, the relay
abuse-limit tests, the mode/protocol unit tests and the full unit suite; single-player boots
cleanly with no relay. Ready for the coordinator to set up Fly.io (`fly.toml`, `server/README.md`).
Host decision received: relay on Fly.io; the earlier Vercel-Functions/SSE transport request was
withdrawn and is not built.

Stream id `multiplayer` · handoff §7 · branch `work/multiplayer/relay-lobby-botsweep` (from `origin/integrate/wave2` `ff7db5b`).

## Next PRs (owner direction via coordinator, in order)

1. Quick play / matchmaking — `work/multiplayer/quick-play` (stacked on #32): "Play online" joins
   the fullest public lobby or opens one; public room list (`GET /rooms`) with player counts;
   host-added deterministic bot teammates; solo practice.
2. More modes — Clean Streets: `work/multiplayer/clean-streets` (stacked on quick play): host picks
   the mode; two teams race on the BotBounty board for 8 minutes; flowers (alt-fire, B) are a
   mode-local mechanic until combat has its own flower attack; bots join the smaller team.
3. Player identity · 4. Server persistence · 5. Social · 6. Ops readiness.

## What is playable now

Online **Bot Sweep** (co-op, 1–4 players) end to end in the browser, against a relay started
locally with `pnpm relay`:

- **Lobby** (`src/ui/multiplayer.ts`): "Play with friends" → create a private room (8-character
  code) → copy invite link (`?room=CODE` prefills the code) → join → ready up → the host starts.
  Leave/cancel at any point returns to the city.
- **Match**: the relay builds a Bot Sweep instance (121 robots incl. 10 + 4/player beta units and
  the Update Relay) on one of the approved district arenas and runs it at 60 Hz. Every browser steps
  the same frames; it predicts only its own body. The city is not stepped during a match.
- **Rejoin**: a reload or dropped connection rejoins the same seat (same player id) with a
  snapshot; automatic reconnect with backoff; a seat is held 2 minutes.
- **Resync on mismatch only**: a hash once a second; a snapshot goes only to a client that reports
  a mismatch (or falls >10 s behind, counted separately). `/health` exposes the counters.
- **Results**: host "End match", the 12-minute clock, a full sweep, or lost lives. Payouts (XP +
  capped cash) are credited to the city **once** per settlement id and saved straight away;
  a reload in the results restores the city autosave and does not pay again.
- **No relay configured** (default build): no lobby, the game boots and plays single-player.

Evidence (this checkout, Chromium SwiftShader, `flock /tmp/fog.lock`):

- `tests/e2e/multiplayer.spec.ts`: 2 passed (7.4 min) — two browser contexts, real relay process,
  lobby/invite/join/ready/start, both directions of driving seen by the other browser, mid-match
  reload/rejoin, zero mismatches, host end, payout once, reload in results ("already paid"), back
  to city; and the no-relay boot.
- `tests/server/net/relay.test.ts` (19, loopback ws): lobby, host/ready rules, version and world
  refusal, exact-hash agreement, **exactly one** snapshot per injected divergence (JSON transport),
  rejoin keeps ownership, grace expiry records a `player.leave`, payouts persist and repeat on
  rejoin, clock finish, idle kick; abuse: per-IP sockets, rooms per IP and per relay, message
  floods, oversized/binary/malformed/spoofed messages, invite-code guessing, origins and path.
- `tests/sim/modes/*` (35) and `tests/net/protocol.test.ts` (4).
- Full unit suite: 3,324 passed, 1 skipped (existing opt-in), after the docs row fix.

## PR #20 review findings

1. Snapshots only on mismatch — done (no periodic snapshots; per-seat rate limit; counted).
2. Per-IP caps — sockets, rooms, messages, failed joins; relay-wide room/connection caps; hard room
   lifetime; idle match players disconnected; lobby idle timeout.
3. Exact-count resync test — `relay.test.ts` asserts mismatches === 1 and snapshots === 3, over
   real JSON on loopback sockets.
4. Payouts persist — the settled session keeps its payouts; settlement ids are applied once into
   `economy.settledModeIds`, which the save already carries.
Low: name-rejection now uses generated names only; command ids go through
`gameplayCommandFromEvent`; `.dockerignore` added; e2e is a `*.spec.ts` that runs in `pnpm e2e`.

## Decisions (made autonomously, recorded here)

- **Bot Sweep** is the released mode: the most finished salvage (`lane/mode-arena/wave5`
  `playable.ts`), co-op so no PvP balance is needed. Clean Streets / Royale / Crowd / Vibes stay
  on their branches.
- The match composition drops the city-only reducers (missions, activities, heat, economy): no
  campaign scenes or wallet inside a match.
- Arenas: the five approved instances; the relay keeps those that build a full roster *and* where
  a full team's cars can drive ≥10 m (it also picks the best of eight spawn headings). Marina
  currently fails that check and is skipped. No robot is placed within 25 m of the team spawn.
- Full-sim prediction costs ~5 ms per tick, so clients predict only their own body with core
  movement; everything else is the confirmed state.
- Settlement is a host-side transform of the paused city (like `restoreProgression`), not a
  SimEvent: the free-roam city is never stepped during a match. It uses the existing save field
  `wallet.settledModeIds`.
- `RELAY_URL` is a build-time define; `?relay=` accepts loopback only.
- Fingerprint = sim FNV hash over SIM_VERSION, spawn, tile ids/stats, boundary, refills and
  sidewalk counts (cheap in every browser; not a security boundary).

## Contract / version

- No change to `src/sim/contract.ts` or schemas, and **no SIM_VERSION bump of its own**: city
  states and replays step identically (the modes system is inert outside a match instance); match
  states are new and checked by `SIM_VERSION` + `NET_VERSION` in the hello. Merged with the base at
  `86dfb90`, which is at SIM_VERSION 10 (weather); matches now run the weather reducer too.

## Transport seam

`src/net/transport.ts`: `RelayTransport` / `ConnectTransport`; `webSocketTransport` is the default
for the game; `RelayClient` takes `transport` so tests can substitute one.

## Edits outside my areas (hook-up lines)

- `src/main.ts`: mount the lobby; draw the relay match instead of the city while one runs
  (render variables `shown`/`shownPrev`/`me_`); `restoreSave` extracted for autosave restore.
- `src/sim/game-systems.ts`: additive `agents`, `combat`, `modes` options (defaults unchanged).
- `vite.config.ts`: `define __FOGCITY_RELAY_URL__` from `RELAY_URL`.
- `fly.toml` (repository root), `.dockerignore`.
- `tsconfig.json`: include `server`. `package.json`/lockfile: `ws@8.22.0`, `@types/ws@8.18.2`, `pnpm relay`.
- `docs/testing.md`: one row for `multiplayer.spec.ts`.

## Not done / needs the owner

- **No deployment** (by instruction). Fly.io is chosen: `fly.toml` + `server/deploy/Dockerfile`;
  env vars in `server/README.md` (`ALLOWED_ORIGINS`, `CLIENT_IP_HEADER=fly-client-ip`, limits);
  the Vercel static build needs `RELAY_URL=wss://<app>.fly.dev/relay`. The Docker daemon is absent here: the image's file set was reproduced and
  booted instead (same world fingerprint as the browser).
- Not exercised in a browser: real WAN latency/packet loss (the client flow control, catch-up
  budget and "behind" snapshots cover slow devices; SwiftShader runs ~10 sim ticks/s and the e2e
  passes through those paths).
- Loadouts are not carried into matches yet (everyone plays the default loadout); faction clock
  moves wait for the Doom Clock. Nameplates and an arena-edge visual are render work (Lane R).
- Gameplay stream: if you land a different settlement path (held `applyModeSettlements` on
  `lane/sim-player/settlement-order`), route it through `src/sim/modes/settlement.ts` or tell me.
