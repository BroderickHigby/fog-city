# Runtime agent lifecycle repair

Based on the current reviewed core integration. The physical population used to restore
every runtime-owned body after distance culling. It now keeps the population result, so
cross-city travel does not leave frozen collision bodies behind.

Disposable runtime actors retire when they leave all active fidelity anchors. Retired
transient records disappear after their physical body is removed. Mission-bound retirement
records remain available to the mission staging owner, and active pending-admission actors
remain queued. Significant ambient actors retain their stable identity without a physical
body and pass normal admission when they return to the active area.
Ordinary legacy taxis are the exception: their lane route belongs to the physical
population, so a taxi whose body was culled is retired instead of becoming an inert
nonlegacy replacement. Returning to the region repopulates normal traffic. Authored
mission and service vehicles keep their existing owned follower lifecycle.

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

## Legacy combat movement

Ambient lane movement now consumes combat's existing movement constraints. A hood-cone
speed cap limits the actual route distance advanced; a stopped actor cannot coast through
the cap. Slow effects scale the desired cruise speed without mutating the saved normal
cruise value, so movement resumes after combat releases the effect. Runtime-controlled
vehicles use the corresponding Core motion hook.

TypeScript and 26 focused legacy-agent, combat-movement and core replay tests passed.
Combat owns the effect-expiration fix; this consumer preserves its existing API.

The returning-traffic guard passes all eight lifecycle regressions, including leaving a
populated region, culling the marked ambient taxi and returning to freshly populated traffic.
