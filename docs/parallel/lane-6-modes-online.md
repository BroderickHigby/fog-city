# Lane 6: Modes & online

**Lane id:** `modes-online` · **Roadmap tracks:** Sim-Modes (from wave 4), Server-Net (from wave 4), Server-AI (from wave 6) ·
**Branches:** `lane/modes-online/wave<N>`

## Paste-ready prompt
> You are Lane 6, Modes & online, on Fog City (<https://github.com/BroderickHigby/fog-city>). It
> is a browser open-world game of a satirical, near-future San Francisco with a pure,
> deterministic TypeScript simulation that was built multiplayer-ready (inputs keyed by player
> id, outside facts only as recorded `SimEvent`s). Eight lanes are building in parallel. You own
> the match modes, the relay server, netcode and the AI proxy: `src/sim/modes/`, `src/sim/bots/`,
> `server/` (`net/`, `ai/`, `main.ts`, `deploy/`), `src/net/`, `tests/sim/modes/`, `tests/net/`
> and `tests/server/`. Edit nothing else.
>
> Read these first, in order: `CLAUDE.md` (the agent rules apply to you whatever model you are),
> `docs/parallel/README.md`, this file `docs/parallel/lane-6-modes-online.md`, the Sim-Modes,
> Server-Net and Server-AI rows of waves 4 to 8 plus "Decisions the user makes" and "Mode costs at
> a glance" in `docs/roadmap.md`, `docs/design.md` (modes, PvP, safety, the decision log),
> `docs/ai-layer.md`, `docs/handoff.md` and `docs/parallel/status/*`.
>
> Your goal: friends can play together. That means invite-only co-op Bot Sweep, then PvP Clean
> Streets, Fog Royale for 8 and then 24, Hide in the Crowd and Vibes Night. Every mode also runs
> solo against bots, and runtime AI features go through a locked-down server proxy.
>
> Your tracks start in wave 4, so work ahead. Start by creating
> `docs/parallel/status/modes-online.md`. Branch `lane/modes-online/wave4` from
> `origin/integrate/wave2`, or from Lane 2's interface branch.
>
> First, raise two owner decisions in your status file and PR right away:
> - **hosting**, needed before any deploy;
> - **AI key and provider handling** for wave 6.
>
> Then, while waves 2 and 3 are in flight:
> 1. Build the match framework (its own `SimState`, carry-in and carry-out rules, results) and
>    Bot Sweep rules against the design.
> 2. Build the relay as a loopback-tested prototype: invite-only lobbies with 30-minute codes and
>    at most 4 players, server-ordered inputs, client rollback, a headless server sim with
>    per-second hash checks, join and leave as `SimEvent`s, and no chat message types.
>
> Then do waves 5 to 8.
>
> Follow the README for branches, commits, pushes, draft PRs into `integrate/wave<N>` and the
> memory rules. Tests never hit the real network, but loopback servers inside a test are fine.
> Keep no secrets in the repo, and never deploy or spend money without the owner's go-ahead. Push
> at least hourly and keep your status file current.

## What to build, by wave
| Wave | Sim-Modes | Server-Net | Server-AI |
|---|---|---|---|
| 4 | The match framework. Bot Sweep: instance, Update Relay, lives, revive; only outside excluded areas. | The relay: invite-only lobbies (codes expire in 30 min, at most 4 players); server-ordered inputs; client rollback in `src/net/`; a headless server sim with hash checks and snapshots; join and leave as `SimEvent`s; display names from generated parts or the server-side content lint; no chat; a deploy config (a container plus a health check, no secrets); the netcode test. | none |
| 5 | The rival-founder objective planner (reuses the steering follower). Clean Streets, solo against bots and as an online team race. The PvP streak table. | Rooms up to 8. Matchmaking. The global Doom Clock and faction tally. SF-Bench and Daily Standup leaderboards with server re-simulation. Report, mute and block. Invite sign-up accounts with age attestation. An age gate before rooms with strangers. | none |
| 6 | Fog Royale solo: 5 phases, crates, Bridge Round, duel redeploy, against 7 bots. The Fog Front event. The Royale streak table. | Fog Royale online for 8. | The AI proxy: the key as a server secret; one fixed route per feature; closed schemas; sign-in with server-issued sessions; 401 and 403 tests; transcript retention and the notice; Trust & Safety gates; the GPU allocation meter. Routes: freestyle interview, One-Sentence Startup, live Mom. |
| 7 | Hide in the Crowd, solo and online. | Royale for 24. | The live Customer Discovery classifier route. |
| 8 | The Vibes Night party room: 2–8 players, 90 s live demos, roasts, the Vibes Award, a keyed-hash tie-break. | Vibes Night rooms. | The live Vibes Night roasts route, falling back to templates. |

## Done means
- Your rows' acceptance tests pass, including:
  - e2e: two browser contexts join one Bot Sweep lobby;
  - per-second hashes match between the server sim and every client;
  - the proxy refuses a route that has no recorded eval pass;
  - network-blocked AI tests pass;
  - the PvP clearance drivers hold at zero contacts.
- Every mode is playable solo against bots without a server.
- Safety: names shown to other players pass the content lint, there is no free chat, and
  report, mute and block work.

## Hand-offs
- **In:** contract and `ext` keys from Lane 2; agents and knowledge models from Lane 3 for bots;
  the flower alt-fire from Lane 4; progression from Lane 5; lobby, nameplate and Royale HUD UI
  from Lane 7; mode text, eval fixtures and roasts from Lane 8.
- **Out to Lane 7:** lobby, room and leaderboard APIs.
- **Out to Lane 2:** the netcode and soak drivers.
- **Out to Lane R:** remote-player rendering and the spectator camera.
- **Owner decisions:** hosting before wave 4, the AI key and provider before wave 6, and
  anything that costs money.
