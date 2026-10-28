# Five civilian vehicle bodies

Source: [Kenney Car Kit 3.1](https://kenney.nl/assets/car-kit), author Kenney, CC0 1.0. The exact archive URL, acquisition hash/date and license are retained in `acquisition.json` and `LICENSE.txt`. Ignored `raw/` holds the official ZIP, member inventory, five selected original GLBs, external colormap and original member hashes. No account, paid service or external generator was used.

`prepare.ts --prepare` is the reproducible importer. It uses existing project dependencies, corrects the source van's differing forward axis, re-centers each wheel's actual geometry at its hub, gives every wheel the X spin/front-steer contract, normalizes dimensions while preserving circular wheel-well neighborhoods, separates paint, bakes the palette into linear material colors, removes all texture dependencies, and writes meshopt-compressed GLBs. Native source forward orientation and wheel origins were measured instead of assumed. Body shapes remain genuinely distinct: compact hatch, sedan, SUV, pickup with open bed and panel van.

| Runtime body | Source member | Length x total width x height (m) | Wheelbase / radius (m) |
|---|---|---|---|
| compact-hatch | hatchback-sports.glb | 3.78 x 1.88 x 1.49 | 2.42 / 0.300 |
| sedan | sedan.glb | 4.30 x 1.96 x 1.48 | 2.66 / 0.340 |
| utility-suv | suv.glb | 4.48 x 1.98 x 1.77 | 2.76 / 0.365 |
| short-pickup | truck.glb | 4.58 x 1.98 x 1.72 | 2.88 / 0.355 |
| cargo-van | van.glb | 4.58 x 2.00 x 2.06 | 2.85 / 0.340 |

The outputs live in `public/models/vehicles/`; `prepared-manifest.json` records exact source/output SHA-256, byte/triangle counts, dimensions, wheels, paint/audio and LOD policy. Runtime metadata lives in `src/render/vehicle-models.json`. Full exported bounds fit the existing conservative 4.6 x 2.0 m traffic envelope. This does not alter simulation collision dimensions or claim five unique engine recordings: the three smaller/passenger families use shared recorded source profiles as declared.

AgentLayer draws a separate instanced near batch and a coarser runtime voxel proxy per family, keeps family selection deterministic from actual actor IDs, uses each family's wheel radius/wheelbase, and accounts all batches within its existing draw-call budget. Existing player-car assets remain the missing-family fallback. A packed model loader now uses the existing meshopt-enabled loader factory.

Validation: focused tests check exact output hashes, native GLTF decoding, no image dependencies, four wheel hubs/spin/steer contracts, round wheels and actual GLB bounds/triangle budgets. They also draw all five families through AgentLayer and assert its draw-call limit. In-game appearance, wheel/fender fit in motion, shadows and native-renderer performance remain review items; `visualApproved` stays false pending that review.
