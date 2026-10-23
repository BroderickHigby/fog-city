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
