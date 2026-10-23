# Private multiplayer foundation

The relay runs the same version-5 deterministic simulation as the browser. It supports private
free-roam rooms for four people. Bot Sweep objectives, progression, public matchmaking, accounts,
chat and production hosting are not part of this foundation. Existing world QA defects remain
tracked in `docs/qa/2026-10-23-integration-status.md`.

## Run locally

Use Node 24 and the pinned pnpm 9.12.0. From the repository root, in two terminals:

```sh
pnpm server
pnpm dev
```

Open the dev server, choose a world (for example `?world=dev`), and open **Play with friends**.
Create a room, then enter its ten-character code in a second browser or private window. Both
players must open the same world from the same build. Share the code only with invited players.
Codes expire after 30 minutes; a fully empty room is reclaimed after five minutes. Leaving and
rejoining gives a new player identity. Progress is memory-only and disappears on server restart.

The default Vite proxy sends `/relay` WebSockets to `ws://127.0.0.1:8787`; override with `RELAY_URL`.
The relay serves `GET /health`. It binds loopback unless `HOST` is set. `PORT` defaults to 8787;
`PUBLIC_ROOT` defaults to `public`. It loads the committed sim data, never a client-supplied path.

For a trusted LAN, bind the relay and Vite to the LAN interface, and set `ALLOWED_ORIGINS` on
the relay to the exact browser origin (for example `http://192.168.1.20:5173`). Connect browsers to
that Vite address; the same-origin proxy carries WebSockets. Do not expose Vite to the internet.
For hosted use, serve the built frontend over HTTPS and reverse-proxy `/relay` to this service
with WebSocket upgrades and an exact `ALLOWED_ORIGINS` allowlist. Hosting remains an owner decision.

## Protocol and limits

- The server checks protocol version, simulation version and a SHA-256 fingerprint of spawn,
  colliders, roads and boundary before joining. Mismatched builds cannot silently desynchronize.
- Joins/leaves are ticked `SimEvent`s. Only the server assigns player IDs, seeds and safe names.
  There are no chat or arbitrary event/state message types.
- Every server tick broadcasts the accepted input frame and acknowledgements. Clients predict
  at most eight unacknowledged ticks, then replay those controls over confirmed server state.
  Every second the server publishes a hash and recovery snapshot; gaps or hash divergence request
  a fresh snapshot. A malformed snapshot is never adopted.
- Input fields must be finite and within their declared ranges. Unknown fields, player spoofing,
  wrong sequence numbers and invalid messages close the connection. A missing input is neutral;
  held movement or one-shot actions cannot persist after disconnect or an inactive tab.
- Messages are capped at 4 KiB, connections at 64, rooms at eight and players per room at four.
  There is a 120-message/second limit, a bounded pending-message queue, an eight-input server
  queue, bounded output buffers, a join deadline and heartbeat cleanup. These limits protect
  this private development relay; they are not a public-service identity or abuse-control system.
- Recent accepted frames are retained in a 7,200-frame memory ring for deterministic debugging.
  No room codes, names, controls or player states are written to logs or disk.

## Checks

```sh
pnpm test:net
NET_STRESS=nightly pnpm exec vitest run tests/net/prediction.test.ts --maxWorkers=1
pnpm e2e:net
MULTIPLAYER_WORLD=sf pnpm e2e:net
docker build -f server/deploy/Dockerfile -t fog-city-relay .
docker compose -f server/deploy/compose.yaml up
```

`test:net` covers real loopback sockets, room limits and expiration, invalid/malicious messages,
disconnect/rejoin, backpressure, and two simulated minutes with up to 100 ms jitter, deliberate
client divergence and corrupt snapshots. The optional `NET_STRESS=nightly` check extends
that to four clients and ten simulated minutes, with explicit per-client recovery and
exact final server-hash agreement. `e2e:net` opens two separate browser contexts and
checks remote movement, visible player lists and leave/rejoin. Install the pinned Playwright
browsers before that check. CI/onboarding environments may need loopback/network permissions.
Keep memory-heavy checks under the single lock described in `docs/handoff.md`.

The container serves the relay only. Compose exposes it on host loopback by default. A frontend
or a TLS reverse proxy remains a separate service; no credentials are baked into the image.
On a development network with a private TLS CA, pass its certificate as a BuildKit secret:
`docker build --secret id=build-ca,src=/path/to/ca.pem -f server/deploy/Dockerfile -t fog-city-relay .`.
The build uses it for dependency verification and does not copy it into the image.
