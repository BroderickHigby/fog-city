# Lane 5: Player, missions & economy

## Now

Wave-4 continuation on `lane/sim-player/wave4-continuation`, reconciling the published
`lane/sim-player/wave4` checkpoint `29b3705` with the progression and mechanics work based
on wave 3 (`59fbfe0`). The separate checkout is `/workspace/fog-city-player`. The existing
multiplayer checkout and the other session's wave-4 branch are preserved. This is work
for review and integration, not a closed wave.

## Done

- Preserved wave-2/3 missions, economy and safehouses, plus the published wave-4 measured
  story missions, combat attribution, reticle selection, faction routes and match isolation.
- Canonical and legacy loadout IDs share authored unlock gates. Gadget ranks, perk/streak
  slots, point rates and reset rules come from the content catalogs. Upgrades cannot downgrade.
- Crossing a streak threshold banks the equipped reward once per run. Calling it consumes a
  banked reward, not the score. A persisted earned ledger prevents re-equipping to farm rewards
  and adopts legacy point-only profiles once. Banked rewards survive a run reset.
- Parking, bell-duel and cable-car mechanics are prepared once and persisted in `ext.player`.
  Their verified facts feed the same-tick pipeline. Requests require active authored objectives
  and unique world bindings; cable boarding requires the accepted physical attachment.
- Kept one Doom Clock in `progression.doom`, with separate AGI/winter counters. Added bounded
  absolute-day catch-up, replay guards, same-tick AGI streaks and immediate match-settlement
  boundary handling. Historical resets do not replay today's pause. Conference Week is a
  separate calendar presentation state in activities.
- Physical faction routes own their cash/XP payouts. Only validated activity emissions feed
  faction progression. Named completion facts cannot bypass route interaction or the seven
  measured story predicates. Failed speed rules still fail faction delivery.
- Exposed banked rewards, perk availability, Doom effects and Conference Week through
  `playerView`. Brackish is disabled without a coastline. Default Alive restores its extra
  runway on a valid bounty; its Spotter variant emits a scan-charge for the mode consumer.
- Free-roam player reducers return before querying providers in active/finished matches.
  Validated match rewards, achievements and a faction clock move settle once after restoration.

This continuation edits lane-owned source/tests and this status file. Shared content/schema
and combat-contract changes in its history come from the published wave-4 dependency.

## Validation

Merged typecheck and 156 player/purity tests passed. Final broad/browser checks and the
new producer-cursor regression are in progress. The earlier broad run passed 2,717 tests and failed five cases
across asset loading, an older empty-extension assertion and a pinned replay hash. The three
small assertions also fail on the untouched starting checkpoint; two asset tests timed out.
The original browser attempt did not run tests because its external config loaded as CJS;
an ESM temporary config corrects that environment issue.

Use one shared heavy-process lock; do not run another browser/build suite alongside these:

```sh
cd /workspace/fog-city-player
export COREPACK_HOME=/workspace/.cache/corepack
export NODE_OPTIONS=--max-old-space-size=8192
flock /workspace/.cache/fog-city-heavy.lock corepack pnpm typecheck
flock /workspace/.cache/fog-city-heavy.lock corepack pnpm exec vitest run --maxWorkers=2
```

## Next

Finish wave-4 integration before proceeding to later-wave runtime: tuning bench physics,
per-mode perk effects, Phone Pivot/Mom/subscriptions, then wave-5–8 discoveries, cargo/foil,
later missions and finale. Ten authored mission definitions do not establish that all
required physical producers and consumers run in the production game.

## Blocked on

- Lane 2's production provider, calendar/body integration and a wave-4 integration target.
- Wide nozzle/Microclimate now have shared interface fields, but this checkpoint does not
  contain their combat implementation. Selection/sales remain withheld until that lands.
- The before-first-attack bonus needs an authoritative producer.
- Shared commands do not define Phone Pivot, Mom or subscriptions. Do not overload unrelated
  command IDs or use free-text completion as a substitute.

## Requests for other lanes

- **Lane 2:** integrate `createObservedGameplayProvider({wave:4, ...})`. Supply absolute
  zero-based `gameDay`/`gameWeek`, unique actor bindings, actor bodies and `mechanics` world data.
  The default provider remains wave 2. Consume `ext.player.boardingIntents`, then publish the
  accepted cable-car attachments. Supply recovered vehicle ownership for the measured story.
- **Lane 2 / Lane 3 / Lane R:** consume canonical `doomEffects` and `world.agi-achieved` /
  `world.ai-winter` events for pause, clock/billboards, robot speed, density, ads and associates.
  Apply Conference Week density/ad changes near the convention center only. Activity-to-clock
  and clock-to-heat events are consumed on the next registered tick with durable cursors.
- **Lane 2 / Lane 6:** restore free roam before `applyModeSettlements`; use unique payout IDs.
  Supply mode/role/coastline context and consume Spotter scan charges. Match-local AGI must stay
  within the mode. The shared online clock still needs server authority.
- **Lane 3 / Pipeline:** provide accepted parking/vehicle/opponent poses and unambiguous
  objective bindings through `MissionMechanicsWorld`. UI commands cannot certify completions.
- **Lane 4:** land wide-nozzle/Microclimate runtime and the pre-first-attack producer; consume
  enabled combat perks in each supported mode before exposing the remaining unlocks.
- **Lane 7:** use `playerView` for banked rewards, enabled perks and clock state, and record
  ID commands only. Pass coastline context to the view and combat loadout.
- **Lane 8:** provide authored Mom/Pivot/subscription flow keys and later mission outcomes;
  coordinate physical objective bindings with the producer lanes.

## For the owner

No paid service, hosting choice, new licence or design rewrite is included. No release or
integration branch was modified. Remaining physical-world, rendering and mode consumers
mean this is not a claim that all of Lane 5 or waves 2–8 are complete.
