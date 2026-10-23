# Lane 5: Player, missions & economy

**Lane id:** `sim-player` · **Roadmap track:** Sim-Player, waves 2 to 8 · **Branches:** `lane/sim-player/wave<N>`

## Paste-ready prompt
> You are Lane 5, Player, missions & economy, on Fog City
> (<https://github.com/BroderickHigby/fog-city>). It is a browser open-world game of a satirical,
> near-future San Francisco (GTA-style freedom, non-violent, satire of AI startups and VCs) with a
> pure, deterministic TypeScript simulation. Eight lanes are building in parallel. You own the
> game loop around the player: `src/sim/player/`, `src/sim/heat/`, `src/sim/missions/`,
> `src/sim/economy/`, `src/sim/progression/`, `src/sim/activities/` and `tests/sim/player/`. Edit
> nothing else.
>
> Read these first, in order: `CLAUDE.md` (the agent rules apply to you whatever model you are),
> `docs/parallel/README.md`, this file `docs/parallel/lane-5-player.md`, the Sim-Player row of
> every wave and the territory-coverage rule in `docs/roadmap.md`, `docs/design.md` (pillars,
> heat, missions, economy, activities), `docs/handoff.md` and `docs/parallel/status/*`.
>
> Your goal: there is always something worth doing within reach. That means runway, cash and
> reputation; the heat ladder; missions 1 to 10; bounties; side activities in every district; and
> safehouses and garages within 1.5 km of everywhere. Then XP, ranks, loadouts and streaks.
>
> Start by creating `docs/parallel/status/sim-player.md`. Branch from Lane 2's wave-2 interface
> branch, or from `origin/integrate/wave2` once that interface has merged. Then do the wave-2
> row:
> 1. Runway, cash and reputation. DOWN ROUND.
> 2. Threat levels 1–2 with decay, the car wash and line of sight.
> 3. The vendor, the FiDi coworking safehouse and the Marina and Mission Bay garages.
> 4. The bounty board.
> 5. The mission runtime (`trigger`, `goto`, `timer`, `dialogue`, `branch`, `reward`), with
>    missions Hot Desk and Spill.
> 6. The Ambient Director, coning, the repair-kiosk apology tour, and a step-3 activity.
>
> Then do waves 3 to 8.
>
> Follow the README for branches, commits, pushes, draft PRs into `integrate/wave<N>` and the
> memory rules. Mission text and data come from Lane 8 (`content/`). Request the keys you need;
> don't write content files yourself. Push at least hourly and keep your status file current.

## What to build, by wave
Exact deliverables are in the Sim-Player row of each wave in `docs/roadmap.md`. Summary:

| Wave | Deliverables (summary) |
|---|---|
| 2 | Runway, cash, reputation, DOWN ROUND. Threat 1–2: decay, car wash, line-of-sight rules, and `threat.spawn{kind, count}`. The FiDi vendor: 2 tank tiers, 1 flow tier, burritos for runway. The FiDi coworking safehouse. The Marina and Mission Bay garages. The bounty board. The mission runtime. Missions Hot Desk (including the "What are you building?" sign-up that records a `StartupDefined` kit id) and Spill. The Ambient Director: one card within 150 m after 45–75 s with no objective. Coning. The repair-kiosk apology tour. One step-3 activity: SoMa delivery shifts. |
| 3 | Threat 3–5: drones, box-in, Patrol units, swarm. VC attention, cornering, the bell duel, the Bridge Round, ACQUI-HIRED. Coffee. Missions Launch Day and Demo'd Correctly, including the Search & Park leg and the first Ramen Office Hours. Ramen Office Hours as a repeatable activity. Daily Standup. Side activities on the hills. |
| 4 | XP, ranks and gates. Blaster upgrades. Perks and loadouts. Streak points. Safehouse purchases. The Presidio garage. The vibe-coded bench. Doom Clock, faction contracts, AGI Achieved and AI Winter events. Conference Week. Missions 5–7. Step-5 activities (Stair Watch, the Presidio SF-Bench route). The Fleet Week Pitch Window and the other wave-4 activities. |
| 5 | Photo spots. Bubble Relics. Scripted Customer Discovery and its three bounty chains. The Octavia Blvd bounty chain. The Hayes Valley micro-unit, plus garages wherever coverage fails. |
| 6 | AI verdict events wired to the existing scripted outcomes. Foil Integrity. Term Sheet Jumps on new crests. The Twin Peaks photo spot. Step-7 and step-9a activities. The Mission flat and the Potrero Hill garage. |
| 7 | Missions 8 (Acqui-hire Offer, played in a robot body) and 9. Ocean Beach activities. The Sunset in-law unit. |
| 8 | Mission 10, the finale. A step-9b activity. The step-9b garages. |

## Done means
- Your rows' acceptance tests pass. Examples:
  - buying tank tier 1 changes the tank capacity in sim state and costs the listed price;
  - a burrito restores the listed runway;
  - from 20 seeded starts, the Ambient Director stages an encounter within 150 m within 60 s;
  - Lane 2's mission drivers complete each mission on pinned seeds;
  - territory coverage passes for every shipped district: a safehouse or garage within 1.5 km,
    and at least one activity per step.
- `pnpm verify`, CI and the determinism tests are green.

## Hand-offs
- **In:** contract keys from Lane 2 (the threat and mission event kinds); spawnable agents from
  Lane 3; combat state from Lane 4; mission, vendor, card and activity text from Lane 8; garage
  sites and anchors from Lane 1.
- **Out to Lane 7:** HUD fields (runway, cash, threat, VC stars), the vendor, the bounty board
  and mission UI states.
- **Out to Lane 2:** the mission-driver hooks the harness needs.
- **Out to Lane R:** world markers, billboards and bus-wrap kit ids.
