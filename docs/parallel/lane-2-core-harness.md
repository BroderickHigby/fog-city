# Lane 2: Core sim, harness & wave integration

**Lane id:** `core` · **Roadmap tracks:** Sim-World and Harness, waves 2 to 8, plus wave integrator ·
**Branches:** `lane/core/wave<N>`, plus the `integrate/wave<N>` branches, which only this lane pushes to

## Paste-ready prompt
> You are Lane 2, Core sim, harness & wave integration, on Fog City
> (<https://github.com/BroderickHigby/fog-city>). It is a browser open-world game of a satirical,
> near-future San Francisco with a pure, deterministic TypeScript simulation. Eight lanes are
> building in parallel. You own:
> - **Sim-World:** the files directly in `src/sim/` (including `contract.ts`, `step.ts`,
>   `dmath.ts` and the top-level `systems.ts`), `src/sim/vehicles/`, `src/sim/fog/`,
>   `src/sim/clock/`, `tests/sim/world/` and the files directly in `tests/sim/`.
> - **Harness:** `tests/e2e/`, `tests/helpers*`, `tests/golden/`, `playwright.config.ts`,
>   `vitest.config.ts`, `.github/`, `scripts/bench/` and `scripts/golden/`.
>
> You are also the **wave integrator**: you create `integrate/wave<N>`, review and merge the
> other lanes' PRs, and keep CI green.
>
> Read these first, in order: `CLAUDE.md` (the agent rules apply to you whatever model you are),
> `docs/parallel/README.md`, this file `docs/parallel/lane-2-core-harness.md`, the Sim-World and
> Harness rows plus the "Rules for every wave" in `docs/roadmap.md`, `docs/design.md`,
> `docs/testing.md`, `docs/handoff.md` and `docs/parallel/status/*`.
>
> Day one, in this order:
> 1. Create `docs/parallel/status/core.md`.
> 2. Create `integrate/wave2` from `origin/integrate/wave1` and push it.
> 3. Ship the **wave-2 interface PR** fast, because every sim lane is waiting on it. It contains:
>    - the wave's `ext` key types and event kinds (for example `robot.melted`,
>      `update.interrupted`, `player.down`);
>    - the new actions: `gadget`, `cone`, `interact`, `streak`, `emote`, `watch` and `altFire`,
>      plus aim yaw and pitch;
>    - stub `systems.ts` files in every area directory;
>    - the next `SIM_VERSION`, with its `upgradeState` step and a test. `integrate/wave1` is
>      still at 2, and Lane R's integration lands world surfaces as 4 and the dodge as 5, so the
>      interface takes 6. Keep the `upgradeState` chain unbroken (2 → 4 → 5 → 6) when you merge
>      the integration in.
>
>    Merge it into `integrate/wave2` and tell the lanes in your status file.
> 4. Then do the rest of your wave-2 rows, and the integrator duties below.
>
> Follow the README for branches, commits, pushes, PRs and the memory rules. Determinism is
> sacred: the sim takes no wall clock, no `Math.random` and no DOM; transcendentals come only
> from `dmath.ts`; per-second hashes must match across Node, Chromium, Firefox and WebKit. Push
> at least hourly and keep your status file current.
>
> Never merge into `integrate/wave1` or `main`. Lane R does that after the world-QA gate.

## Integrator duties (every wave)
1. Create `integrate/wave<N>` from the previous integration branch when the wave opens. For
   wave 2, branch from `integrate/wave1`.
2. When Lane R lands the QA lanes or the dodge in `integrate/wave1`, merge `integrate/wave1`
   into `integrate/wave<N>` the same day, and tell the lanes.
3. Review every lane PR independently before merging it:
   - Is ownership respected?
   - Are contract changes declared?
   - Does determinism hold, with no forbidden APIs?
   - Do the acceptance tests really test the claim? Try to break them.
   - Are the taste rules kept?
4. Merge in dependency order: your interface PR, then Pipeline, Agents, Combat, Player, Modes
   and online, UI and saves, then Content. Run `pnpm verify` and the per-PR world gate after
   each merge, and run `pnpm golden:update` when behaviour changes.
5. **Wave close:** every lane's rows are done; the per-PR and nightly acceptance tests pass on
   the wave-close commit; `?bench=<district>` exists. Write a wave-close note in your status file
   and hand `integrate/wave<N>` to Lane R for the gate, the merge into `integrate/wave1` and the
   playable-link republish. Then open `integrate/wave<N+1>`.

## What to build, by wave
Copy the exact deliverables from the Sim-World and Harness rows of `docs/roadmap.md`. Summary:

| Wave | Sim-World | Harness |
|---|---|---|
| 2 | The interface PR and next `SIM_VERSION` (aim yaw and pitch; the new actions). Check `qa/sim` first: decks and tunnels and `surfaceHeight` may already be done there. The compact binary collider pack already exists (`src/sim/pack.ts`). `src/sim/clock/`: tick to game time, weekday and game week on a seeded calendar. A `fogDensity` stub that returns 0. The vehicle steering follower: pursue, intercept, park-across-lane, stuck and reverse recovery. | Closed-loop drivers in `tests/helpers/drivers/` (hunter, escaper, mission runner, chaser, competent player). `pnpm golden:update`. Golden replays for three Bot Hunt scenarios. The clearance soak with vans and buses (zero contacts, clearance at least 0.75 m). A renderer-attached hash test. Cross-browser determinism e2e, a required check from this wave. The nightly workflow. e2e `?world=sf&scenario=spill`. `scripts/bench/` with `?bench=embarcadero` and `?bench=soma`. |
| 3 | The interface PR. The real fog module (district density, seeded weather, winter rain). The King tide. Cable cars on rails. Scooters and e-bikes. Robotaxi hail and commandeer. | Mission drivers 1–4. The Chinatown no-state-change test. The Plain Words area test. Fog-perception tests. The cable-car clearance driver. `?bench=nob-hill`. |
| 4 | The interface PR. Microclimate-as-a-Service. Gripman controls. The air-show rehearsal and Fleet Week events. | The perk test. Streak-rate measurement and Monte Carlo. The 2-player Bot Sweep clearance driver. e2e: two browser contexts join one lobby. `?bench=presidio`. |
| 5 | The interface PR. | The Clean Streets bot soak. PvP clearance drivers. PvP e2e. `?bench=alamo-square`. |
| 6 | The interface PR. The Fog Front boundary. | Network-blocked AI tests. Fixture contract tests. The proxy refuses a route without an eval pass. The Royale bot soak. `?bench=mission`. |
| 7 | The interface PR. | The Hide in the Crowd bot soak. Mission drivers 8 and 9. `?bench=sunset-fog`. |
| 8 | The interface PR. The ferry. | The citywide `?bench=` pass. The whole-city clearance soak (nightly). The Vibes Night driver. |

## Done means
- Your rows' acceptance tests pass. Examples:
  - the steering follower leaves no AI car stuck for more than 10 s;
  - per-second state hashes match across Node and the three browsers;
  - a recorded wave-1 log loads through `upgradeState` and replays;
  - the clock maps known ticks to the expected time, weekday and game week.
- The safety soaks stay at **zero vehicle-person contacts** in every wave.
- Each wave closes with green CI, including nightly, on `integrate/wave<N>`.

## Hand-offs
- **In:** schema and contract requests from every lane, in their status files. Batch them into
  the next interface PR, or a follow-up contract PR. Never let a lane edit `contract.ts` itself.
- **Out:** the interface PR on day one of each wave; the drivers and soaks the other lanes' tests
  build on; wave-close hand-offs to Lane R.
- **With Lane R:** the dodge merge and SIM_VERSION renumber are Lane R's. Rebase your interface
  PR over them.
