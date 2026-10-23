# Runtime agent lifecycle repair

Based on the current reviewed core integration. The physical population used to restore
every runtime-owned body after distance culling. It now keeps the population result, so
cross-city travel does not leave frozen collision bodies behind.

Disposable runtime actors retire when they leave all active fidelity anchors. Retired
transient records disappear after their physical body is removed. Mission-bound retirement
records remain available to the mission staging owner, and active pending-admission actors
remain queued. Significant ambient actors retain their stable identity without a physical
body and pass normal admission when they return to the active area.

Reaction perception now checks the existing 40 m maximum sensing range before querying
building visibility. This preserves the reaction ranges and avoids long city-wide visibility
queries for distant players. Content geometry reached by the simulation uses explicit
square-root distance rather than engine-dependent `Math.hypot`.

Validation:

- Six of the seven new regressions fail on the unchanged core implementation.
- TypeScript and the targeted lifecycle, runtime, staging, physical service and content
  tests pass: 33 tests across five files.
- The new tests cover physical removal, far claimed actors, significant actor readmission,
  5,000 transient retirements, mission tombstones, pending admission, visibility broadphase
  cost and transitive portable arithmetic.
- A broader agents/composition/portable-API run passed 250 tests. Its only failing assertion
  is the final service replay pin: pruning the retired service actor changes tick 3,600
  from `faa94d0d` to `7e6976f9`. All earlier service pins, the city/mission pins and event
  coverage are unchanged. The combined integration must deliberately re-record this pin
  after its other patches land; no golden was edited in this lane.

This is a focused repair, not a full-game performance or release sign-off. Combined world,
combat, campaign and browser verification belongs to the integration branch.
