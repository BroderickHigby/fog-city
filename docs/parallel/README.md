# Fog City: parallel build lanes

Handoff for eight agent sessions that build the rest of Fog City in parallel, 23 Oct 2026.
Any coding agent can run a lane (Claude, ChatGPT/Codex or other). Each lane has its own file in
this folder with a paste-ready prompt. This README holds the rules every lane follows.

Repo: <https://github.com/BroderickHigby/fog-city>. Owner: Broderick (`BroderickHigby`).

## The goal: the final spec
Fog City is a browser open-world game: a drivable, satirical San Francisco about five years
from now. It is built from the real city's open data and plays like GTA, but it is non-violent:
water rusts bad robots, players throw flowers at each other, and nobody is ever hurt.

"Done" for the whole game means all of the following hold:
1. Every track row in waves 2 to 8 of `docs/roadmap.md` is built and its **acceptance tests pass**
   in CI, including the nightly tier.
2. The **whole city is drivable**, territory steps 3 to 9b, with every tile inside the budgets
   and the world-continuity gate green: no floating, sinking, ghost walls or holes.
3. The **safety invariants** hold everywhere:
   - zero vehicle-person contacts (the Crazy Taxi rule, `feature/dodge`);
   - water never reaches animals, children, or anyone seated, lying down or using a mobility aid;
   - per-second state hashes match across Node, Chromium, Firefox and WebKit.
4. The **realism track**: photoreal ground, streets, buildings and characters, with quality
   tiers that keep the default tier inside budget. Lane R owns this (see below).
5. The **playable link** is republished at each wave close, and the owner has played each wave's
   "playable result" on real hardware.

The design source of truth is `docs/design.md` (pillars, systems, the dated decision log).
`docs/roadmap.md` says what gets built in which wave. `CLAUDE.md` holds the agent rules, which
apply to you whatever model you are. `docs/handoff.md` covers the current state and the
operating rules.

## The lanes
| # | Lane | Roadmap tracks | Owns (edit only these) | File |
|---|---|---|---|---|
| 1 | Pipeline & territory | Pipeline | `pipeline/`, `public/tiles/sf/`, `docs/data-sources.md`, `tests/pipeline/` | `lane-1-pipeline.md` |
| 2 | Core sim, harness & wave integration | Sim-World, Harness | the files directly in `src/sim/`, `src/sim/{vehicles,fog,clock}/`, `tests/sim/world/`, the files directly in `tests/sim/`; `tests/e2e/`, `tests/helpers*`, `tests/golden/`, `playwright.config.ts`, `vitest.config.ts`, `.github/`, `scripts/bench/`, `scripts/golden/` | `lane-2-core-harness.md` |
| 3 | Agents & robots | Sim-Agents | `src/sim/agents/`, `src/sim/robots/`, `tests/sim/agents/` | `lane-3-agents.md` |
| 4 | Combat | Sim-Combat | `src/sim/combat/`, `tests/sim/combat/` | `lane-4-combat.md` |
| 5 | Player, missions & economy | Sim-Player | `src/sim/{player,heat,missions,economy,progression,activities}/`, `tests/sim/player/` | `lane-5-player.md` |
| 6 | Modes & online | Sim-Modes, Server-Net, Server-AI | `src/sim/modes/`, `src/sim/bots/`, `server/`, `src/net/`, `tests/sim/modes/`, `tests/net/`, `tests/server/` | `lane-6-modes-online.md` |
| 7 | UI, audio & saves | UI-Audio, Save-Profile | `src/ui/`, `src/audio/`, `src/input/`, `src/save/`, `tests/ui/`, `tests/save/` | `lane-7-ui-audio-save.md` |
| 8 | Content & writing | Content | `content/` (except `landmarks.json`), `src/content/`, content `schemas/`, `tests/content/` | `lane-8-content.md` |
| R | Render, assets, QA & realism (the existing Claude session) | Render-World, Assets | `src/render/`, `src/main.ts`, `src/debug.ts`, `src/io/`, `index.html`, `vite.config.ts`, `scripts/build-web.ts`, `assets/`, `public/models/`, `public/audio/`, `content/landmarks.json`, `tests/render/`, `tests/io/`, `tests/assets/` | not part of this handoff |

Lane R is already running. It owns the world-QA gate, merging the `qa/*` lanes into
`integrate/wave1`, the `feature/dodge` merge, the photoreal realism track
(`feature/ferry-showcase`, then citywide) and republishing the playable link. Every lane needs
something drawn on screen from Lane R. List those needs as **Requests for Render-World / Assets**
in your status file. Never edit Lane R's directories.

Every lane also owns its own status file, `docs/parallel/status/<lane-id>.md`. No other lane
edits it.

## Branches and merge flow
- `main`: releases only. Never push to it.
- `integrate/wave1`: the current integrated game. **Owner's hard rule:** no wave work merges
  into it until the world-QA gate is green, meaning every verified blocker, high and medium world
  defect is fixed. Lane R decides when that holds.
- `integrate/wave2` and onwards: the integration branch for each wave. Lane 2 creates
  `integrate/wave2` from `integrate/wave1` on day one, and each next one from the previous
  wave's branch when that wave closes. All lanes open PRs into the current wave's branch.
  Lane 2 merges them. Lane R merges a closed wave back into `integrate/wave1` once the gate
  allows it.
- **Your branches:** `lane/<lane-id>/wave<N>`, for example `lane/sim-agents/wave2`. Lane ids:
  `pipeline`, `core`, `sim-agents`, `sim-combat`, `sim-player`, `modes-online`, `ui-save`,
  `content`.
- **Start a wave branch:**
  ```bash
  git fetch origin
  git checkout -b lane/<lane-id>/wave2 origin/integrate/wave2   # or origin/integrate/wave1 if wave2 doesn't exist yet
  ```
- **Working ahead:** while your wave-N PR is in review, start `lane/<lane-id>/wave<N+1>` from your
  wave-N branch. Rebase or merge it onto `integrate/wave<N+1>` once that branch exists.
- **Stay current:** merge `origin/integrate/wave<N>` into your branch at least daily, and always
  before you mark a PR ready. When Lane R lands the QA lanes in `integrate/wave1`, Lane 2 merges
  `integrate/wave1` into `integrate/wave2`, and you pick that up.
- Never push to `main`, `integrate/*`, `qa/*`, `feature/*`, `wip/*` or another lane's branches.
  Lane 2 is the only lane that pushes to `integrate/wave<N>`. Never force-push a branch that
  someone else has based work on.
- Ignore `wip/*` and `integrate/citywide`, which are old backups.

## Setup and running the game
Requirements: Node 22.18 or newer, and pnpm 9.12. Enable pnpm with
`corepack enable && corepack prepare pnpm@9.12.0 --activate`.

```bash
git clone https://github.com/BroderickHigby/fog-city && cd fog-city
pnpm install
pnpm dev                     # then open http://127.0.0.1:5173/?world=sf   (or ?world=dev, the small test world)
```
URL options:
- `world=sf | dev | dev-city`: which world to load.
- `night=1`: start at night.
- `shadows=1`: turn on sun shadows.
- `cam=chase | first-person | fly`: starting camera.
- `radius=1500`: tile load radius in metres.
- `pr=1.5`: cap the device pixel ratio.
- `perf=1`: performance overlay.
- `bench=<district>`: benchmark run.

Controls:
- On foot or driving: WASD or arrows to move, Space to brake (sprint on foot), F to enter or exit
  a car, E or Enter to fire, Q to scan, H for the horn.
- Camera: C switches chase/first-person, V toggles the free-fly camera (WASD, Space/Shift for
  up/down, mouse drag to look, wheel for speed), N toggles night.

Tests and build:
```bash
pnpm typecheck
pnpm test                    # Vitest, unit + sim
pnpm e2e                     # Playwright under SwiftShader; first time: pnpm exec playwright install chromium
pnpm verify                  # all three; must be green before you call anything done
pnpm build && pnpm preview   # packed static build in dist/ (scripts/build-web.ts)
```

**Memory rules on a 16 GB machine** (a cloud container crashed five times without them):
- Run heavy commands one at a time, in the foreground, under one lock, for example
  `flock /tmp/fog.lock pnpm test`. Heavy means typecheck, vitest, playwright, builds, pipeline
  runs, and anything that loads the sf world.
- Set `NODE_OPTIONS=--max-old-space-size=8192`.
- Run vitest with `--maxWorkers=2` and Playwright with `--workers=1`.
- Never start a heavy job with under 8 GB free (`free -g`).

## Commits, pushes and PRs
- **Small, frequent commits.** Each one should at least typecheck. Commit message style, matching
  the repo history:
  `<Area>: <what changed, as a plain-English sentence>`. Example:
  `Sim-Agents: bad Footman flees at rust 0.6 and hides behind parked cars`. Put the *why* in the
  body.
- No model or tool names in commits, code comments or PRs. No secrets, tokens or personal data,
  ever. Pin a new dependency to an exact version at least two weeks old with
  `pnpm add --save-exact`.
- **Push at least every hour and at every stopping point:**
  `git push -u origin lane/<lane-id>/wave<N>`. Unpushed work is lost if your environment resets.
- **Open a draft PR** into `integrate/wave<N>` early. Fill it in using this template:
  ```
  ## Summary
  ## Roadmap deliverables (copy your track's row for this wave; tick what's done)
  ## Acceptance tests (each one: passing / failing / not yet written)
  ## Contract changes (src/sim/contract.ts, schemas/tile-*, SIM_VERSION): say loudly, or "none"
  ## Requests for other lanes
  ## For the owner to judge (screenshots, feel, jokes)
  ```
- **Before you mark a PR ready:**
  1. Merge the latest `integrate/wave<N>`.
  2. Run `pnpm verify` green.
  3. Get CI green on the pushed branch.
  4. Review your own diff adversarially: try to break each acceptance test and look for
     determinism leaks.
  5. Update your status file.

  Lane 2 does an independent review before merging.

## Cross-lane rules
- **Ownership is strict.** Edit only your own directories. Anything else goes in your status
  file and PR under "Requests for other lanes", naming the lane, the file and the exact change.
  Lanes check the other status files at the start of each session.
- **Contracts belong to Lane 2.** Only Lane 2 edits `src/sim/contract.ts`, the top-level sim
  files and `schemas/tile-*`. Each wave opens with Lane 2's **interface PR**: `ext` key types,
  event kinds, new actions and stub `systems.ts` files in every area. Build against those stubs.
  Until that PR merges, branch from Lane 2's interface branch.
- **SIM_VERSION:** `integrate/wave1` is still at version 2. The unmerged `qa/sim` and
  `feature/dodge` branches each bump to 4 on their own, so Lane R's integration lands them as 4
  (world surfaces) and 5 (the dodge). Lane 2's wave-2 interface takes 6. A later bump takes the
  next free number when it merges, and renumbers at rebase if that number is taken. Every bump
  adds an `upgradeState` step and a test that loads the previous version's save or replay. The
  chain must stay unbroken (2 → 4 → 5 → 6 …) once the integration lands.
- **Determinism (enforced by `tests/sim/forbidden-apis.test.ts`):** the sim is pure. That means
  no three.js, DOM, network, wall clock or `Math.random`, and transcendental maths only from
  `dmath.ts`. Iterate players with `sortedIds()`. Outside facts enter only as `SimEvent`s.
  Behaviour changes regenerate golden files with `pnpm golden:update`, which Lane 2 adds in
  wave 2, and the PR says why.
- **Tests never hit the network.** Loopback servers inside a test are fine. Pipeline downloads
  go to `pipeline/.cache/`.

## Taste and legal rules (non-negotiable, from `CLAUDE.md`)
- Non-violent. Water rusts robots, and they seize, slump and melt. People get wet and annoyed,
  never hurt. Vehicles never hurt people; they dodge, and contact is at most a gentle push.
- No real brands, logos or trademarks. Invent names, and every invented proper name goes in
  `content/cleared-names.json`. Robots and vehicles are original designs.
- No real private people. Public figures appear only as obvious caricature. The one exception is
  the owner's consented stylised likeness as the player.
- Punch up at tech and VC culture. Never make homelessness, poverty, drug use or crime victims
  the joke.
- Assets must be CC0, MIT, BSD or Apache, or CC-BY with the attribution logged; no
  non-commercial licences. Mixamo clips may be used in-game only. Don't use photos of real SF
  facades or real people's likenesses.

## Stop and ask the owner (through your PR or status file) before you
- Choose or pay for hosting. This is needed before wave 4 online play.
- Use any paid service, API key or server secret, including the AI key for wave 6.
- Sign off the trademark and name search for invented names (wave 2 content freeze).
- Add an asset under a licence other than those listed above.
- Change a design decision in `docs/design.md`. Propose it and let the owner decide.
- Merge anything into `integrate/wave1` or `main`.

Frame rate on real hardware, feel, whether it reads as SF and whether the jokes land are the
owner's call. Send screenshots or clips, and never claim those pass yourself.

## Status files
Keep `docs/parallel/status/<lane-id>.md` current at every push. It has these sections:
- **Now:** what you're working on.
- **Done:** with commit SHAs.
- **Next.**
- **Blocked on:** a lane or the owner.
- **Requests for other lanes.**
- **For the owner.**
