# Lane 4: Combat (water, rust & melt)

**Lane id:** `sim-combat` · **Roadmap track:** Sim-Combat, waves 2 to 5 (then hardening) · **Branches:** `lane/sim-combat/wave<N>`

## Paste-ready prompt
> You are Lane 4, Combat, on Fog City (<https://github.com/BroderickHigby/fog-city>). It is a
> browser open-world game of a satirical, near-future San Francisco with a pure, deterministic
> TypeScript simulation. Combat is **non-violent**: a water blaster rusts bad robots until they
> seize, slump and melt into a rust heap; people only get wet and annoyed; players fire flowers
> at each other. Eight lanes are building in parallel. You own `src/sim/combat/` and
> `tests/sim/combat/`. Edit nothing else.
>
> Read these first, in order: `CLAUDE.md` (the agent rules and taste rules apply to you whatever
> model you are), `docs/parallel/README.md`, this file `docs/parallel/lane-4-combat.md`, the
> Sim-Combat row of every wave in `docs/roadmap.md`, the combat, robots and safety sections and
> the decision log of `docs/design.md`, `docs/handoff.md` and `docs/parallel/status/*`.
>
> Your goal: Bot Hunt's core loop feels great and is provably safe. Spray, refill, rust, seize,
> slump, melt and heap. Then the gadgets, gear and streak effects, then PvP flowers. The owner
> specifically asked that **rusted robots visibly fall down or melt**: within 2 s of seizing,
> each robot's drawn height is at most 40% of standing height. Your sim state must drive that.
>
> Start by creating `docs/parallel/status/sim-combat.md`. Branch from Lane 2's wave-2 interface
> branch, or from `origin/integrate/wave2` once that interface has merged. Then do the wave-2
> row:
> 1. Water particles, then refills (hydrant, fountain, Bay edge, salt), then rust rates and the
>    drying rule.
> 2. The melt state machine and heaps.
> 3. The attacks: shove, grocery snatch, ad blast, The Handshake and forced update.
> 4. The Traffic Cone as a base item.
> 5. Wrong-target outcomes: a good robot limps to a kiosk; a person gets wet.
> 6. No-touch removal: water never reaches animals, children, or anyone seated, lying down or
>    using a mobility aid.
> 7. Bot Check scan and ping.
>
> Then do waves 3 to 5, and harden after that.
>
> Follow the README for branches, commits, pushes, draft PRs into `integrate/wave<N>` and the
> memory rules. Determinism: no wall clock, no `Math.random`, `dmath.ts` only, and golden updates
> explained. Push at least hourly and keep your status file current.

## What to build, by wave
| Wave | Deliverables (summary; exact text in `docs/roadmap.md`) |
|---|---|
| 2 | Water particles. Refills: hydrant, fountain, Bay edge, salt. Rust: rates, the drying rule and partial-rust effects. The melt state machine, whose slump and melt state the renderer reads. Heaps, which clear when out of the fidelity radius until Tidy arrives in wave 3. Attacks: shove, grocery snatch, ad blast, The Handshake, forced update. The Traffic Cone: the `cone` action, thrown 8 m; a cone on a rule-obeying vehicle's hood pulls it over within 3 s and blinds a bad robot for 3 s. Wrong-target outcomes. No-touch removal. Bot Check scan and ping. |
| 3 | Phone hack. Window spray. Running-board spray. Fog rust and fog sight effects. Rain rust, plus rain and King-tide puddle refills. The ad-drone rust rate. |
| 4 | Gadgets: water balloon, sprinkler, decoy speaker. Gear: Rubber Boots, Airplane Mode. The trunk tank and the Roof Cannon. Streak reward effects: Confidence Score, Buzzword Parrots, Tensor Brick Drop, Blimp Impressions, Open Hydrants, AGI Achieved. |
| 5 | The blaster's flower alt-fire, in PvP modes only: one slow lob every 1.5 s, 20 m range; hits put flowers in hair; no rust, no knockback, never hits an NPC. |
| 6–8 | Hardening: balance against Lane 2's streak Monte Carlo and Lane 5's economy; boss weak-point rust with Lane 3 in wave 8; new territory refill points from Lane 1. |

## Done means
- Your rows' acceptance tests pass. Examples:
  - a good robot under 1.5 s of the starting stream does not seize, and walks to a repair kiosk;
  - a forced update is interrupted when the pusher reaches rust 0.2;
  - a cone stops a robotaxi within 3 s;
  - scan accuracy over 10,000 seeded scans is within ±2% of the table;
  - no water particle ever reaches a protected subject (fuzz: 50 seeds per PR, 1,000 nightly);
  - a melted Footman and Trundle reach at most 40% of standing height within 2 s, with heap and
    puddle drawn. This is a browser test that Lane 2 owns and Lane R draws; your state must make
    it possible.
- `pnpm verify` and CI are green. The determinism tests pass.

## Hand-offs
- **In:** actions and `ext` keys from Lane 2; robot and person agents from Lane 3; hydrant,
  fountain and Bay-edge data from Lane 1; tank and flow tiers from Lane 5.
- **Out to Lane R:** the water stream, splashes, wet decals, puddles, rust shader, slump and melt
  playback and heap props. Describe the sim fields to read.
- **Out to Lane 7:** tank, salt and scan results for the HUD.
- **Out to Lane 8:** wet barks and melt lines, as keys.
