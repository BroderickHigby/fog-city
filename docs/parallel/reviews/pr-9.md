## Independent review (coordinator): mergeable after fixes, as unregistered library code only

Reviewed at head 7767d57 with read-only git; *checked* findings I confirmed at the cited lines.

**What holds up:**
- **Ownership:** clean.
- **Merge:** it merges cleanly with `integrate/wave2`.
- **Core types:** it builds against Core's types.
- **Determinism:** no `Math.random`, `Date`, DOM or unsorted iteration in `src/sim`, and the brain copies its state instead of mutating it.
- **Pipeline adapter:** maps Lane 1's `sidewalks.json` correctly.

1. **high**, `src/sim/agents/systems.ts:77`, and `:13-14`, `:20` (checked)
   - **Problem:** `systems` is still `Object.freeze([])`, so nothing runs. Registration relies on a `prepare()` hook and `context.observedBodies`, and neither exists in Core's `system-contract.ts`.
   - **Failure:** if it's registered as a plain system, brains decide and queue attacks, but nothing applies their movement.
   - **Fix:** Lane 2 adds a movement-phase hook to the contract. Register only after that, and only then claim the wave-2 deliverables.
2. **high**, safety gap: `runtime.ts:305`, `:158-176` and `systems.ts:17`
   - **Problem:** runtime-only bodies live only in `ext.robots`. That covers pigeons, dogs, children, seated people, mission crews, vans and buses. But `feature/dodge`'s `stepDodge` protects only players and `ext.agents.list`. `dodgeOverrideActive: false` is hard-coded.
   - **Failure:** once these proposals are applied, a child or dog is invisible to the clearance override, which is exactly the Crazy Taxi rule.
   - **Fix:** before registering, admit runtime bodies into the dodge set and feed dodge state into reactions. Add a no-touch fuzz with runtime animals and children.
3. **medium**, `runtime.ts:118-119` and `:137` (checked)
   - **Problem:** default firmware calls `src/content/places.ts` `badRobotRate`, which uses `Math.hypot` (`places.ts:105`). That's engine-dependent and banned in the sim. The forbidden-API test only scans `src/sim`, so it passes.
   - **Failure:** a 1-ulp difference flips good/bad firmware on one browser engine, and the cross-browser hashes diverge.
   - **Fix:** compute the rate in-sim with `dmath`, or have Core precompute it.
4. **medium**, `services.ts:76-83`
   - **Problem:** a local `ThreatVanRequest {id: number}`, while Core's `ThreatSpawnRequest` uses `id: string` and `kind: "van"`.
   - **Fix:** consume Core's type once #7 merges.
5. **medium**, `runtime.ts:282`
   - **Problem:** `propose()` re-sorts every actor for every actor, and sensing scans all actors per bad robot. That's O(n² log n) per tick.
   - **Failure:** about 1,000 actors means about 10M comparisons per tick at 60 Hz.
   - **Fix:** sort once per tick, and use a spatial grid for sensing.
6. **low:** the roadmap numbers (van within 20 s at 120 m, bus headway, forced update) are asserted only on pure policies. Vans and buses only get speed-0 proposals, and the replay test compares a run with itself.
   - **Fix:** pin golden hashes, and add integrated acceptance tests once registered.

**Deliverables:**
- **Real:** the brain and knowledge model, reactions, fidelity, navigation and service policies.
- **Stubs:** registration, van and bus movement, and the clearance layer.
