## Independent review (coordinator): mergeable after fixes

**What holds up:**
- **Licences:** PDDL or USGS public domain, with no OSM or Google data, and every dataset has a procedural fallback.
- **Tests:** they read committed files only, with no network.
- **Scope:** the lane's own commits stay inside its paths, and no tiles were regenerated.

1. **high**, `pipeline/lib/build.ts:511-513` vs `build-gameplay.ts:60`
   - **Problem:** the full build inserts `layers.gameplay` between `transit` and `signals` and adds `gameplayRefills`/`gameplayAnchors` to `report.json`. The committed manifest has `gameplay` last, and `report.json` is unchanged. Only `build-gameplay --check` was run.
   - **Failure:** `node pipeline/build-world.ts --world sf --check` fails on `manifest.json` and `report.json`, which breaks byte-identity. The two paths also define `isLand` differently.
   - **Fix:** regenerate with `build-world --offline`, make the key order match, and run both checks.
2. **medium:** the schema and `src/sim` contract changes come from Lane 2's unmerged commit `8c6dff9`.
   - **Fix:** merge Core's #7 first, then update this PR so the diff is lane-1-only.
3. **medium**, `public/tiles/sf/gameplay.json`
   - **Problem:** it's indexed on pre-QA geometry. `qa/pipeline` (not merged) rewrites `sidewalks.json`, `roads.json`, `hydrants.json`, `boundary.json` and the collider pack.
   - **Failure:** when Lane R lands it, sidewalk, road and hydrant ids dangle.
   - **Fix:** regenerate in that merge, and note it in the PR.
4. **low**, `docs/data-sources.md`
   - **Problem:** the "Car-wash anchors" and "Repair-kiosk anchors" rows say "Not yet", which contradicts the new section that ships procedural anchors.

**Deliverables:** partial. `gameplay.json` is a real per-tile id index over the citywide sidewalk graph. There are no per-tile graph files and no new crosswalk schema work. Lane R also needs crosswalk geometry for the photoreal streets.
