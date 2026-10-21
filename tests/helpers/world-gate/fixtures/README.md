# World gate fixtures

Small reference data the world-continuity gate (`docs/qa/world-continuity-gate.md`) measures the
committed world against. They are derived once from the QA run's evidence (its scratch folder,
`qa-world/`, not committed) and the committed world at 544f67c, and they change only when the
reference itself changes, never to make a metric pass. Open-data sources keep their licences
(DataSF: ODC PDDL; USGS 3DEP: public domain).

| File | What | Source |
|---|---|---|
| `newer-parcels.json` | 122 assessor parcel points built 2015 or later, with storeys, that had no footprint record within 25 m (W-04) | 2025 assessor roll (DataSF wv5m-vpq2), QA verify-buildings v04 |
| `buried-sites.json` | 31 records whose roof lay under the ground: the worst point and its outward normal (W-05) | QA verify-houses v01 |
| `grade-crossings.json` | 324 places where a surface street crosses a freeway or ramp, with the street's edge and direction (W-03, W-14) | QA verify-play pc04 |
| `rec-park-properties.json` | the 255 Recreation and Parks properties, simplified to 1.5 m, in local metres (W-18) | DataSF gtr9-ntp6 |
| `summits.json` | 25 named summits: point, published height and 3DEP DEM maximum within 150 m | QA terrain c4 |
| `dem1m-profiles.json` | 1 m DEM heights every metre along Vermont St, Twin Peaks Blvd, Vasquez Ave and Kensington Way (W-31) | USGS 3DEP 1 m, fetched by the QA run |
| `lakes.json` | the eight hydro-flattened lake surfaces as lattice vertex runs, with their levels (W-11) | QA terrain c1f seeds, flood-filled on the 544f67c lattice |
| `start-blocked.json` | 58 street drives whose start pose overlaps a footprint (W-51) | QA critic c2 |

`scripts/golden/world-fixtures.ts` is how they were made (from the QA evidence folder, for provenance).
