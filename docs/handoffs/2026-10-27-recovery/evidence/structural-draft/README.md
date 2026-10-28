# PR30 structural assertion recovery — unexecuted

Historical source: PR30 `work/world/source-cache`, commit `8691dd9e4e8d820fde17540e440eb40c215081a6`.
Current comparison: the shared `codex/consolidated-game-upgrade` working tree, whose latest parent checkpoint and dirty changes must be sealed before a run.

`original-pr30/SOURCE.json` inventories 50 exact source-only files and their SHA256. These are scratch copies, not registered current tests. No old world, OSM input, GLB, collider, source JSON fixture or golden JSON was copied. The historical harness cannot simply run against current production: its structural APIs and baseline/fixture inputs are absent.

## Exact outstanding hold

The adopted inventory quotes the October 26 PR30 hold: controller/placement holds against real props/buildings, crest launch, intentionally unmodelled long Bay Bridge span; two repairs plus escalation did not establish endpoint and negative-fixture proof. No further blind retry of that failed physical head. Source: https://github.com/BroderickHigby/fog-city/pull/30#issuecomment-6405941168 .

The latest inventory is historical evidence, not a new failure result on this candidate.

## Current source gaps

Current `src/sim/world.ts` TileCollider contains buildings and a ground heightfield, with no deck/tunnel records. `surfaceAt`, `roadSurfaceHeight`, `contradictoryDecks` used by the old structural tests are absent. `src/sim/roads.ts` expressly keeps ambient traffic off unmodelled grade-separated freeway/ramp edges. The runtime world loader has no structural layer.

Current SF roads retain all four creek crossings: 3rd St/Mission Creek c182000+c183000; 4th St c270002+c271000; 3rd St/Islais c197101+c197201; Illinois c15166000. Richland c11011002, Twin Peaks c12770000, Filbert c5491000 and Vermont c13216002 also remain. Long Bay spans c14248000/c14249000 are approximately 2810.50/2809.59 m, with only two authored road points each. The current `sf-world.test.ts` bridge assertion checks names, span length and water coverage, not traversable deck support.

## Retained physical assertions

- `play.ts` `measureRoutes`: 11 real-step controller routes, zero stopped routes, seam height-change discontinuity ≤0.1 m, below-surface depth ≤0.1 m, per-tick horizontal excess over speed×DT ≤0.5 m, longest crest air ≤0.8 s, repeated 600-tick state hashes identical. Routes include Filbert/Lombard, California/Nob Hill, Castro/Twin Peaks, 22nd, Fillmore/Marina, Vermont/Potrero, Great Highway, 19th, JFK, 3rd/Dogpatch and Merced/Embarcadero.
- `structures.test.ts`: four creek bridges both ways at 15/25 m/s reach the endpoint, actually cross water, remain on supported deck, never airborne, never below lower abutment−0.2 m. Seeded 3rd St drives and hard steering mid-span keep y>3 m over water.
- Richland street-over-freeway crossing both ways at 16/20 m/s has air ≤0.2 s. Grade crossing evidence must cover actual wheel support, not road metadata alone.
- `ram-launch.test.ts`: 360 seeded 25 m/s rams on ≥15% slopes; >300 actual contacts; no collision-triggered flight >0.3 s or lift >0.5 m; no move beyond speed×DT+0.5 m. Historical post-contact terrace residual cap is separately explicit, not permission to widen the collision rule.
- `edge.ts`, shore/wall launch tests: keep wall crossing, loaded-world, per-tick movement and launch guards. Do not replace them with shoreline appearance checks.
- Historical `structures.test.ts` deliberately stops I-80 at the shore wall. That is boundary behavior only; it cannot prove the full 2.8 km span playable. Full-span endpoint/deck and negative fixtures remain open.

## Safe next commands, only in a serialized slot

Existing current checks (do not repair through fixture relaxation):

```sh
node --max-old-space-size=2048 node_modules/vitest/vitest.mjs run tests/sim/car-push.test.ts --maxWorkers=1
node --max-old-space-size=2048 node_modules/vitest/vitest.mjs run tests/pipeline/sf-world.test.ts --maxWorkers=1
```

The former checks synthetic collision response; the latter checks SF metadata/ground contracts. Neither closes the structural controller or bridge hold. Old `world:pr`, `world:nightly` projects are absent from the current config; do not claim those commands work. Do not run `world:baseline`: that historical recorder rewrites baselines.

Before a new physical structural run, port a narrow observation/controller adapter using the **current** `loadWorld('sf',{roads:true})` loaded world, current car/foot geometry, street props, walls, road graph and actual recorded controls. Keep original route IDs and physical guards; missing/blocked route is a failure. Capture initial pose, route progress, exact supporting surface, per-tick position/velocity/contacts, endpoint and failure fixture. Do not import old world/source/OSM, seed completion, teleport around a hold, omit props, or mark a whole shore acceptable. Deck support requires an explicit producer design and endpoint/negative fixture proof before retry.
