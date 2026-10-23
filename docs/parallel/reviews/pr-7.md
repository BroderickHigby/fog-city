## Independent review (coordinator): mergeable after fixes, plus follow-ups on what's already in integrate/wave2

I reviewed with read-only git; nothing was run. Findings marked *checked* I confirmed at the cited lines.

**This PR (8c6dff9, 991aaff):** ownership is fine, there are no forbidden APIs and no golden churn.

1. **medium**, `src/sim/gameplay-world.ts:5` (checked)
   - **Problem:** `bay` is a single refill point with a radius. The wave-2 Pipeline row asks for a Bay-edge refill *polygon*.
   - **Fix:** add a polyline or polygon form to `GameplayWorldData` and `schemas/tile-gameplay.schema.json` before Lane 1 builds against it.
2. **medium**, `src/sim/contract.ts:57-63` and `gameplay-contract.ts:29`
   - **Problem:** `gameplay.command` and `threat.spawn` aren't in `SimEventKind`. Lane 5 already emits the raw string `"threat.spawn"`, so a typo on either side fails silently.
   - **Also:** `ThreatSpawnRequest.player {x, z}` puts floats into an event payload. The rule is that events carry ids, enums and integers only.
   - **Fix:** add the constants, and carry a body id instead of a position.
3. **low**, `tests/sim/gameplay-contract.test.ts:11,32`
   - **Problem:** both tests are tautologies.
   - **Failure:** nothing loads `manifest.layers.gameplay`, which is Lane R's `src/io`, so the layer is dead in the game while these tests pass.
   - **Fix:** file the loader request to Lane R.

**Missing roadmap acceptance tests (wave-2 Sim-World and Harness):**
- `fogDensity` = 0.
- The clock tick table, the follower-stuck test (no AI car stuck over 10 s), and the empty `src/sim/{clock,fog,vehicles}` stubs.
- Cross-browser hashes, hunter goldens and the clearance soak.
- `tests/helpers/drivers`, `golden:update`, `scripts/bench` and the nightly workflow.

**Follow-ups on commits already merged into `integrate/wave2` (lane 2 owns them as integrator)**
- **M1, high**, `step.ts:71` (checked)
  - **Problem:** `upgradeState` maps v2 straight to v6. v6 is a v2-shaped state, so it lacks qa/sim's v3/v4 fields (`foot.vy`, `grounded`) and the dodge's v5 fields (`foot.dodge`, `car.nearMisses`, `ext.dodge`).
  - **Failure:** once those branches land, `if (s.version === SIM_VERSION) return s` passes v6 saves, logs and goldens through untouched, which gives undefined/NaN in foot physics. `tests/sim/wave2-interface.test.ts:34,38,48,55` hard-codes "v6 ≡ v2" and "4 and 5 throw".
  - **Fix:**
    1. Make `upgradeState` a recursive chain (1→2→3→4→5→6).
    2. When the integration lands, bump to 7 with a 6→7 step that reshapes v2-bodied v6 states.
    3. Replace the v2 replay-hash check with "the v2 log replays to completion" plus a new golden.
- **M2, medium:** interface gaps.
  - **Single hook:** there is only one post-movement hook. Sim-Agents works around it, and registers under `robots` because `stepAgents` writes `ext.agents`. That breaks "one system owns one ext key".
  - **Placeholders:** 12 of the 14 ext types are `JsonObject` placeholders, and `dodge` isn't reserved.
  - **Fix:** add a motion-proposal phase in the next interface PR, and reserve `dodge`.
- **M3, medium**, `combat/systems.ts:73` (checked)
  - **Problem:** combat is merged, but the registered list is empty, because `createCombatSystem` needs a provider that Core hasn't supplied.
  - **Failure:** combat never runs in `step()`, and no test drives it through `step()`.
  - **Fix:** supply the provider, plus an end-to-end test.
- **M4, low**, `step.ts:205` and `systems.ts:45-46`
  - **Problem:** with no roads, `moved.ext === prev.ext`, so a system that assigns into `context.state.ext` mutates `step`'s input.
  - **Fix:** copy `ext`, and run the systems against a deep-frozen `prev` in the purity test.
- **M5, low**, ee21b4d
  - **Problem:** a commit edits `index.html`, which belongs to Lane R, under a "Render-World:" prefix. The content is identical to Lane R's `fix/favicon-subpath`, so it merges cleanly.
  - **Fix:** leave Lane R's files to Lane R in future.
