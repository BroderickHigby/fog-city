# Lane 1 — Pipeline and territory

## Now

Building the gameplay-world handoff on `lane/pipeline/wave2`, starting from the published core interface `9a6a107`. The original prototype is untouched. Existing city geometry and licensed source layers are reused; the integration base already contains 583 built SF tiles, 33,081 sidewalk nodes, 58,007 sidewalk edges, 4,223 hydrants, 285 fountains, 135 transit patterns and 3,260 stops.

## Done

- Read the lane handoff, data-source inventory and core/shared contract.
- Created an isolated worktree at `/workspace/fog-city-pipeline`.
- Audited existing layer shapes and pinned `2026-10-20` source snapshots.
- Identified that the practical wave-2 gap is an indexed, provider-ready gameplay layer and safe anchors, rather than missing citywide tile generation.

## Next

Publish the exact additive gameplay schema to Lane 2, implement deterministic per-tile indexing and safe refill/garage/repair/activity anchors, validate coverage and byte-for-byte regeneration, then certify later territory steps against the existing city.

## Blocked on

- QA geometry from `qa/pipeline` depends on shared surface changes in `qa/sim`; this lane will not merge those over the published core interface without Lane 2 coordinating the migration.
- The world QA gate remains owned by Lane R. Pipeline coverage and budgets do not imply visual continuity or release approval.

## Requests for other lanes

- Lane 2: add `manifest.layers.gameplay` and the agreed gameplay JSON schema/shared types. Retain the existing sidewalk/transit files and ID formats.
- Lane 3: consume existing sidewalk nodes/edges, mapping `crossing` to the policy's crosswalk kind; retain node elevation in physical body placement. Request optional stairs/signal fields before final schema publication.
- Lane 5: consume deterministic safe anchor candidates; progression and unlock rules belong to the player lane.
- Lane R: keep the world QA gate and reviewed geometry integration authoritative; this lane does not raise budgets or bypass the gate.

## For the owner

No new paid services, unknown-license sources, or tile-budget changes are proposed. The source inventory already records PDDL/public-domain datasets and procedural fallbacks. GitHub API access is blocked in this environment; branch pushes and complete draft PR text will be supplied here.
