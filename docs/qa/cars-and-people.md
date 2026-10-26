# Cars and people acceptance

Requested October 25, 2026: more car colours and original artwork, regular cars passing roughly every 30 seconds, forward-facing feet when running, a slightly faster run, and people standing on the asphalt rather than sinking into it.

## Playable result

- Cars use a varied palette and original patterned artwork on painted panels. Glass, tyres, lights and functional vehicle parts retain their materials. Artwork contains no real company identity.
- Ordinary cars use the civilian-car model and follow real drivable streets. They share traffic collision and yielding rules. They are not offered as robotaxi rides or enrolled as robots for combat/conversion.
- A clear street near the player admits approaching civilian traffic at 30-second simulation intervals, within the existing population budget. A blocked street must yield safely; no car may be forced through a person or vehicle to meet a timer.
- Jogging is 3.5 m/s and sprinting is 8 m/s. Animation cadence follows movement speed. Collision, protected-person and dodge requirements remain in force.
- The player and every shipped near-crowd character keep their shoes at or above the supplied support plane throughout locomotion and transitions. Stance feet face the running direction; airborne heel kicks retain their natural ankle pitch.
- Pedestrians at every detail tier use the loaded street geometry's support height, just as the player's avatar does. Removing a tile removes its height correction. Ground matching must not snap people onto roofs or distant bridge decks.

## Required evidence

Use actual shipped GLBs and animation clips for shoe penetration and toe alignment checks, plus side/rear visual comparison. Test the rendered-floor index through the ambient layer, including skinned near characters and procedural proxies, without changing simulation positions. Exercise civilian admission, passing, yielding, bounds and reproducibility on a real-SF clear street, and retain clearance/traffic tests. Verify paint-only material changes on real vehicle models and include a visual preview.

Admission must work at ordinary 100 m block midpoints and across connected short links, including legal one-way incoming streets, while respecting junction holds and surviving a JSON save round trip mid-approach. Exercise actual passing on the shipped SF one-way frontage as well as two-way fixtures. When a player's population is full, admission must not evict another player's taxi or exceed the local cap. Riders, hailed cars, mission-bound and significant actors, and service/runtime vehicles remain protected from capacity replacement.

These changes advance the simulation behaviour version together. Preserve historical saves and recordings, add the canonical upgrade step and previous-version replay coverage, and add explicitly named current-version golden pins without overwriting historical fixtures. Run focused checks before the complete verification suite and packed static build. A draft preview is not a public release or a passing full verification result.
