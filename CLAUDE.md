# Fog City — instructions for agents working in this repo

A browser open-world game set in San Francisco about five years from now: real streets
and buildings from SF open data, robotaxis and errand robots everywhere, satire of the AI
startup scene. Three.js renders; a pure-TypeScript deterministic simulation is the truth.

## Commands
- `pnpm install`
- `pnpm typecheck` · `pnpm test` (Vitest) · `pnpm e2e` (Playwright, software WebGL) · `pnpm verify` (all three)
- `pnpm dev` then open `http://127.0.0.1:5173/?world=dev` (hand-made test world) or `?world=sf` (real SF, once the pipeline has run)
- Blender 4.5 LTS runs headless only (no GUI): the binary path is in the `BLENDER` env var or given in your task.

`pnpm verify` must be green before you call anything done.

## Game design
Read `docs/design.md` before building gameplay. It is the source of truth for pillars, combat, robots, territory
and the decision log. `docs/roadmap.md` says what gets built in which wave; `docs/ai-layer.md` covers every
AI feature.

## Architecture and contracts
- `src/sim/contract.ts` and `schemas/tile-*.schema.json` are the contracts every part builds against.
  Do not change them casually: a change breaks saves, replays and netcode. If you must, say so loudly in your report.
- The sim (`src/sim/`) is pure and deterministic. `step(world, state, inputs, events)` returns a new state and never
  mutates its input. SimState is plain JSON. No three.js, DOM, network, clock or `Math.random`; transcendentals come
  from `dmath.ts`. `tests/sim/forbidden-apis.test.ts` enforces this. Iterate players with `sortedIds()`.
- Multiplayer-ready by construction: inputs are keyed by player id; outside facts (AI replies, server decisions,
  joins) enter only as `SimEvent`s recorded with their tick.
- Coordinate frame (`src/geo/project.ts`): metres, origin at the Ferry Building clock tower, +x east, +y up,
  +z south (north is -z). Headings are compass bearings (radians clockwise from north); the renderer sets
  `rotation.y = -heading` on models that face -z.
- Data flow: `pipeline/` (Node, offline) fetches SF open data and writes `public/tiles/<world>/`. Tiles live
  in plain git, meshopt-compressed (decided 2026-10-20, `docs/design.md` decision log). The sim reads the
  citywide collider pack `world.colliders.bin` (`src/sim/pack.ts`; hand-made worlds: `*.collider.json`),
  the road graph and `boundary.json`; the renderer reads `*.glb` and the far-LOD cells. Files go through
  `src/io/assets.ts`; `pnpm build` writes the packed static build in `dist/` (`scripts/build-web.ts`).
- The sim and renderer make no network calls. Only `src/net/` talks to the relay, in online modes.
- TypeScript: relative imports use the `.ts` extension; erasable syntax only (no enums, namespaces or
  constructor parameter properties). Node runs `.ts` files directly (`node pipeline/x.ts`).

## Ownership
Each track has one owner. Edit only your own directories; anything else, describe in your report.
A track marked "from wave N" starts in that wave. The one exception: the Sim-World interface PR
that opens each wave may create or edit the stub `systems.ts` file in every area directory; once
it merges, each area track owns its own `systems.ts` again. The systems rule, golden files and the
render split are in [`docs/roadmap.md`](docs/roadmap.md#ownership).

| Track | Owns |
|---|---|
| Pipeline | `pipeline/`, `public/tiles/sf/` (incl. `roads.json`), `docs/data-sources.md`, `tests/pipeline/` |
| Render-World | `src/render/`, `src/main.ts`, `src/debug.ts`, `index.html`, `vite.config.ts`, `public/tiles/dev-city/`, `tests/render/` |
| UI-Audio | `src/ui/`, `src/audio/`, `src/input/`, `tests/ui/` |
| Sim-World | the files directly in `src/sim/` (`contract.ts`, `step.ts`, `index.ts`, the top-level `systems.ts`, `dmath.ts` and the other shared files; additive changes to `contract.ts` only: bump to the next `SIM_VERSION` and say so in the report), `src/sim/vehicles/`, `src/sim/fog/`, `src/sim/clock/`, `tests/sim/world/` and the files directly in `tests/sim/` |
| Sim-Agents | `src/sim/agents/`, `src/sim/robots/`, `tests/sim/agents/` |
| Sim-Combat | `src/sim/combat/`, `tests/sim/combat/` |
| Sim-Player | `src/sim/player/`, `src/sim/heat/`, `src/sim/missions/`, `src/sim/economy/`, `src/sim/progression/`, `src/sim/activities/`, `tests/sim/player/` |
| Sim-Modes (from wave 4) | `src/sim/modes/`, `src/sim/bots/`, `tests/sim/modes/` |
| Content | `content/` (except `landmarks.json`), `src/content/`, content `schemas/`, `tests/content/` |
| Assets | `assets/blender/`, `assets/audio/`, `public/models/`, `public/audio/`, `content/landmarks.json`, `tests/assets/` |
| Harness | `tests/e2e/`, `tests/helpers.ts`, `tests/helpers/`, `tests/golden/`, `playwright.config.ts`, `vitest.config.ts`, `.github/`, `scripts/bench/`, `scripts/golden/` |
| Server-Net (from wave 4) | `server/net/`, `server/main.ts`, `server/deploy/`, `src/net/`, `tests/net/`, `tests/server/net/` |
| Server-AI (from wave 6) | `server/ai/`, `tests/server/ai/` |

Adding a dependency: pin an exact version that is at least two weeks old (`pnpm add --save-exact`).

## Content and taste rules (non-negotiable)
- Non-violent. Players fire flowers at each other; the water blaster rusts robots (they seize, slump and melt into a
  rust heap). People are never harmed: water makes them wet and annoyed and costs the player. Water never
  reaches animals, children, or anyone seated, lying down or using a mobility aid. Vehicles never hurt
  people (they dodge; contact is a gentle push). Bad-robot attacks are slapstick and satire, never injury.
- No real brands, logos or trademarks. Invent startup and product names. Storefronts stay unnamed for now:
  iconography only (beer-neon shape, barber pole), empty sign slot reserved.
- Robotaxis and robots are original designs: nothing that copies a real vehicle or a film robot.
- Public figures only as obvious caricature that never claims to be the real person; never real private people.
- Punch up at tech and VC culture. Never make homelessness, poverty, drug use or crime victims the joke.

## Tests
- Tests never hit the network (loopback servers inside a test are allowed). Pipeline downloads are cached
  in `pipeline/.cache/` (gitignored); tests use committed outputs and fixtures.
- Browser tests run under SwiftShader: assert behaviour through `window.__fogcity`, never frame rate.
