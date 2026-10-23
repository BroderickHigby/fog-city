# Lane 4: Sim-Combat

## Now
Building the deterministic combat package on `lane/sim-combat/wave2`, based on `integrate/wave1` at `2deafc912ea0971440b541e800158b258c548275`. The handoff rules are on `docs/parallel-handoff` at `38065dd3c48970ab42c97d2bb0d104eee403ed7c`.

## Done
- Inspected the handoff, current shared simulation, and combat design.
- Created a separate checkout to preserve existing uncommitted prototype work.

## Next
Water collision and conservation, rust/drying/melt, refills, scans, attacks, cones, and adversarial acceptance tests; then the wave-3 through wave-5 extensions.

## Blocked on
- No `integrate/wave2` or lane-2 interface branch exists in the published refs. Shared `Action`, `ext` ownership, actor metadata, and system registration need lane 2's interface PR.
- GitHub API access currently returns Forbidden; Git fetch works. Draft-PR creation may need `api.github.com` allowed in environment settings.

## Requests for other lanes
- Lane 2: publish the combat system hook and action/event interfaces. This package will expose a pure context-based reducer without editing shared files.
- Lane 3: provide stable actor IDs, good/bad firmware, posture/age/protection flags, and apply combat movement/attack constraints.
- Lane 1: provide refill locations and weather exposure from world data.
- Lane R: render water, rust, seized/slumping/heap states, scale and puddle fields; verify drawn height <=40% within two seconds of seizure.
- Lane 7: consume tank, salt, scan and effect outputs.
- Lane 8: supply keys for wet/scan/melt dialogue.

## For the owner
No design changes or paid services are proposed. Integration and visible-effect claims remain pending the owning lanes' hooks.
