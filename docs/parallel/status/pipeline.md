# Lane 1 — Pipeline and territory

## Now

Publishing the gameplay-world handoff on `lane/pipeline/wave2`, starting from the published core interface `9a6a107`. The original prototype is untouched. Existing city geometry and licensed source layers are reused; the integration base already contains 583 built SF tiles, 33,081 sidewalk nodes, 58,007 sidewalk edges, 4,223 hydrants, 285 fountains, 135 transit patterns and 3,260 stops.

## Done

- Read the lane handoff, data-source inventory and core/shared contract.
- Created an isolated worktree at `/workspace/fog-city-pipeline`.
- Audited existing layer shapes and pinned `2026-10-20` source snapshots.
- Identified that the practical wave-2 gap is an indexed, provider-ready gameplay layer and safe anchors, rather than missing citywide tile generation.
- Added `gameplay.json` (2.52 MB): 583 tile indices, 5,205 refill interactions, 807 procedural service/activity candidates, and all 10 design territory rows.
- Kept complete sidewalk endpoint references at tile seams, including segments crossing a tile without either endpoint inside it. Indexed transit segments by geometric intersection.
- Added an offline index rebuild/check command and connected the same generator to the full build.
- Synthetic seam, determinism, safety, malformed-ID and far-outside transit tests pass. The full-build fixture publishes the shared schema too.
- Integrated Lane 2's `8c6dff9` and imported its shared gameplay types instead of maintaining duplicate contracts.
- All 62 focused pipeline tests pass (index, committed-world schema/references/territory coverage, build fixture, existing layers and budgets). Offline regeneration is byte-identical. No district lacks a garage candidate.
- Pushed the initial checkpoint as `34d4984` on `lane/pipeline/wave2`; the functional data commit is `436aa32`.

## Next

Publish the final hardening checkpoint, then review new mission copy and integrated runtime seams as requested by Lane R. Later-wave physical certification awaits the coordinated QA collider/surface migration.

## Blocked on

- QA geometry from `qa/pipeline` depends on shared surface changes in `qa/sim`; this lane will not merge those over the published core interface without Lane 2 coordinating the migration.
- The world QA gate remains owned by Lane R. Pipeline coverage and budgets do not imply visual continuity or release approval.

## Requests for other lanes

- Lane 2: shared schema/types published in `8c6dff9`; incorporating them for schema verification. Retain the existing sidewalk/transit files and ID formats.
- Lane 3: consume existing sidewalk nodes/edges, mapping `crossing` to the policy's crosswalk kind; retain node elevation in physical body placement. Request optional stairs/signal fields before final schema publication.
- Lane 5: consume deterministic safe anchor candidates; progression and unlock rules belong to the player lane.
- Lane R: keep the world QA gate and reviewed geometry integration authoritative; this lane does not raise budgets or bypass the gate.

## For the owner

No new paid services, unknown-license sources, or tile-budget changes are proposed. The source inventory already records PDDL/public-domain datasets and procedural fallbacks. GitHub API access is blocked in this environment; branch pushes and complete draft PR text will be supplied here.

## Draft pull request

Title: Pipeline: index city gameplay data and safe service anchors

Base: `integrate/wave2`; branch: `lane/pipeline/wave2`.

Body:

The committed city already had sidewalks, transit and water-source layers, but no tile-indexed gameplay handoff. Add a deterministic `gameplay.json` layer with complete sidewalk crossings, transit references, safe fresh/salt refill points and procedural service/activity candidates. Preserve original source IDs and geometry; publish design territory coverage without activating districts.

The full builder emits the layer, and an offline command rebuilds it from existing committed data without downloads or tile regeneration. Placement checks exclude water, building footprints and traffic lanes; candidate services remain subject to content progression and driving-route validation. The world QA geometry gate remains open and this change does not claim bridge/tunnel/stair readiness.

Validation: `pnpm exec vitest run tests/pipeline/gameplay-index.test.ts tests/pipeline/gameplay-world.test.ts tests/pipeline/build-fixture.test.ts tests/pipeline/layers.test.ts tests/pipeline/budgets.test.ts --maxWorkers=2` — 62 passed. `node pipeline/build-gameplay.ts --check` — byte-identical. Typecheck passed after merging the shared contract; final hardening typecheck pending below.
