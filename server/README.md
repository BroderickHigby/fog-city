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
| `RELAY_MAX_ROOMS` | `16` | Rooms on this relay. |
| `RELAY_MAX_CONNECTIONS` | `128` | Sockets on this relay. |
| `RELAY_MAX_CONNECTIONS_PER_IP` | `8` | Sockets per client IP. |
| `RELAY_MAX_ROOMS_PER_IP` | `2` | Open rooms created per client IP. |
| `RELAY_MATCH_SECONDS` | (12 min) | A shorter Bot Sweep clock, for test servers. |

Fixed limits (`server/net/server.ts`, `server/net/room.ts`): messages are at most 4 KB and parsed
into closed shapes; 150 messages a second per socket and 600 per IP; 20 failed join attempts per
IP per minute (invite-code guessing); a socket must join within 15 s; an idle lobby socket closes
after 60 s, a match player who sends no input for 45 s is disconnected; a disconnected seat is
held 2 minutes for a rejoin; rooms live at most 2 hours, and results stay 10 minutes.

`GET /health` returns `{ ok, rooms, connections, worlds, mismatches, snapshots, refused,
rateLimited, invalid }`. `mismatches` counts clients whose state hash differed from the relay's
(each gets one snapshot); it should stay 0.

## How a match works

- **Transport.** `src/net/transport.ts` is the seam: the game uses a WebSocket to this relay;
  tests run the relay in-process on loopback and can pass any transport with the same semantics.
- **Lobby.** `create` makes a room with an 8-character code from a CSPRNG; `join` takes a seat
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
simulation files (about 37 MB; no models). It needs about 1 GB of memory for the world plus
roughly a third of a CPU core per live match.

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
