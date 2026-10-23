# Lane 3: Agents & robots

**Lane id:** `sim-agents` · **Roadmap track:** Sim-Agents, waves 2 to 8 · **Branches:** `lane/sim-agents/wave<N>`

## Paste-ready prompt
> You are Lane 3, Agents & robots, on Fog City (<https://github.com/BroderickHigby/fog-city>). It
> is a browser open-world game of a satirical, near-future San Francisco with a pure,
> deterministic TypeScript simulation. Eight lanes are building in parallel. You own everything
> that walks, rolls, drives or flies on its own, except the player: `src/sim/agents/`,
> `src/sim/robots/` and `tests/sim/agents/`. Edit nothing else.
>
> Read these first, in order: `CLAUDE.md` (the agent rules apply to you whatever model you are),
> `docs/parallel/README.md`, this file `docs/parallel/lane-3-agents.md`, the Sim-Agents row of
> every wave in `docs/roadmap.md`, the robots, people and safety sections of `docs/design.md`,
> `docs/handoff.md` (the dodge design) and `docs/parallel/status/*`. Check out
> `origin/feature/dodge` and read how the person-clearance guarantee works.
>
> Your goal: a living city. People, good robots and disguised bad robots go about their goals;
> Moat Labs vans and Muni buses run; then drones, VC associates, Tidy, the Moat Walker and the
> final boss. All of it is deterministic and keeps the **Crazy Taxi rule**: no vehicle ever
> touches a person, by construction.
>
> Start by creating `docs/parallel/status/sim-agents.md`. Branch from Lane 2's wave-2 interface
> branch, or from `origin/integrate/wave2` once that interface has merged. Build against the stub
> `systems.ts` and `ext` keys. Then do the wave-2 row:
> 1. Migrate people and robots to the sidewalk graph. Use the procedural fallback (offsets from
>    road edges) until Lane 1's graph lands.
> 2. Build the bad-robot brain (`disguised`, `wary`, `alerted`, `attack`, `flee`) with its
>    knowledge model and goal tables.
> 3. Build reactions, the fidelity radius with deterministic handoff, pigeons and leashed dogs,
>    Moat Labs vans answering `threat.spawn`, and timetabled Muni buses.
>
> Then do waves 3 to 8 in order.
>
> Follow the README for branches, commits, pushes, draft PRs into `integrate/wave<N>` and the
> memory rules. Determinism: no wall clock, no `Math.random`, `dmath.ts` only, `sortedIds()`
> iteration, and golden updates explained. Push at least hourly and keep your status file
> current.
>
> The person-clearance override from `feature/dodge` is non-negotiable. Build on it, never
> weaken it. The clearance soak must stay at zero contacts.

## What to build, by wave
Copy the exact deliverables from the Sim-Agents row of each wave in `docs/roadmap.md`. Summary:

| Wave | Deliverables (summary) |
|---|---|
| 2 | Move to the sidewalk graph. The bad-robot brain and knowledge model; good-robot and people reactions. The person-clearance override and collision layer (reuse the dodge). The fidelity radius with deterministic handoff. Pigeons and leashed dogs. Moat Labs vans entering about 120 m from the player via the steering follower. Ambient Muni buses on timetabled routes with ad-wrap slots. |
| 3 | The flying agent type: an ad drone that hovers at 6 m, follows and checks line of sight. Rogue robotaxi box-in. Patrol units with Terms of Service. The swarm. Theft of an empty parked car to a Moat Labs depot, and its recovery. VC associates on scooters and in cars. Tidy hauling heaps, and restore from backup. Sign-spinners. The 3 a.m. firmware freeze. The Tuesday siren. |
| 4 | Recruits that follow and spot. The parrot flock. Conference Week density (lanyard crowds, bad-robot density ×1.5). |
| 7 | The robot-body player controller (gait, burst tell, emotes) for Hide in the Crowd. Merged fidelity radii for 24 players. |
| 8 | The Moat Walker (threat 5). The final boss state machine for Elizabeth Homes: footfall route, weak points with rust, evacuation waves that clear every footfall zone, shed robots. |

Waves 5 and 6 have no Sim-Agents row. Use them to harden performance (agent counts against the
sim budget in `scripts/bench/sim.ts`), extend the agents into each new territory step, and help
Lane 6's rival-founder bots reuse your knowledge model.

## Done means
- Your rows' acceptance tests pass. Examples:
  - at threat 2 a van brings 2 units within 20 s, entering about 120 m from the player;
  - at least one wrapped bus passes the Ferry Building every 10 game minutes;
  - a forced update completes in 6 s unopposed.
- The clearance soak, no-touch fuzz and cross-engine determinism stay green. You stay within the
  sim time budget per tick.

## Hand-offs
- **In:** the sidewalk graph and Muni data from Lane 1; contract and `ext` keys from Lane 2;
  rust and melt state from Lane 4, which your robots react to; threat spawn requests from Lane 5.
- **Out to Lane R:** a request for each agent type that needs drawing, with its animation states
  (walk, idle, dive, wet shake, sit, talk, slump or melt) and a debug hook through
  `window.__fogcity`.
- **Out to Lane 8:** the barks and goal tables you need, as named keys.
