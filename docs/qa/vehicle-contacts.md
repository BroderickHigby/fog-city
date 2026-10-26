# Solid vehicle contacts

The owner reported cars absorbing into one another. Three independent causes were reproduced locally before repair: simultaneous moving cars penetrated 0.438 m before an impact was detected; normal taxi jam recovery eventually produced a full 2 m overlap; and the personal GLB was 2.270 m wide around a 1.900 m physical body, permitting 0.370 m of visual interpenetration at valid side contact.

## Changes

SIM_VERSION 18 adds a deterministic final vehicle contact pass after individual movers/impacts and before pedestrian dodge and ride settlement. Full oriented hulls and height bands cover personal, parked, ambient, manual taxi and runtime service vehicles. Spatial candidates and bounded relative sweeps detect both moving trajectories, including crossing and turning. Travel is shortened to a safe contact rather than pushing normally separate cars sideways. Existing impact rules still exchange momentum, spin and dents; contacts removed by an earlier obstruction do not hit a distant car. Path cursors and both taxi/service controller memories follow corrections. Older overlapping saves receive bounded, validated recovery with a per-body displacement budget. Jam recovery can relax junction priority but cannot ignore physical cars.

The renderer fits each adopted personal GLB/fallback proportionally within its physical footprint, including translated/rotated asynchronous adoption, without editing shared geometry. Wheel rolling uses the fitted radius.

Old replay behavior is version gated. An actual v17 save was recorded from main a95ca99bec243c10dd9983776ec83c5e6231bfe1 before migration, with source fingerprints and ordinary continuation controls. The migration retains every saved field. All existing golden JSON files are preserved; v18 has separate current pins.

## Local verification

Heavy commands run serially with Node 22 and a 2048 MB heap; unit batches use one worker. No hosted CI was requested. Separate batches must not be summed into a full-suite result.

- Four original failing overlap regressions now pass, including the full 3,000-tick naturally generated taxi deadlock escape.
- Fifteen full-hull/contact tests pass, covering crossing, corners, height separation, co-moving contacts, paired impulses/dents, duplicate suppression, stale three-body contacts, route/controller coherence, turning velocity, immutable/plain JSON output, and bounded recovery.
- Existing impact, driving dynamics, motion, ride, civilian traffic, follower, agent and determinism batch: 142 passed across 15 files.
- Personal renderer adoption/bounds/appearance/HUD batch: 17 passed.

The previously recorded allocation/performance hold remains open. These checks do not establish full-city frame rate, physical RAM plateau, or a complete verify-suite pass.
