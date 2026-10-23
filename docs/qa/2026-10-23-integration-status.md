# Integration checkpoint — 2026-10-23

Branch: `codex/fog-city-multiplayer`, based on the Ferry showcase, with the gate and
simulation QA branches integrated. This checkpoint repairs integration errors; it is
**not** a green world gate or a completed multiplayer implementation.

## Repairs and validation

- The cover gate now reads the baked ground colours actually drawn by the current
  renderer. It no longer imports the removed runtime park-tint module. The wiring
  regression still rejects a second runtime tint and requires vertex colours.
- The pack-versus-JSON determinism gate now preserves building undersides, decks,
  tunnels and movable structures in the JSON world. Previously it compared two
  different worlds. All six fixture comparisons now have zero hash mismatches.
- The building accounting gate counts unique source footprints instead of treating
  every terrace/span piece as a new source building. It still fails: the report says
  175,604 kept while 172,937 source footprints reach the collider files. The ledger
  needs to account for later removal/replacement; the zero-difference target remains.
- Refreshed `landmark-sites.json` from the committed world and rebuilt the supported
  Sutro, bridge and interim landmark targets with Blender 4.5.14 LTS. Seven GLBs
  changed. The landmark suite passes all 59 tests, including Sutro road clearance.
- Landmark policy now follows ID-only storefront anchors onto terrace/span pieces.
  The Saints Peter and Paul test measures its original >15 m exterior clearance
  against the union of church pieces, excluding artificial terrace seams.
- Corridor clearance now preserves verified landmark source IDs from the stale
  demolition heuristic. Road cuts and spans still apply, including on the second
  clearance pass. Three synthetic regressions verify preservation, open roads,
  derived IDs and continued removal of genuinely unverified stale footprints.

Final focused run: `pnpm typecheck` passed. Vitest ran the preservation, landmark
content, landmark assets, world-baseline and world determinism files with two workers:
**102 passed, 2 failed; 4 files passed, 1 failed**. Both failures are the missing
ballpark in the committed world and its missing storefront anchors.

The earlier broad run was exploratory: **2,918 passed, 96 failed, 8 skipped,
5 runner errors**. Restricted loopback sockets caused server-test failures and a
stalled worker was terminated. These numbers must not be presented as a clean full
verification. `pnpm verify` has not passed. No baseline values were loosened and no
tests were skipped by this patch.

## Ballpark regeneration prerequisite

`public/tiles/sf/report.json` lists `201006.0000003` in `clearance.staleDropped`.
The old heuristic inferred demolition from a newer road edit and a missing assessor
year. The source repair above prevents that inference for the verified landmark;
the committed world still needs regeneration through `pipeline/build-world.ts`.

The supported offline check stops immediately because the raw DataSF building cache
is absent. The current network policy returns HTTP 403 for `data.sfgov.org`; raw
elevation data also requires `elevation.nationalmap.gov`. A saved environment network
draft is not a runtime policy change. Once data access or a valid cache is available,
regenerate with the supported pipeline, run its byte-identity check, refresh landmark
sites/assets if they change, and rerun the content suite and full world gate. Do not
patch the collider pack or tile GLBs manually.

## World gate work still open

The gate also reports historical data/route defects and baselines that need tightening
after improvements. Examples requiring follow-up:

- Three stopped showcase routes versus baseline two: buildings `201006.0021655`
  and `201006.0058920`, plus a wall on the Twin Peaks route near 37.75756,-122.44789.
- Fillmore between Broadway and Vallejo measures 25.88% grade against 24% ±1.5%.
- Lake Merced allows 780 m of driving versus baseline 620 m.
- A Golden Gate freeway approach measures 345.06% grade versus baseline 143.22%.
- Published-height mismatches: 250 Howard (184.63 m versus 167.6 m) and 1550 Mission
  (14.32 m versus 116 m).
- The old pipeline Saints Peter and Paul probe still identifies the neighbouring
  apartment record; the content table's church probe is correct.

Large improvements also fail the intentional stale-baseline rule (for example the far
seam drops from 7.44 m to 0.91 m, and far-above-near area falls to zero). Re-measure and
lower those baselines after resolving regressions; do not accept worse values to make
the suite green. Some apparent building wall/duplicate defects need their measuring
logic checked against intentional span undersides and terrace/tower relationships.

All heavy commands in this checkpoint ran singly under the handoff lock with an
8 GiB Node heap and at most two Vitest workers. The headless Blender shim is local
environment setup at `/workspace/.cache/fog-tools/blender45`, backed by the official
PyPI `bpy==4.5.14` wheel in a Python 3.11.14 virtual environment.
