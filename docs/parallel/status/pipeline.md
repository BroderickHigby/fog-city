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

Validation: `pnpm exec vitest run tests/pipeline/gameplay-index.test.ts tests/pipeline/gameplay-world.test.ts tests/pipeline/build-fixture.test.ts tests/pipeline/layers.test.ts tests/pipeline/budgets.test.ts --maxWorkers=2` — 62 passed. `node pipeline/build-gameplay.ts --check` — byte-identical. Final `pnpm typecheck` passed. Hardening checkpoint `2ce6e9d` is pushed.

## Independent content read (2026-10-23)

At Lane R's request, `/root/lane1_pipeline` read every player-facing line in the following Lane 8 files, including labels, cast roles, actor notes, hints, choices and summaries. Checklist: stated/implied punching down; ethnic/accent caricature; claims about real people/events; real brands; encampment/disease language; juxtaposition with real SF street names. No checklist failure found in this snapshot. This is an independent agent read, not the user sample review or a gameplay readiness claim.

| File | SHA-256 of reviewed bytes |
| --- | --- |
| `content/ui-copy.json` (180 strings) | `feb4e6b92d04e16c194af277c3cf5c994597b42b9572569d73c4e2f426b6175a` |
| `content/missions/launch-day.json` | `66795b8c3fb4ab09754a5244052eb9dab13eec74f999c8e4ec16028ef7baa5b6` |
| `content/missions/demoed-correctly.json` | `256adb356e576d75e5ddccf1416ec7a3a7e297fa4255e85d309214267c60eefb` |
| `content/missions/demo-day.json` | `3cf90cf516c4af8cb6c9e7140a75571cf3f7a32cb406159775369648f9fc0fc2` |
| `content/missions/fleet-week.json` | `491eb94303c08f7f7bb1b686f50d0ef9800bb0a936dc2d2b7f5bf7d8f41a6389` |
| `content/missions/hill-climb.json` | `389d9f8b088a2ed50de9ccf7d751b8f2fce5776896d9b78034d826a912286656` |
| `content/missions/acqui-hire-offer.json` | `fb86abfd2f00c3692f4f728c9891770c10919e5ec0bc7f9fbc7582ae207c22c7` |
| `content/missions/marine-layer.json` | `7caeeddc892f5a06961d241ae6b82adbf6ae9179c62de7b194690ff521c89f85` |
| `content/missions/comeback-round.json` | `6cbf563ecb70b05d0b04b2254b678ed7f394f9885649ed5c4ff400e13d4cf72c` |

Also read all vendor blurb changes and the generic `Royale`/`Award` additions against the wave-2 base. Suggested neutral disconnect text because “Your progress is safe” currently promises an unverified multiplayer save guarantee.

### Runtime integration findings sent to the owners

- New mission event objectives require authoritative producers (scanner false positive, pitch window, Lombard chase, cable-car boarding, teleoperation, fog fleet and boss phases). No current producer was found in the player runtime at the reviewed snapshot. Authored events alone cannot make these missions playable.
- Launch Day scans the suspect, then waits for a false-positive event on the harmless courier. Add an explicit action/instruction for the harmless scan or a deterministic scenario-generated observation; do not require an unexplained event.
- The mission interpreter emits an authored `stat: xp` grant as `mission.stat`, which progression ignores, then substitutes a formula XP grant. Respect the authored amount and test one-time payment.
- The promised `app:scanner-tier-2` reward reaches inventory but has no progression handler; the actual combat scanner tier stays 1.
- The new `advanceOnAnyOutcome` campaign property needs interpreter support, or a non-success partner-pitch result blocks later missions.

Lane 5 and Lane 8 have the actionable findings. Core's clearance candidate is not yet published; accepted-body and scheduling review will use its stable checkpoint rather than mislabel unfinished integration as a regression.

## PR #8 review remediation and Lane 2 dependency audit

Work remains on `lane/pipeline/wave2`; no off-plan integration or render branch was changed.

- **H1:** full generation and standalone indexing now share the exact tile/land/footprint predicate and gameplay metadata ordering. Standalone indexing also updates the report counts. A synthetic full-build → re-index regression requires byte equality of `gameplay.json`, `manifest.json` and `report.json`, and covers the outer tile seam where neighbouring heightfield interpolation previously admitted out-of-world points. Full SF `build-world --offline --check` remains blocked by the missing pinned source cache; no claim of full-city regeneration is made.
- **M2:** Core #7 is still an integration dependency. No other lane's changes were merged into this branch during remediation; Lane 2 must land its reviewed interface before closing #8.
- **M3:** the committed index is regenerated from this branch's current world data and must be regenerated again when QA geometry lands. No tile geometry, heightfield or source ID was fabricated.
- **L4:** the source inventory now identifies the shipped procedural car-wash and repair-kiosk candidates instead of saying they are absent. They remain candidates, not active businesses.

Read-only Lane 2 audit at `991aaff`: its 54 interface/gameplay/purity tests pass, but an independent runtime probe reproduces the review findings: v2→v6 leaves `foot.vy`, `foot.grounded`, `foot.dodge` and `car.nearMisses` absent; versions 3–5 are rejected; default `SYSTEMS` is empty; and a reducer assigning to `context.state.ext` mutates an unfrozen input state's extension. Those findings require Lane 2's reviewed migration/registration/purity work. This lane did not edit Core or claim those issues fixed.

Requests for Render-World / Assets: full verification also reports that the static web build's `RUNTIME_LAYERS` omits `gameplay`, despite the loader reading it (`tests/io/assets.test.ts`). That packaging fix is outside this lane and is needed before a production wave-2 build can supply the index. The Pipeline schema sweep now validates `gameplay.json` against `tile-gameplay.schema.json` instead of omitting the layer or looking for a nonexistent `gameplay.schema.json`.

Salvage references only (not merged here): the prior `feature/latest-showcase` candidate `d269fec` includes rendering work; `f465dcc` contains tree-instancing, height/budget and licence-packaging fixes. Lane R should review those render-owned changes. The prior gameplay fork is not a replacement for the canonical wave-2 integration. All frozen branches remain untouched by this remediation.

Verification of this remediation: typecheck passed; all **161 Pipeline tests** passed, including full synthetic-build/re-index byte identity and committed schema/budget checks. The committed SF gameplay index passes `build-gameplay --check` with unchanged 583 tiles / 5,205 refills / 807 anchors. `pnpm verify` was run; after correcting the Pipeline schema sweep, the final serialized typecheck/whole-Vitest rerun reports **2,636 passed, two failed, one skipped across 78 files**. Remaining failures are `tests/io/assets.test.ts` (runtime gameplay layer omitted by the web packer) and `tests/schemas/schemas.test.ts` (looks for `gameplay.schema.json` instead of `tile-gameplay.schema.json`). Browser verification did not run because the unit stage remains red. No CI pass, merge readiness, full offline SF rebuild, or game-completion claim is made.
