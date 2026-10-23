# Lane 5: Player, missions & economy

## Now

Wave-4 continuation on `lane/sim-player/wave4`, based on the existing wave-3 checkpoint
`59fbfe0`. The isolated checkout is `/workspace/fog-city-player`. The original multiplayer
checkout remains on its own branch. This is work ahead for review, not a closed wave.

## Done

- Preserved the wave-2 and wave-3 mission/economy implementation and reviewed content catalogs.
- Canonical and legacy loadout IDs share one authored unlock lookup. Gadget selection uses
  catalog ranks, perk/streak slots use the rank gates, and permanent upgrades cannot downgrade.
  The existing issued balloon remains available; selecting one uses its authored gate.
- Streak thresholds, point rates and reset rules come from `STREAKS`. Crossing a threshold banks
  an equipped reward once per run; calling it spends one banked reward, not the accumulated score.
  A persisted earned ledger prevents re-equip farming and safely adopts point-only old profiles.
- Mission mechanics are prepared once in the player system and persisted only in `ext.player`.
  Parking, bell-duel and cable-car facts feed the same-tick player/heat/mission pipeline. Requests
  derive from the active authored objective and unique trusted world bindings. Forged completion
  facts are stripped; cable-car objectives require matching accepted physical boarding.
- Added the deterministic shared Doom Clock reducer: daily drift, faction-completion accounting,
  crunch/cooling modifiers, AGI and AI Winter lifecycle, Conference Week cadence, and once-only
  match-win clock carry-out. Long calendar gaps update counters without replaying an old pause.
- Exposed Doom/Conference state, banked rewards and perk availability in `playerView`. Brackish
  is disabled for instances without a coastline. Default Alive adds its extra runway on a valid
  bounty, or emits a Spotter scan-charge grant; the baseline bounty restoration remains intact.
- Independent review found a cross-player contract-key collision when IDs contain slashes.
  Tuple encoding fixes it, with an explicit two-player regression.

No shared `contract.ts`, `gameplay-contract.ts`, schemas, content, renderer, UI, package file or
lockfile changed. New state fields stay within the lane-owned extension schemas.

## Validation

Typecheck and the initial combined player/mechanics/purity checks passed (131 tests). The
individual progression suite passed 21 tests; mechanics and its existing regressions passed
29; the updated registered-pipeline suite passed 18. Final full-suite results are pending.
Tests cover replay/double-payout, aliases and rank gates, bank migration, simultaneous players,
accepted physical poses, JSON restore, Doom boundaries and calendar jumps, and extension ownership.

Commands use the pinned Corepack pnpm and one shared resource lock:

```sh
cd /workspace/fog-city-player
export COREPACK_HOME=/workspace/.cache/corepack
export NODE_OPTIONS=--max-old-space-size=8192
flock /workspace/.cache/fog-city-heavy.lock corepack pnpm typecheck
flock /workspace/.cache/fog-city-heavy.lock corepack pnpm exec vitest run --maxWorkers=2
```

## Next

Complete the remaining wave-4 integrations before advancing the later-wave runtime: tuning
bench physics, full per-mode perk effects, faction activity producers, Phone Pivot and Mom,
missions 5–7 producers/drivers, then wave-5–8 discoveries, cargo/foil, later missions and finale.
The authored data for ten missions is not evidence that every gameplay producer exists.

## Blocked on

- Lane 2's production provider/calendar/body integration and a future `integrate/wave4` target.
- Authored faction contracts currently lack explicit faction alignment and objective bindings;
  this branch deliberately does not assign a side or fabricate completed contracts.
- Current combat contract does not support the wide nozzle or Microclimate gear. Their sales
  remain withheld. The before-first-attack bonus has no authoritative producer yet.
- Shared commands do not yet define Phone Pivot, Mom or subscriptions. Do not overload unrelated
  command IDs or accept free-text completion as a substitute.

## Requests for other lanes

- **Lane 2:** integrate the player systems using `createObservedGameplayProvider({wave:4, ...})`.
  The backward-compatible default remains wave 2. Supply absolute zero-based `gameDay`/`gameWeek`,
  actor bindings, and `mechanics` world data. Consume `ext.player.boardingIntents`, then supply
  accepted cable-car attachments. Each system continues to write only its own extension slot.
- **Lane 2 / Lane 3 / Lane R:** consume Doom modifiers and `doom.agi`/`doom.winter` events for the
  three-second global pause, clock/billboard state, robot speed, density, ads and associates.
  Conference state is exposed; apply its density/ad change near the convention center only.
- **Lane 2 / Lane 6:** pass the actual mode and per-player roles. Consume `perk.scan-charge` for
  Spotters. `applyModeSettlements` now applies one faction clock move for a validated winning
  settlement, using the player's established faction; duplicate settlement IDs do nothing.
- **Lane 3 / Pipeline:** provide unique objective bindings, accepted vehicle poses, parking rules,
  turntable/opponent bodies and cable-car attachments via `MissionMechanicsWorld`. There is no
  permission for the UI to claim parking, a duel win or physical boarding directly.
- **Lane 4:** wire all enabled perk effects in each supported mode; publish wide-nozzle and
  Microclimate support plus the pre-first-attack fact before exposing those unlocks/bonuses.
- **Lane 7:** use `playerView` for banked streaks, perk enabled state and Doom state. Pass coastline
  context to `combatLoadout` and the view. Build the screens and call only recorded ID commands.
- **Lane 8:** add explicit faction/wave/location metadata and accepted objective bindings for the
  eight contract rows. Supply scripted Mom/Pivot flow keys; keep later mission outcomes authored.

## For the owner

No paid service, hosting choice, new licence or design rewrite is included. No release or
integration branch was modified. The remaining render, physical-world and mode consumers mean
this is not a claim that all of Lane 5 or waves 2–8 are complete.
