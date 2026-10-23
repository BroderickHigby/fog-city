# Gameplay systems stream — status

Stream id `gameplay`. Scope: `docs/FOG_CITY_HANDOFF.md` §6 items 3–5 (weather; later missions one
stage at a time; economy and equipment). Base: `origin/integrate/wave2` (`ff7db5b`, gameplay
checkpoint `80a05c4`, `SIM_VERSION 8`, `GAME_WAVE 3`).

## Stage 1 — weather (`work/gameplay/weather`)

### What ships

| Producer | Where | Consumers wired |
| --- | --- | --- |
| Seeded marine layer per position (west first at 17:00, Marina by 19:00, downtown on some nights, thins 09–11; sunny east: Dogpatch, Mission Bay, Potrero) | `fogDensity` | robot perception (`fogAt`), bad-robot brain fog avoidance, combat fog rust at night, per-player `PlayerObservation.fog` (heat decay ×2, Marine Layer perk), `weatherView` |
| Recorded mission fog windows (`mission.weather-request`, Marine Layer's night skip) | `createFogSystem` → `ext.fog` | `fogDensity` |
| Winter rain (1 day in 3 in winter weeks, a 6-hour seeded shower) and road wetness (dries over 2 game hours) | `rainDensity`, `roadWetness` | combat rain rust on exposed bad robots, car traction, puddles, bad-robot shelter |
| Shelter: Muni stops (2.5 m), the Ferry Building arcade, awnings (1.2 m off any wall) | `shelteredAt`, `shelterPoint` | combat `sheltered` flag in rain; idle bad robots walk to the nearest shelter in rain and wait (authored mission/scene bodies keep their scripts) |
| Rain puddles: seeded per day on a 10 m grid, never in a building or the Bay | `puddlesNear` | composed refill sources (0.5× speed, fresh) |
| King tide: one seeded day a week; 10 cm on the Embarcadero promenade at a seeded high tide (4 h + 1 h ramps) | `tideLevel`, `promenadeAt`, `floodDepthAt`, `TIDE_PROMENADE` | salt refill anywhere on the flooded promenade (0.5×), car traction 0.6, bad robots keep inland all tide day |
| Wet-road traction (0.72 wet, 0.6 flooded) | `tractionAt` | player car grip and braking in `step()` (only where the wave-3 weather system has run: `ext.fog` present) |

Two review findings reconciled while wiring:

- **Rain cancelling phone hacks** (pr-13 review) stays fixed under real rain: the existing
  regression (`review-regressions.test.ts`) still passes with the real producer, and nothing in
  weather sets direct-water state.
- **Per-shot wet rule** (pr-14 review): `applyWaterHit` counts distinct shots (a particle's
  `bornTick`), so one multi-pellet Wide Boost trigger can never wet a bystander.

A latent bug the zero-fog stub had hidden: the bad-robot brain treated *any* fog above 0 as "in
fog", so every non-hostile bad robot fled in the faintest haze. It now uses the content's 0.4
threshold (`ROBOT_FOG_DENSITY`, matching `bot-tells.json` avoidFog `densityAbove` and Marine
Layer). Found by the composed Demoed Correctly test, which stalled once fog became real.

### Version

- `SIM_VERSION = 10` (provisional). **9 is reserved for the World stream** and is never written:
  `upgradeState` goes 7 → 8 → 10 and refuses 9. If World's v9 lands first, the chain becomes
  8 → 9 → 10 at merge time (one line); if the coordinator allocates a different number, the
  rename is mechanical (`contract.ts`, `step.ts`, two tripwire tests, golden file name).
- New real fixture `tests/golden/legacy-saves/v8-gameplay.json`, recorded with the base
  checkout's own code at wave 3 (`ff7db5b`). v7 and older fixtures kept unchanged.
- New composed golden `tests/golden/composed-v10.json` (v8 file kept) with a new
  `city-wave3-rain` scenario so the pins actually cover rain.

### Contract changes (all additive)

- `src/sim/contract.ts`: `SIM_VERSION` 8 → 10 and its history comment.
- `src/sim/extensions.ts`: `ExtensionStateMap.fog` typed as `FogState` (was `JsonObject`).
- `src/sim/car.ts`: `stepCar(..., traction = 1)` optional parameter (default unchanged behaviour).
- `src/sim/agents/runtime.ts`: optional `AgentRuntimeOptions.weatherRefuge`.
- `src/sim/player/adapter.ts`: `ObservedGameplayOptions.fog` receives the player's `(x, z)`.

### Requests for Lane R (render) — weather presentation

Everything below is read from the sim through `weatherView(world, state, x, z)` (exported from
`src/sim/index.ts`), evaluated once per frame at the camera (or local player) position on the
interpolated `curr` state. It is pure and cheap (one cached calendar per state object).

1. **Time of day from the sim.** `src/render/clock.ts` still runs its own 18:52 clock; the sim's
   calendar starts at 08:00 and fog is defined against it. Use `gameTime(state)`
   (`hour`, `minute`, `second`) for sky/lighting, so night lighting and fog agree.
2. **Fog volume.** `view.fog` (0..1) drives the height-fog density: suggested
   `fcFogParams.x`/`fogDensity` lerp from today's clear value to about 6× at 1.0, colour toward
   cool grey. Update when it changes by > 0.01. For per-district volumes, sample
   `fogDensity(world, state, x, z)` on a coarse grid (e.g. 250 m) around the camera every ~2 s.
   Microclimate spheres are already inside `fogDensity` (density 1 inside the radius).
3. **Rain.** `view.rain` (0 or 1): a camera-attached rain particle volume and a darker, flatter
   sky; mute under shelter (`view.sheltered`). `view.wetness` (0..1, lingers 2 game hours):
   road/sidewalk roughness down and a reflective tint on ground materials.
4. **Puddles.** `view.puddles` (≤ 40 m, ids stable for the game day): decals at `(x, y, z)`
   radius `radius`; they exist only while `wetness ≥ 0.3`.
5. **King tide.** When `view.tide > 0`, draw a water sheet `tide` metres above ground over the
   strip `TIDE_PROMENADE` offset `WEATHER.promenadeNearM`..`WEATHER.promenadeFarM` to the left
   of travel (bayward); skip points where `promenadeAt(world, x, z)` is false (piers, sheds).
   Recompute only when `tide` changes by > 1 cm.
6. **Robot looks.** Good robots wear rain capes while `rain > 0` (`wearsRainCape` tell); bad
   robots don't (`skipRainCape`, subtlety 2) and cluster under awnings — the sim already moves them.

### Validation so far (focused, on this branch)

- `pnpm typecheck` clean.
- `tests/sim` + `tests/golden`: all green after re-recording; `tests/sim/fog.test.ts` (12 tests:
  curve, determinism, rain/dry timing, windows, wave gating, per-player heat, traction through
  `step()`, puddle refill at half speed, shelter + composed bad-robot shelter, rain rust
  exposed/sheltered/good, King tide on the real Embarcadero incl. salt refill).

### What is and isn't playable

- Live in the browser at wave 3: fog, rain, puddles, shelter, tide and traction run in the real
  game step. Rain only falls in winter weeks (from game week 5, about 11 real hours in) and the
  tide on one game day a week, so a short session mostly sees fog.
- Not yet visible: there is no fog/rain/tide rendering until Lane R lands the requests above.

## Next stages

2. Later missions one at a time (wave 4 `demo-day`, `fleet-week`, `hill-climb`; then
   `marine-layer`, `acqui-hire-offer`, `comeback-round`).
3. Economy and equipment reconciliation.

## Coordination

- Multiplayer stream: match isolation will go through `src/sim/modes/**`'s seam; nothing in this
  stage touches it.
- Missions stream: no edits to `src/sim/activities/availability.ts`.
