# Solid vehicle contacts

The owner reported cars absorbing into one another. Three independent causes were reproduced locally before repair: simultaneous moving cars penetrated 0.438 m before an impact was detected; normal taxi jam recovery eventually produced a full 2 m overlap; and the personal GLB was 2.270 m wide around a 1.900 m physical body, permitting 0.370 m of visual interpenetration at valid side contact.

## Changes

SIM_VERSION 18 adds a deterministic final vehicle contact pass after individual movers/impacts and before pedestrian dodge and ride settlement. Full oriented hulls and height bands cover personal, parked, ambient, manual taxi and runtime service vehicles. Spatial candidates and bounded relative sweeps detect both moving trajectories, including crossing and turning. Travel is shortened to a safe contact rather than pushing normally separate cars sideways. Existing impact rules still exchange momentum, spin and dents; contacts removed by an earlier obstruction do not hit a distant car. Path cursors and both taxi/service controller memories follow corrections. Older overlapping saves receive bounded, validated recovery with a per-body displacement budget. Jam recovery can relax junction priority but cannot ignore physical cars.

The renderer fits each adopted personal GLB/fallback proportionally within its physical footprint, including translated/rotated asynchronous adoption, without editing shared geometry. Wheel rolling uses the fitted radius.

Old replay behavior is version gated. An actual v17 save was recorded from main a95ca99bec243c10dd9983776ec83c5e6231bfe1 before migration, with source fingerprints and ordinary continuation controls. The migration retains every saved field. All existing golden JSON files are preserved; v18 has separate current pins.

## Local verification

Heavy commands run serially with Node 22 and a 2048 MB heap; unit batches use one worker. No hosted CI was requested. Separate batches must not be summed into a full-suite result.

- Four original failing overlap regressions now pass, including the full 3,000-tick naturally generated taxi deadlock escape.
- Twenty full-hull/contact tests pass, covering crossing, corners, height separation, co-moving contacts, paired impulses/dents, duplicate suppression, stale three-body contacts, route/controller coherence, turning velocity, immutable/plain JSON output, and bounded recovery.
- Existing impact, driving dynamics, motion, ride, civilian traffic, follower, agent and determinism batch: 142 passed across 15 files.
- Personal renderer adoption/bounds/appearance/HUD batch: 17 passed.

The previously recorded allocation/performance hold remains open. These checks do not establish full-city frame rate, physical RAM plateau, or a complete verify-suite pass.

## Final candidate and native proof

Game code tested at `70748d3bd29928b8bcd6a6816f4c67388ef9640c`; the later `54511c730aa4d8496b81719c269dad3e383fae7a` changes only the QA harness. Final functional batch: **283 passed across 22 files**, 119.48 s; separate final golden/save batch: **89 passed across 13 files**, 27.37 s. Full TypeScript check passed. Both independent Standards and Spec reviews passed on the game code; their two discovered edge cases (intact-tree recovery clearance and clear turning-away motion) were repaired and regression tested.

The native packed SF test uses actual Apple M4 / ANGLE Metal node-WebGL, ordinary controls and real rendered vertices, including civilian wheel shader deformation. The real impact is player p1 against civilian car7 at tick129. It measures the same struck ID for all48 aftermath frames and every tick124–184 during a fresh-page replay: **61 contiguous rendered frames, maximum measured hull penetration0m**, and exact final state hash `26a4d2cc` after184 ticks. No GPU/page errors occurred. Root visually inspected exact-impact and final-aftermath captures. This is reduced-load mechanics evidence, not frame-rate acceptance.

Earlier harness runs incorrectly assumed the struck civilian used robotaxi GLB parts; a subsequent run also retargeted its aftermath. Those runs are invalidated and excluded from acceptance. The final harness explicitly locks the struck ID, checks the real draw roster and complete collision window, and reproduces the recorded hash on a fresh page. There is no game-state replacement, teleport, forced collision, or proxy-only acceptance.

[Compact proof and lossless ordinary input recording](evidence/vehicle-contacts-final.json) · [Exact impact capture](evidence/vehicle-contact.png) · [Updated local game](evidence/vehicle-local-game.png).

Reproduce against a separately served packed SF candidate with the explicit source head:

```sh
node --max-old-space-size=2048 scripts/qa/vehicle-contacts.ts --artifact /absolute/packed-build --url http://127.0.0.1:4371/ --out /absolute/evidence --world sf --expect-sha <HEAD>
```

The packed candidate contains190 files,183.6MB at gzip level1, within the unchanged hosting limits, with no source maps. The canonical local preview serves that tested artifact at port5173. Historical QA reports and the allocation/performance hold remain unchanged. CI is intentionally skipped under the owner's instruction.
