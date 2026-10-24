# Fog City relay

The multiplayer server for online Bot Sweep: private invitation rooms of up to four players, an
authoritative 60 Hz input relay keyed by player id, and the same deterministic sim the browser
runs. Nothing is deployed anywhere by this repository; choosing a host is the owner's decision.

## Run it locally

```bash
pnpm install
pnpm relay                      # listens on 127.0.0.1:8787, WebSocket path /relay, GET /health
pnpm dev                        # in another terminal
# open http://127.0.0.1:5173/?world=sf&relay=ws://127.0.0.1:8787/relay
```

`?relay=` accepts only a relay on this machine (loopback), so a shared link can never send a
player's inputs to someone else's server. A real deployment builds the URL into the page.

## Point the static game at a hosted relay

`RELAY_URL` is read at build time (`vite.config.ts` defines `__FOGCITY_RELAY_URL__`):

```bash
RELAY_URL=wss://relay.example.com/relay pnpm build     # dist/ now shows "Play with friends"
```

Remote relays must use `wss://`. Without `RELAY_URL` (the default) the build has no lobby and the
game boots and plays single-player exactly as before. Set the relay's `ALLOWED_ORIGINS` to the
page's origin, or browsers on that page are refused.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listening port (hosts usually set this). |
| `HOST` | `127.0.0.1` | Interface; the Docker image uses `0.0.0.0`. |
| `ALLOWED_ORIGINS` | (none) | Comma-separated page origins allowed to connect, e.g. `https://game.example`. Loopback pages are always allowed. |
| `CLIENT_IP_HEADER` | (none) | Trusted proxy header holding the client IP (`fly-client-ip`, or `x-forwarded-for`, whose last entry is used). Unset: the socket address. Only set it behind a proxy that overwrites the header. |
| `RELAY_WORLDS` | `sf` | Worlds served; each is loaded once at boot from `PUBLIC_ROOT/tiles/<world>/`. |
| `PUBLIC_ROOT` | `public` | Where the tiles are. |
| `RELAY_MAX_ROOMS` | `16` | Rooms on this relay (lobbies cost almost nothing). |
| `RELAY_MAX_MATCHES` | `2` | Matches running at once; a start past it gets "every arena is busy" and stays in the lobby. Size it from Capacity below. |
| `RELAY_MAX_CONNECTIONS` | `128` | Sockets on this relay. |
| `RELAY_MAX_CONNECTIONS_PER_IP` | `8` | Sockets per client IP. |
| `RELAY_MAX_ROOMS_PER_IP` | `2` | Open rooms created per client IP. |
| `RELAY_MATCH_SECONDS` | (12 min) | A shorter Bot Sweep clock, for test servers. |
| `METRICS_TOKEN` | (none) | When set, `GET /metrics` needs `Authorization: Bearer <token>` (a Fly secret, never in `fly.toml`). |
| `RELAY_DRAIN_SECONDS` | `90` | On SIGTERM, how long running matches may play on before they are ended (and paid out). |
| `RELAY_DB_PATH` | `:memory:` | SQLite file for match history, stats and leaderboards (`/data/relay.sqlite` on the Fly volume). In memory, nothing survives a restart. |

Fixed limits (`server/net/server.ts`, `server/net/room.ts`): messages are at most 4 KB and parsed
into closed shapes; 150 messages a second per socket and 600 per IP; 20 failed join attempts per
IP per minute (invite-code guessing); a socket must join within 15 s; an idle lobby socket closes
after 60 s, a match player who sends no input for 45 s is disconnected; a disconnected seat is
held 2 minutes for a rejoin; rooms live at most 2 hours, and results stay 10 minutes.

`GET /rooms?world=sf` lists public rooms (code, mode, phase, players, bots, max) and the number of
connected sockets; private rooms are never listed. It sends CORS headers only to allowed origins.

`GET /health` returns `{ ok, draining, rooms, connections, worlds, mismatches, snapshots, refused,
rateLimited, invalid }`. `mismatches` counts clients whose state hash differed from the relay's
(each gets one snapshot); it should stay 0.

## Operations

- **Liveness and readiness.** `GET /health` is 200 while the process runs. `GET /ready` is 200,
  and 503 while draining, so the proxy stops sending new players to a machine that is restarting.
- **Metrics.** `GET /metrics` is Prometheus text (`fogcity_relay_*`): rooms by phase, connections,
  seated players and spectators, rooms and matches created/started/finished, refusals (origin,
  caps, rate limits, `matches_refused_total`), hash mismatches, snapshots and dropped inputs,
  per-room tick time (`tick_ms_p50/p99`), the whole relay tick across all rooms (`loop_ms_p50/p99`,
  `loop_overruns_total`), `ticks_total` (60 a second when keeping up), CPU seconds, RSS and heap.
  Alert on `rate(ticks_total) < 58` or `loop_ms_p99 > 16`: the machine is over capacity and every
  match is running slow. Set `METRICS_TOKEN` to keep it private.
- **Logs.** One JSON object per line on stdout (errors on stderr): `{ ts, level, event, ... }`. Events: `world.loaded`,
  `store.opened`, `relay.listening`, `room.created`, `match.started`, `match.finished`,
  `room.closed`, `upgrade.refused`, `socket.rate_limited`, `store.record_failed`, `drain.start`,
  `drain.done`. Room codes appear only as their first two characters (enough to correlate lines, not to join); seat tokens, device
  tokens and IPs are never logged.
- **Restarts (deploys).** SIGTERM starts a drain: new players and rooms are refused (`draining`;
  rejoining a held seat still works), every client gets a notice with the end time ("Server
  update: the match ends in N s, you keep your payout"), running matches play on for up to
  `RELAY_DRAIN_SECONDS`, then each is ended as a recorded `mode.end` decision, so results and
  payouts happen exactly once and are written to the store, then the relay closes. `fly.toml`'s
  `kill_timeout` is longer than the drain. A second signal or SIGINT stops at once. A crash or
  hard kill loses the running matches only: nothing was paid yet, and the city saves in each
  browser were made at match start.

## Capacity

`pnpm relay:load [rooms...]` (`server/load/load-test.ts`) forks the real relay on the SF world in
its own process, fills each room with four headless clients that send 60 inputs a second and count
frames, and reads `/metrics`. Bot Sweep, 20 s per level, on one 2.1 GHz Xeon vCPU (the cloud
sandbox; 2026-10-24):

| Rooms | Players | Relay ticks/s | Loop p50 ms | Loop p99 ms | Room tick p50 ms | Relay CPU (one core = 100%) | RSS | Slowest client frames/s |
|---|---|---|---|---|---|---|---|---|
| 1 | 4 | 60.0 | 6.36 | 15.13 | 6.36 | 60% | 869 MB | 60.1 |
| 2 | 8 | 60.0 | 9.98 | 21.28 | 5.87 | 92% | 1231 MB | 60.0 |
| 3 | 12 | 55.8 | 12.02 | 32.14 | 4.97 | 106% | 1510 MB | 55.9 |
| 4 | 16 | 47.4 | 13.46 | 45.96 | 4.09 | 112% | 1504 MB | 47.5 |
| 6 | 24 | 26.9 | 14.88 | 64.09 | 4.64 | 113% | 1507 MB | 27.3 |
| 8 | 32 | 20.3 | 16.06 | 69.18 | 4.81 | 110% | 1509 MB | 20.7 |

What it means:

- **The relay is one event loop, so it is bound by one core.** Each running match costs about
  5 ms of every 16.7 ms tick (the full sim: 120 robots, agents, combat), so one core runs **2
  matches (8 players) in real time**. At 3 the relay falls behind and every match slows. Hence
  `RELAY_MAX_MATCHES=2` by default. Lobbies, spectators and the HTTP endpoints are cheap.
- **Memory.** About 0.9 GB for the loaded world, plus about 0.3 GB per running match, levelling off
  near 1.5 GB as the heap is reused. 2 GB holds two matches with headroom.
- **Per machine size (Fly).** Extra vCPUs do not add matches until rooms run on worker threads
  (the follow-up below). `performance-1x` (1 dedicated vCPU, 2 GB) holds 2 matches.
  `shared-cpu-*` machines get only a fraction of a core sustained and are throttled once their burst
  credit is spent: expect 1 match or fewer, so do not use them for the relay. `performance-2x`
  (4 GB) costs twice as much and today still runs 2 matches; it is worth it only with worker threads
  (about 2 matches per vCPU, so about 4).
- **Scaling out** means more machines, but a room lives on the machine that created it. Before
  `max_machines_running` > 1, room codes need a machine prefix and the relay needs to answer joins
  for another machine's room with `fly-replay`. Until then, run exactly one machine
  (`fly.toml`) and raise capacity with worker threads.
- Re-run the load test on the target machine (`fly ssh console`, then `node server/load/load-test.ts`)
  before changing `RELAY_MAX_MATCHES`: if `Relay ticks/s` stays at 60 and `Loop p99` is under
  about 25 ms, that many matches fit.

## Data and retention

The relay keeps only what the leaderboards need, in SQLite (`server/store/sqlite.ts`, behind the
`RelayStore` interface in `server/store/store.ts` so the backend can be swapped):

- **Identity:** the SHA-256 of each device's random guest token. The token itself is never stored
  or logged and never shown to anyone; nothing ties it to a person.
- **Personal data:** only the display name, which is composed from the game's vetted name parts
  (never free text), and the chosen look (a colour preset). No email, IP address, account or chat.
- **Match history:** finished matches (mode, world, start/end, reason) and each person's name,
  look, team, score and win. Bots are never recorded. Kept **90 days**, then deleted.
- **Per-identity totals:** matches, wins, best and total score per mode. Deleted with the
  identity after **365 days** without a match.
- **Leaderboards:** best single-match score per mode, this week (Monday 00:00 UTC) or all time;
  names and looks only.
- Pruning runs at boot and every 6 hours. Clearing a device's local storage starts a new identity;
  the old one ages out under the same rules.

`GET /leaderboard?mode=botSweep&period=week|all` returns the top 10; `GET /me` with the header
`x-fogcity-device: <token>` returns that device's own totals. Both are capped at 30 requests per IP
per 10 s and send CORS headers only to allowed origins.

## How a match works

- **Transport.** `src/net/transport.ts` is the seam: the game uses a WebSocket to this relay;
  tests run the relay in-process on loopback and can pass any transport with the same semantics.
- **Quick play.** `quick` puts the player in the fullest open public lobby for that world, or opens
  a new public room. The host can add bot teammates (deterministic, in the sim; people always take
  precedence for seats) or start alone as solo practice.
- **Lobby.** `create` makes a private room with an 8-character code from a CSPRNG; `join` takes a seat
  (`p1`…`p4`) with a generated name (never free text) and a secret rejoin token the page keeps
  in `sessionStorage`. Everyone readies up; the host (lowest seat) starts.
- **Version checks.** The hello carries the protocol version, `SIM_VERSION` and a fingerprint of
  the world's simulation files; any difference is refused with a message telling the player to
  refresh.
- **Match.** The relay builds a Bot Sweep instance on one of the approved district arenas
  (`content/modes/instances.json`; checked at boot for a full team's clear spawn) and steps it at
  60 Hz with each seat's queued controls (neutral when none). Joins, leaves and the host's
  "end match" are `SimEvent`s with their tick. Every client steps the same frames; a hash once a
  second detects divergence and only then is a snapshot sent (also to a rejoining or badly
  lagging client). Clients predict only their own body.
- **Results.** Payouts (XP and capped cash, `src/sim/modes/match.ts`) carry settlement ids
  `<matchId>:<playerId>`; the page credits the city once per id and saves at once, so a reload
  cannot pay twice.

## Deploy (when a host is chosen)

The image (`server/deploy/Dockerfile`) contains the sim source, the relay and the SF world's
simulation files (about 37 MB; no models). It needs about 1 GB of memory for the world and one
dedicated core for every two running matches (Capacity).

```bash
docker build -f server/deploy/Dockerfile -t fog-city-relay .
docker run --rm -p 8787:8787 -e ALLOWED_ORIGINS=https://your-game.example fog-city-relay
```

| Host | Fit |
|---|---|
| Fly.io (chosen) | Long-lived WebSockets, Docker, one always-on machine: `fly.toml` at the repository root. |
| Render | Good: Docker web service with WebSockets. Example: `server/deploy/render.yaml.example`. |
| Any VM / container host | Good: run the image behind TLS (Caddy, nginx) that forwards WebSocket upgrades. |
| Cloudflare Durable Objects | Needs a port: the relay runs the full Node sim and loads a ~0.9 GB world, above a Durable Object's memory limit. |
| Vercel | Not suitable for the relay: functions cannot hold WebSocket connections. Fine for the static game. |

On Fly.io (the owner's choice): `fly launch --no-deploy --copy-config` (keeps `fly.toml`), set
`ALLOWED_ORIGINS` in `fly.toml` or `fly secrets`, `fly deploy`, then build the static game on Vercel
with the project environment variable `RELAY_URL=wss://<app>.fly.dev/relay`.

After deploying: set `ALLOWED_ORIGINS` (and `CLIENT_IP_HEADER` behind the host's proxy), check
`GET /health`, rebuild the static game with `RELAY_URL=wss://<host>/relay`, then run the
multiplayer smoke test against it.
