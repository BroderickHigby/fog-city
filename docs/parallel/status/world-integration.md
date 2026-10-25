# Structural world integration

Based on Core `6f1d91b`, with the committed SF geometry and producer from Ferry `451f4dc`.

This candidate adds the collider extension decoder and matching physical surfaces: decks, tunnel bores, stair barriers, inland-water boundaries, building undersides and piece identifiers. It preserves the composed game registry, optional gameplay/sidewalk/transit metadata, runtime identity and protection logic, aim/actions and all other wave-two state fields. Rendering is integrated separately.

The simulation is explicitly version 8. A version-7 save keeps every body, extension and counter; only its version advances. Older saves continue through Core's existing repair chain. Current replay pins live in `composed-v8.json` and `wave2-v8.json`; the version-7 fixtures and legacy source saves remain intact. The legacy physical replay hashes normalized to the original version-4 header remain unchanged.

The full world producer retains the shared gameplay-index generation. Re-indexing the imported geometry produces 581 tiles, 5,292 safe refills, 800 candidate anchors and all ten territory rows. Inland lake masks now exclude candidate placement through the same predicate in full generation and re-indexing. The producer and re-indexer emit `manifest.rendering.bakedGround`, which tells the renderer to avoid tinting or stitching already-baked geometry a second time.

Validation at this checkpoint:

- Full TypeScript check passed.
- 156 focused tests passed across structural surfaces, version migration, forbidden APIs, real legacy saves, collider encoding, safe gameplay placement and synthetic full-build/re-index byte equality.
- 19 tests passed across the existing core replay, current legacy-input replay and composed-game golden replay suites.
- `node pipeline/build-gameplay.ts --check` is byte-identical.
- Full SF `build-world --offline --check` stops at the first missing raw DataSF building-cache page. The source cache is absent locally; full-city regeneration is not certified. The committed geometry was imported from the named source commit, not fabricated or edited by hand.

The incoming world's last ratchet update accepted known regressions, including the unfinished Golden Gate approach deck, the drawn contradictory Broadway Tunnel deck and a stopped Twin Peaks route. Those defects are not waived by this candidate. Strict world-gate results and combined browser/render/campaign validation remain required before release.

**Version reservation:** the safe gameplay integration reserves SIM_VERSION 8 on the retained physical world. This isolated, unreleased structural candidate still uses version 8 for its current test checkpoint. Before any future merge or release of these structural physics changes, bump this candidate to **version 9**, add and test the **8 → 9** migration, and record separate version-9 goldens. Do not release these physics changes under the gameplay-only version-8 contract.

## Strict gate checkpoint

The world gate and historical audit documents are restored from before the incoming branch's `--accept-worse` update. The numeric baselines and failing-run lists remain byte-identical to `7a4c0ea`; no value, target or tracked defect was weakened.

The first complete strict per-PR run finished with **53 passed, 78 failed and seven skipped** across 12 files. Of 116 measured numeric metrics, **66 improved, 37 were unchanged and 13 worsened**. The failed-test count also includes substantial improvements requiring tighter baselines and description changes; it is not a count of newly introduced defects.

Material regressions against that strict baseline remain:

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Maximum freeway grade | 143.22% | 345.06% |
| Largest drawn-road / sim-surface difference | 3.84 m | 6.6 m |
| Stopped closed-loop routes | 2 | 3 |
| Maximum placement rise | 0.34 m | 1.69 m |
| Airborne crossing runs | 66 | 70 |
| Far building hulls over 3 m wrong | 44 | 110 |
| Driven distance over Lake Merced | 620 m | 780 m |

Other worsening values are duplicate footprint pairs (23 to 26), buried walker stops (29 to 30), below-surface travel (0.173 to 0.404 m), two millimetre-scale motion metrics, and a 4 cm Sutro-area height change. These are recorded, not accepted away.

The shared height-aware line sweep `segmentBlockedBand` is also added for runtime actors and motion. It retains the original polygon/spatial-index implementation while testing each building against the caller's vertical body band. Its focused run passed TypeScript and 28 surface/replay/segment tests; importing its callers is coordinated separately.

Logs and comparison: `/tmp/fog-world-gate.log`, `/tmp/fog-world-gate-comparison.json`, `/tmp/fog-world-band.log`. The historical documents describe their original world; this checkpoint describes the integrated candidate and its current release hold.

## Lake safety follow-up

The runtime now recognises both the collider pack's inland-lake mask and the equivalent JSON cover digits. A car already on unsupported water loses propulsion and brakes in place; it is not moved to a different bank. Decks, tunnel floors, roofs and existing bridge corridors retain their normal handling, as does an airborne car over water.

The official drive measurement now records **0 m driven on Lake Merced**, down from 780 m, within the unchanged 10 m target. Every other drive metric and failing-run list is unchanged from the checkpoint above. The strict baseline is still unmodified, so its stale-baseline rule continues to flag this large improvement until a later reviewed tightening. Nine collider encoding/JSON/pack tests pass. The official cross-format deterministic replay also passes with zero hash mismatches.

The legacy boundary test also now discovers the actual southern county-line wall. Its old fixture assumed a straight wall on the z = 10000 tile border; the new world places that boundary inside the final row of tiles. The collision and height assertions are retained. This exposes an additional unresolved failure: the southern-boundary drive at x ≈ 1450 records **2.1978 m of wall overshoot**, against the existing 0.02 m limit. The assertion remains red; this is another reason to hold the structural candidate.

Final focused run: TypeScript passed; **136 of 137 tests passed**, including all seven lake cases, the surface tests, deterministic-API checks and unchanged candidate-v8 goldens. The southern-boundary assertion above is the one failure. Logs: `/tmp/fog-world-lake-check2.log` and `/tmp/fog-world-lake-gate.log`. No full world baseline refresh was performed.
