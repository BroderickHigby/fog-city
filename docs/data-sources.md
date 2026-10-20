# Data sources and the world pipeline

The San Francisco world (`public/tiles/sf/`) is built offline from open data by one
command and committed (plain git, compressed: the 2026-10-20 tile-storage decision). The
game makes no network calls at runtime. Since wave 2 the world is **the whole city**: every
500 m tile with SF buildings, roads or land, from the Golden Gate approach and the
Presidio to Ocean Beach, the southern city limit, Hunters Point, Treasure Island and Yerba
Buena Island.

```sh
node pipeline/build-world.ts --world sf            # download (cached) + build + write public/tiles/sf/
node pipeline/build-world.ts --world sf --offline  # build from pipeline/.cache only; fail on a cache miss
node pipeline/build-world.ts --world sf --check    # rebuild in memory; exit 1 unless every file is byte-identical
node pipeline/build-world.ts --world sf --refresh  # re-download everything (DataSF reloads daily)
node pipeline/build-world.ts --world sf --fetch-only  # fill the cache and stop
```

Flags: `--cache <dir>` uses another download cache and `--out <dir>` writes elsewhere.
A cold citywide download (empty cache) took 227 s on 2026-10-20 (about 300 MB of raw
responses, 196 cached files), with at most 3 requests in flight (`pipeline/lib/fetch.ts`:
the citywide download runs datasets in parallel under that cap; an area download awaits
each request before the next). DataSF often answers HTTP 425 "Too Early" in long runs;
408/425/429/5xx are retried up to 9 times with exponential backoff capped at 60 s. A warm
build (from cache, `--offline`) takes 42–49 s on one core (measured 2026-10-20 after the
wave-1/wave-2 reconciliation). Raw responses are cached in `pipeline/.cache/http/`
(gitignored, one file per URL plus a `.url` sidecar naming it). `data.sfgov.org` now
redirects to `data.sf.gov`; the pipeline keeps requesting `data.sfgov.org` (the cache keys
stay stable) and follows the redirect. The same cache always gives byte-identical output
(`--check` proves it). The upstream datasets change daily, so a `--refresh` can
legitimately change the output: the snapshot date is pinned in `pipeline/areas.json`
(`sources.snapshotDate`), and a refresh is a deliberate PR that updates it.

## Sources and licences

The DataSF licence of each dataset was read from its metadata
(`https://data.sfgov.org/api/views/<id>.json`, field `license`) on 2026-10-20. Every DataSF
dataset used is the **Open Data Commons Public Domain Dedication and License (PDDL) 1.0**
(<http://opendatacommons.org/licenses/pddl/1.0/>). The PDDL requires no attribution; we
credit the sources anyway. The strings are in `manifest.json` `attribution`. No
OpenStreetMap (ODbL) data is used or committed.

| Data | Source | Fields used | Licence and credit |
|---|---|---|---|
| Building footprints and heights | DataSF *Building Footprints*, [`ynuv-fyni`](https://data.sfgov.org/resource/ynuv-fyni.json). Geometry `shape` (MultiPolygon). Paged in full (`intersects(shape, <city box>)`, `$order=sf16_bldgid`, 5,000 per page; `within_box` would only return footprints wholly inside the box): **177,023 footprints**, every id `201006.*`. | `sf16_bldgid`, `mblr`, `gnd_*cm` (ground NAVD88, cm), `hgt_*cm` (height above ground, cm) | PDDL 1.0. "City and County of San Francisco, DataSF" |
| Street centerlines | DataSF *Streets – Active and Retired*, [`3psu-pn9h`](https://data.sfgov.org/resource/3psu-pn9h.json). Geometry `line`. `active = true` only: 16,378 segments. | `cnn`, `streetname`, `st_type`, `classcode`, `layer`, `oneway`, `f_node_cnn`, `t_node_cnn` | PDDL 1.0. "City and County of San Francisco, DataSF" |
| Building year, use and storeys | DataSF *Assessor Historical Secured Property Tax Rolls*, [`wv5m-vpq2`](https://data.sfgov.org/resource/wv5m-vpq2.json). `closed_roll_year = 2025` (211,290 parcels), pinned in `pipeline/areas.json`. | `parcel_number`, `block`, `year_property_built`, `use_code`, `use_definition`, `number_of_stories`, `number_of_units`, `the_geom` | PDDL 1.0. "San Francisco Office of the Assessor-Recorder via DataSF" |
| Storefront anchors | DataSF *Registered Business Locations*, [`g8m3-pdis`](https://data.sfgov.org/resource/g8m3-pdis.json). Active rows only: `location_end_date`, `dba_end_date` and `administratively_closed` are all null. | `uniqueid` (hashed, never emitted), `self_reported_naics_code`, `location`. Names are never requested. | PDDL 1.0. "San Francisco Treasurer & Tax Collector via DataSF" |
| District boundaries | DataSF *Analysis Neighborhoods*, [`j2bu-swwd`](https://data.sfgov.org/resource/j2bu-swwd.json): 41 neighbourhoods (MultiPolygon). | `nhood`, `the_geom` | PDDL 1.0. "City and County of San Francisco, DataSF" |
| Elevation | USGS 3DEP bare-earth DEM, [ImageServer `exportImage`](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer), float32 GeoTIFFs in WGS84 (20 blocks citywide) | metres NAVD88 | The service's `accessInformation` credit is "USGS National Map 3D Elevation Program (3DEP)". Its `licenseInfo` is empty. USGS-produced data are public domain under U.S. federal policy (17 U.S.C. §105). |
| Height corrections | `pipeline/overrides.json`: public-record heights for buildings newer than the LiDAR | `heightM`, with a `source` note per entry | Facts, cited per entry |

The gameplay datasets (hydrants, fountains, transit, signals, crosswalks, Street Cleaning,
parking, cable car track) are in [Gameplay data](#gameplay-data-the-wave-2-spike), with the
procedural fallback for each one that has no usable open dataset.

## Tiles: the whole city

`pipeline/areas.json` defines worlds. World `sf` has a `citywide` box (north 37.834, west
−122.516, south 37.704, east −122.356). It contains every footprint, active street and
neighbourhood in DataSF (their extents, queried 2026-10-20) and leaves out the Farallon
Islands, which are in the City and County but 43 km offshore. The box covers 29 × 30 = 870
candidate tiles of 500 m. Tile ids, the grid and the origin come from `src/geo/project.ts`:
`tileId(ix, iz)`, `TILE_SIZE_M = 500`, and the origin at the Ferry Building clock tower.

**A candidate tile is built when** a building's anchor point lies in it, a road centreline
passes through it, or it has land (a heightfield sample above water) inside San Francisco,
meaning inside the union of the Analysis Neighborhoods. The rest are not built:

| Candidates | Built | With buildings | With roads | With SF land | Open water (no file) | Land with no file (`outside`) |
|---|---|---|---|---|---|---|
| 870 | **583** | 522 | 533 | 571 | 235 | 52 |

Open-water tiles are listed in `manifest.json` `water.tiles`, beside `water.y` (0, sea
level) and `water.bbox` (the candidate rectangle, [−11000, −4500, 3500, 10500]). The 52
land tiles with no file are listed in `manifest.json` `outside.tiles`, each with its area:

| `area` | Tiles | What it is |
|---|---|---|
| `marin` | 29 | The Marin headlands across the Golden Gate |
| `san-mateo-county` | 18 | Daly City and Brisbane, south of the last built row |
| `alcatraz` | 4 (`t-6_-8`, `t-5_-8`, `t-6_-7`, `t-5_-7`) | Alcatraz Island. It **is** San Francisco, but no footprint, street or neighbourhood polygon covers it, so it is not built. The design has it "visible from the start" and reached by ferry later, never driven: the far-LOD terrain draws it, a landmark model can sit on it. |
| `pacific-shore` | 1 (`t-22_7`) | A strip of Ocean Beach sand west of the last built tile, outside the neighbourhood polygons |

**The renderer's water contract:** draw the sea plane at `water.y` over `water.bbox` and on
to the horizon; built tiles draw over it, and so does the far-LOD terrain over every
`outside` tile, **even inside the streaming radius** (never sea there: Alcatraz and the
Daly City hills are land). The sim has no ground on `outside` tiles; `boundary.json` walls
the world off from them (see [World edge and shore](#world-edge-and-shore-boundaryjson)). Every built tile is complete: it gets every building
whose anchor is in it, the full heightfield and every road crossing it.

The wave-1 `areas` (downtown M0; North Beach, Embarcadero north, the Marina and Dogpatch M1)
stay in `areas.json` as milestone labels for the report and the tests. Of their 77 tiles,
64 are built and 13 are open water (`report.json` `areas`). Dogpatch is no longer an
island: SoMa and Mission Bay join it to downtown.

## Terrain

* **DEM request.** Citywide, one `exportImage` per **block of 8 × 8 tiles** (4 km square,
  aligned to multiples of 8 tiles) covers the block plus 150 m, at 0.000045° per pixel
  (about 4.0 m east–west and 5.0 m north–south): 20 blocks for the city, about 1,100 × 900
  pixels each (the service allows 8,000 × 8,000). Area worlds (the test fixture) request one
  per area, the same way. The ImageServer
  forces square pixels *in degrees*: if the requested `size` does not match the box's
  aspect, it silently stretches the box (we asked for north 37.805 and got 37.8082). The
  request therefore snaps the box to whole pixels, and the reader always trusts the TIFF's
  own `ModelTiepoint` and `ModelPixelScale`. Because every request snaps to the same
  global pixel grid, overlapping blocks sample the service at the same pixel centres.
* **Reader.** `pipeline/lib/geotiff.ts` reads single-band float32 uncompressed TIFFs
  (strips or tiles, either byte order, PixelIsArea or PixelIsPoint). It rejects anything
  else loudly. No dependency.
* **Heightfield.** Every tile has a 51 × 51 lattice at 10 m (`x0 = ix·500`,
  `z0 = iz·500`, `cellSizeM = 10`). The edge rows and columns lie *on* the tile border.
  Each sample is a pure function of its world position: bilinear between DEM pixel centres,
  from the first raster that covers it (areas in `areas.json` order, or DEM blocks in
  (row, column) order), rounded to cm. Two
  neighbours therefore compute their shared border identically, and a test asserts it.
* **Water.** Over the bay, 3DEP returns a hydro-flattened surface at almost exactly 0 m
  (tiny positive floats), bathymetry further out (down to −23 m) and about −1 m in some
  slips. Waterfront land (fill, pier decks) is 1–4 m. A sample is **water when below
  0.1 m**. Its height becomes 0 (sea level) and `ground.water[i] = 1`. `water` is an extra
  array beside `heights` with the same indexing. The collider schema allows it and the sim
  ignores it. 14 % of the built tiles' lattice samples are water (207,045 of 1,516,383).
* Range: 0 to 283.8 m (Mount Davidson; the Twin Peaks summits are 278.2 m and 279.8 m).
  The origin sits at 2.71 m and the ground at Coit Tower is 91.2 m.

## Buildings

**Footprints.** Outer rings only; courtyards and light wells are filled. They are projected to local metres and rounded to cm, simplified with
Douglas–Peucker at 0.45 m, and nearly collinear vertices are dropped (9.3 vertices per
footprint on average citywide; 11.7 downtown). Rings under 4 m² are dropped. Rings are ordered
**counter-clockwise on a north-up map**, i.e. a negative shoelace sum in (x, z).

**Ids.** The id is the DataSF `sf16_bldgid` (e.g. `201006.0000548`), so it can be searched
in DataSF and used in `landmarks.json` `replacesBuildingIds`. Extra parts of a multipart
footprint are `<id>-1`, `<id>-2` and so on (largest part first). A two-tier building's
tower is `<id>-tower` (see below). `report.json` `probes` lists the ids under named
landmarks: the records containing the probe point (a podium brings its tower), else the
nearest within 30 m; a probe with `radiusM` lists every record whose footprint comes within
that distance (a landmark the data splits into several records):

| Probe | Building records |
|---|---|
| Ferry Building clock tower (origin) | `201006.0000058`, `201006.0000058-tower` |
| 415 Mission St tower | `201006.0000548` |
| 600 Montgomery St pyramid | `201006.0000687`, `201006.0000687-tower` |
| Coit Tower | `201006.0006230`, `201006.0006230-tower` |
| Saints Peter and Paul Church | `201006.0003946` (nearest, 9 m) |
| Pier at The Embarcadero and Beach St (`beach-st-pier`) | `201006.0000037` |
| Palace of Fine Arts rotunda | `201006.0000986`, `201006.0000986-tower` |
| 315 Pennsylvania Ave (Dogpatch) | `201006.0010443`, `201006.0010443-tower` |
| Sutro Tower (every record within 60 m: `radiusM` in `areas.json`) | `201006.0001431`, `201006.0009087`, `201006.0062170`, `201006.0077893`, `201006.0167582`, `201006.0168289` (all on the tower's parcel 2724003: the lattice's upper structure as the LiDAR saw it, a 683 m² block at a 210 m median and 274 m² and 16 m² pieces at 191 m and 183 m, now 3 m plinths by override; a building under a leg and the small equipment buildings at its base; no `-tower` records) |
| City Hall dome | `201006.0000041`, `201006.0000041-tower` |
| Grace Cathedral | `201006.0000550`, `201006.0000550-tower` |
| Mission Dolores | `201006.0001563` (its bell tower is removed by the spike check: see Known limitations) |
| Conservatory of Flowers | `201006.0001537`, `201006.0001537-tower` |

`content/landmarks.json` must list a landmark's records exactly as its probe does
(`sf-world.test.ts` checks every replaced id exists and matches the probe of the same id). After the wave-1/wave-2 reconciliation the one entry
with `replacesBuildingIds`, the Ferry Building, still matches its probe; the probes whose
records changed (Sutro Tower, Mission Dolores and the Beach St pier lost their `-tower`
records) have no landmark entry yet.

**Heights.** The footprint dataset's height statistics come from a **June 2010 LiDAR
survey** (the `201006` prefix and the `p2010_*` fields), even though the footprints
themselves are newer. For each footprint, in order:

1. **Override** (`pipeline/overrides.json`), keyed by `sf16_bldgid` and checked against
   the parcel. There are four. 415 Mission St (completed 2018), whose LiDAR median is
   0.24 m (the 2010 site was the old Transbay ramps), is set to its public-record 326 m
   roof. Three Sutro Tower records are set to 3 m plinths: the footprint dataset outlines
   the open lattice's upper structure as seen from above and the LiDAR fills the outline
   (683 m² at a 210 m median, max 286 m), so they were solid blocks 225–231 m tall over
   the west side. The plinths stand in until a landmark model replaces the probe's records.
2. **Assessor storeys** when the parcel was built in 2010 or later, has storeys, and the
   LiDAR median is below 2 m per storey (a construction site or empty lot in 2010). Also
   used when the LiDAR median is under 2 m but the assessor records storeys. The height is
   storeys × storey height (office 4.0, retail 4.5, industrial 5.0, hotel 3.4, residential
   3.2, otherwise 3.6 m) + 1.5 m. Used for 2,409 buildings. A storey count is ignored as a
   data-entry error (66 joined parcels citywide, e.g. 591 or 999 storeys on a house) when
   it is above 64 (the tallest SF building has 61; the 2025 roll has no count between 63
   and 75, so wave 1's cut at 70 gives the same world) or when the height it implies
   exceeds 8 × √(footprint area) (slender towers reach about 8).
3. **LiDAR** for the other 173,182:
   * If `d = hgt_max − hgt_median ≤ max(4 m, 0.3 × median)`, one prism at `hgt_max` (roof
     including parapets).
   * Otherwise the max is either a tower or an **outlier**: edge bleed from a neighbouring
     tower, a single LiDAR return, a tree. The statistics decide which
     (`towerFraction` and `plausibleTower` in `pipeline/lib/buildings.ts`). They are read as
     three levels: a fraction `a` of the footprint at the max, a fraction `b` near ground
     level (courtyards, light wells, low wings), and the rest at the median roof. Matching
     the mean and the standard deviation gives
     `a = (std² + m1² + m1·median) / (d·(d + median))` with `m1 = mean − median`. When that
     leaves `b < 0` (nothing low), the two-level `a = m1 / d` is used. `a` is clamped to
     [0, 0.5]. The low level matters: the Russ Building (31 storeys on lower wings) has its
     mean below its median, and is still a tower.
   * The tower is **plausible** when its area `a × footprint` is at least 25 m² and it rises
     above the podium at most 10 times its width (`d ≤ 10·√area`; the 600 Montgomery St
     pyramid, the most slender real case, is at 9.7).
   * **Outlier max** otherwise, in 10,928 buildings: one prism at the median plus a rooftop
     allowance (parapets, stair and lift overruns) of `max(3 m, 10 % of the median)`, never
     above the max (`outlierRoof`). Examples the rule removes: a 144 m, 8 m² needle on a
     3-storey 1908 house on Nob Hill (`201006.0024724`, a ≈ 0.02); a 169 m needle on a 40 m
     building beside a real 178 m tower (`201006.0001118`, mean below median, a ≈ 0.006);
     the podium wing of a 33-storey parcel that caught its tower's wall (`201006.0001964`,
     66 m² at +111 m).
   * Two checks then remove a plausible-looking tower the assessor contradicts. Both give
     the building the same outlier roof:
     * **Tree canopy over houses:** a residential building of at most 4 assessor storeys
       whose LiDAR max is above storeys × 4.5 m + 8 m (123 buildings, none with a max above
       51.2 m): the max is the trees over the roof. **Condominiums are exempt.** A condo's
       storeys are the most any unit parcel lists (usually 1 or 2, whatever the building's
       height), so they cannot contradict a tower: One Rincon Hill's 689 units list 2
       storeys under its 182 m tower.
     * **LiDAR spikes:** a tower under 60 m² over a podium under 15 m, rising more than
       15 m above it, when the assessor storeys contradict it (taller than storeys × 4.5 m
       + 20 m) or, with no storey count, when it is more than 4 times the podium
       (74 buildings). These are the scan catching a neighbouring tower, a crane or a tree:
       26–59 m² slivers 30–60 m above 7–15 m shops and offices downtown (`201006.0007252`,
       a 1-storey shop on a 70 m sliver; `201006.0000531`, 4 storeys on a 70 m one).
   * **Two-tier massing** for the rest, in **2,325 buildings**: a podium at `hgt_median`
     over the whole footprint, plus a tower at `hgt_max` covering `a` of it. The tower
     footprint is the building's footprint clipped to a square of that area, centred on the
     centroid and aligned with the longest wall (lengthened along the wall where the
     building is narrower than the square). A long hall therefore gets a compact tower, not
     a slab. This keeps the Ferry Building a low hall with a clock tower (a = 0.018,
     181 m²) rather than a 75 m wall. 52 thin towers remain (under 60 m² over a podium
     under 15 m, rising 15+ m), all under 54 m (`report.json` `buildings.thinTowers`,
     `thinTowerMaxM`; a test caps them at 200 and 60 m): steeples and rooftop structures.

   **Why this rule: the two thin-tower fixes, reconciled.** Wave 1's last review round
   (`eb3e8e3`) and wave 2's (`176a711`) fixed the same defect (thin LiDAR "towers") in
   parallel. Wave 2 kept the old tower model (`a = (mean − median)/d` clamped up to 0.04,
   every max trusted) and removed two kinds of bad tower after the fact: canopy over
   houses and thin spikes. That left 11,348 towers citywide. Wave 1 replaced the model:
   the three-level moment fit tests every max, everywhere, against a size and slenderness
   that real towers meet, and calls the rest outliers. It is the more rigorous rule, so it
   decides first. Citywide it accepts 2,522 towers. 123 of them are trees over low
   non-condominium houses, and without a spike check 74 more are thin slivers that a
   podium's storeys contradict: 126 thin towers in all, the tallest 70.4 m, which breaks
   wave 2's golden (thin towers under 60 m). So wave 2's canopy and spike checks stay, as
   guards that can only remove a tower the moment model accepted, never add one: 123 + 74
   removed, 2,325 towers left, 52 thin ones under 54 m. Every rejected max, by any of the
   three, gets one roof (`outlierRoof`), so wave 1's fixture (a stray max on a 3-storey
   house: 12 m + 3 m) and the canopy case agree. Both sides' tests and goldens pass
   unchanged except counts that described the old model (towers > 10,000, spikes > 100,
   Sutro's `-tower` records), which now describe this one.

   **The guards read wave 1's condo join correctly.** The first merge fed the canopy guard
   the condo-adjusted storeys, the most any unit lists. Those describe a unit, not the
   building, so 64 of its 187 canopy drops were condominiums, real towers among them: One
   Rincon Hill (182 m, an 18.8 m prism), 757 Market St (130 m, 31.7 m), the Watermark at
   501 Beale St (72.7 m), and towers of 85, 78, 76, 57 and 55 m. Wave 2 had the same
   defect with the joined unit's own storeys (none of the three had a tower in wave 2's
   tiles). Condominiums now skip the canopy guard (`!condo` in `lowHouse`). Of the 631
   towers wave 1's last fix built in its 77 tiles, 604 stand, and those tiles hold no tower
   wave 1 lacked. The other 27 are listed with their guard in
   `tests/pipeline/wave1-towers.json`: 13 canopy drops (non-condo houses of 1–4 storeys,
   maxima 14–51 m) and 14 spike drops (26–50 m² slivers 28–70 m tall over 6–14 m
   commercial podiums). The spike check keeps a condo's storeys on purpose: it only sees thin towers over
   podiums under 15 m, which a condo's 1–4 unit storeys do describe. Treating them as
   unknown (the 4× podium rule) would bring back three thin columns over 11–14 m condo
   podiums that look like neighbour bleed: 49.6 m on a 2004 retail condo in South Beach
   (`201006.0000830`), 37.4 m on a 1979 residential condo in the southwest
   (`201006.0001723`) and 27.6 m near Jackson Square (`201006.0121401`).
   * A two-tier building is **two collider records**: `<id>` (the podium, `meta.tower`
     names the tower) and `<id>-tower` (`meta.towerOf`, `meta.podiumTopY`). Both have the
     same ground-level `baseY`, so a renderer that extrudes colliders draws the right
     massing. In the GLB, the tower starts on the podium roof.
4. Footprints with a LiDAR median under 2 m and no assessor storeys are dropped (774). They
   are not standing buildings in the source.

**Sitting on the ground.** Roofs are absolute: `topY = groundRef + height`. `groundRef` is
the LiDAR's own ground (`gnd_mediancm`), or the DEM when the two disagree by more than 3 m
(274 buildings: 2010 excavations, piers).

* `baseY` is the ground at the footprint's centroid as the sim computes it (bilinear over
  the heightfield), floored to cm. It is the building's street level.
* `meta.footY` is the lowest ground anywhere under the footprint, minus 5 cm. That is the
  minimum of the sim's bilinear surface *and* the rendered mesh's planar triangles, sampled
  every 2 m along each wall, at every lattice point inside, and at the centroid. On slopes
  the GLB's walls start at `footY`, so the downhill side never shows a gap. It can be up to
  14 m below `baseY` on Telegraph Hill. **A renderer that extrudes colliders should extrude
  from `meta.footY`**, not `baseY`.

**Assessor join (meta).** 96.4 % of the 175,595 kept footprints joined a 2025-roll parcel:
167,760 by exact block/lot (`mblr` = `"SF" + parcel_number`) and 1,443 by a parcel point
inside the footprint (the one with the most plausible storeys when several are inside). Of
the kept footprints, 165,962 have a year built and 161,553 a storey count. With the 2,325
towers that is **177,920 collider records**. Three corrections:

* **Noise.** Storey counts above 64 are data-entry noise (the roll has 999, 752, 591…; the
  tallest building in the city has 61 floors) and are ignored, as are counts whose height
  the footprint could not carry (above).
* **Condominiums.** A condominium building is many unit parcels on one point. The joined
  parcel then describes one unit: typically "Single Family Residential", 1 or 2 storeys,
  on a 90 m tower. When the joined parcel shares its block and point (within about 1 m)
  with at least 3 parcels, the record gets `condo: true`, `units` = the number of parcels
  there, `stories` = the most storeys any of them records (some unit rows carry the
  building's count: 58 at 301 Mission St), and `use` = "Residential Condominium" when every
  unit is residential (`SRES`/`MRES`). 5,017 records citywide. Unit-derived storeys never
  feed a height (the assessor-storey heights above use the joined parcel's own count) and
  never make a condominium a "low house" for the canopy check.
* **Plausibility.** A LiDAR-height building keeps `stories` only when
  `stories × 2.4 − 10 ≤ height ≤ stories × 6 + 15` (height = the tower's when there is
  one). 383 counts fail and are left out: condo units, a parcel's tower storeys on its low
  wing, a parcel shared with a different building. The facade storey height then falls
  back to the use's default (office 4.0, residential 3.2, industrial 5.0, otherwise 3.6 m)
  instead of `height / stories`.

`meta` keys:

| Key | Meaning |
|---|---|
| `footY` | Lowest ground under the footprint, minus 5 cm |
| `heightM` | Height above the ground reference |
| `heightSource` | `lidar`, `assessor-stories` or `override` |
| `lidarM` | LiDAR `[median, max]` height |
| `parcel`, `year`, `use`, `stories`, `units` | From the assessor roll, when joined (corrected as above) |
| `condo` | The parcel is one unit of a condominium building |
| `tower` / `towerOf`, `podiumTopY` | Two-tier pairing |

## Roads (`roads.json`, `schemas/roads.schema.json`)

* **Kept layers:** `STREETS`, `FREEWAYS`, `PRIVATE`, `PARKS*`, `STREETS_PEDESTRI`,
  `STREETS_*` (Treasure Island, etc.). **Dropped:** `PAPER`, `PAPER_FWYS`, `PAPER_WATER`
  (not real streets), `PRIVATE_PARKING`, `PSEUDO`, `UPROW` (unpaved, mostly stairways).
  707 segments were dropped this way citywide.
* A segment is kept if any point along it lies in a world tile. Segments crossing the
  world's edge are kept whole, so their far ends lie outside the tiles.
* **Nodes** are the intersection CNNs (`n<f_node_cnn>`), placed at the mean of the segment
  endpoints that name them. Each edge's first and last points are snapped onto its nodes.
  A missing CNN gets a synthesised `p<x>_<z>` node (none in sf). `y` is the ground height
  at the node.
* **Edges** have id `c<cnn>`. `oneway`: `B` is two-way (a = from-node); `F` is one-way from
  → to; `T` is one-way to → from, so the edge is **reversed** (a = to-node, polyline
  reversed). Every one-way edge therefore flows a → b. Divided roads such as The
  Embarcadero are two one-way edges between the same nodes.
* **Names** are title-cased from `streetname`, with DataSF's zero padding of numbered
  streets dropped (`03RD ST` → `3rd St`).
* Extra fields (declared in `schemas/roads.schema.json` since the citywide merge): `cnn`,
  `classcode` (source tracing), and three flags, each present only when true:
  * `pedestrian: true` on `STREETS_PEDESTRI` (170 edges): not for vehicles.
  * `gradeSeparated: true` on every freeway (classcode 1, 110 edges): limited access, so it
    crosses other streets on a viaduct, in a cut or in a tunnel. The source has no deck
    heights, so its points and node `y` are the ground *under* the roadway. Surface
    traffic and GPS should not route onto it until the decks are modelled. Ramps are not
    flagged: some (Richardson Ave) are at grade.
  * `bridge: true` where an edge has a stretch of at least 10 m over open water (the
    candidate tiles' water flags, the DEM beyond them): 23 edges. The I-80 Bay Bridge west
    span to Yerba Buena Island and the stub east of it, in both directions; the Golden Gate
    Bridge approach off the toll plaza (Hwy 101 both ways); I-280 and two of its ramps over
    Islais Creek and the Mission Creek channel; the 3rd St, 4th St and Illinois St
    bridges; pier roads at Fisherman's Wharf and Piers 50 and 70. `y` there is sea level,
    not the deck.

**classcode → kind, lanes, width, speed.** `lanes` counts all directions on the edge.
`widthM` = lanes × lane width + extra (parking and shoulders), kerb to kerb.

| classcode (DataSF meaning) | kind | lanes two-way / one-way | lane m | extra m | limit |
|---|---|---|---|---|---|
| 1 Freeway | `freeway` | 6 / 3 | 3.6 | 3.0 | 50 mph |
| 6 Freeway ramp | `ramp` | 2 / 1 | 3.8 | 2.0 | 35 mph |
| 2 Major street/highway | `arterial` | 4 / 3 | 3.3 | 4.8 | 25 mph |
| 3 Arterial | `arterial` | 4 / 3 | 3.3 | 4.8 | 25 mph |
| 4 Collector | `collector` | 2 / 2 | 3.3 | 4.8 | 25 mph |
| 5 Residential (`st_type` `AL` → `alley`) | `residential` / `alley` | 2 / 1 · 1 / 1 | 3.2 · 4.0 | 4.6 · 0.5 | 25 · 15 mph |
| 0 Other (private, park roads; `AL` → `alley`) and `STREETS_PEDESTRI` | `other` | 2 / 1 | 3.0 | 0.5 | 15 mph |

sf result: 15,671 edges (10,851 residential, 2,367 collector, 1,731 arterial, 61 alley,
442 other, 110 freeway, 109 ramp), 9,441 nodes and 22 connected components. The largest
has 9,290 nodes (98.4 %). By road (one-ways respected, pedestrian ways excluded) the Ferry
Building reaches Pier 70 in 4.81 km, the Golden Gate Bridge toll plaza in 8.30 km, Ocean
Beach (Great Highway at Lincoln Way) in 11.31 km, Hunters Point in 9.00 km and Visitacion
Valley in 10.63 km. **Treasure Island is not reachable**: the source has the Bay Bridge's
I-80 segments, but they do not join the island's streets (the bridge deck and the island
are wave 8 in the roadmap).

## Storefronts (`storefronts.json`)

* NAICS kept: `722*` (food and drink), `44*`/`45*` retail (2017 and 2022 NAICS),
  `8121*` (personal care), `8123*` (laundry and dry cleaning). Excluded: `454*`
  (non-store retail: online, vending) and `7223*` (caterers, mobile food). Neither has a
  shopfront.
* Each anchor is assigned to the footprint containing its point, or the nearest within
  20 m (podium records only). It then gets a slot on a **street-facing wall**: a wall at
  least 3 m long, with a drivable non-freeway centerline within 30 m of it, 2.5 m of open
  ground in front, and the building right behind. Slots are 5 m apart. The anchor takes
  the nearest free slot and sits 0.3 m outside the wall, `heading` = compass bearing the
  shopfront faces.
* **No names, owners, addresses or registry ids** are ever requested or emitted. `id` is
  `sf-` + the first 12 hex digits of SHA-256(registry row id), stable across rebuilds.
* Fields: `id, x, z, y` (ground at the anchor), `heading`, `naics` (full code: storefront
  kits match on prefixes), `category` (coarse convenience label), and `buildingId`.
* sf result: 13,265 candidates → 10,641 anchors. 1,604 had a non-storefront code after the
  exclusions, 192 had no building within 20 m, and 828 had no free street-facing slot.

## GLB tiles (`tX_Z.glb`)

Written with `@gltf-transform/core` and `@gltf-transform/extensions`. All 583 tiles (and
the far-LOD cells) pass the Khronos glTF validator with 0 errors and 0 warnings, both as
shipped and after decoding the meshopt compression (the validator cannot look inside
`EXT_meshopt_compression` and says so in an info note). The other info notes are
"TEXCOORD_0 may be unused": the UVs are for shaders, not textures.

**Compression (wave 2).** Every tile is quantised and then meshopt-compressed; both
extensions are `extensionsRequired`:

* `KHR_mesh_quantization`: `POSITION` is int16 on a **1/64 m grid** about the tile centre,
  `NORMAL` is normalised int8. Each mesh node carries the dequantisation as its transform:
  translation `(tile centre x, 0, tile centre z)` and a uniform scale of 1/64 (doubled for a
  building mesh that reaches more than 512 m from the centre; ground and roads always use
  1/64). **`node.matrix × POSITION` is world-frame local metres** (the colliders' frame);
  the raw attribute is not. The grid is aligned to whole metres (tile centres are multiples
  of 250 m and the step is a power of two), so neighbouring tiles' border vertices
  dequantise to the same floats and the ground has no cracks (a test checks every sampled
  seam). Positions move by at most 0.8 cm.
* `EXT_meshopt_compression` (method "quantize", lossless on the quantised data) on every
  buffer view. Loaders need the meshopt decoder: in three.js,
  `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)` from
  `three/addons/libs/meshopt_decoder.module.js`. `src/render/gltf-loader.ts`
  (`createTileLoader()`) is that loader; the pipeline tests load every tile through it.
* `TEXCOORD_0` stays float32 (the renderer's shaders read it as metres), and `COLOR_0` and
  `_FACADE` were already normalised uint8.

Measured on the 77 wave-1 tiles (`pipeline/` 2026-10-20; gzip -9 is what a web server would
send):

| Encoding | 77 wave-1 tiles | gzip -9 | largest tile |
|---|---|---|---|
| float32 (wave 1) | 26.74 MB | 12.18 MB | 1.20 MB |
| meshopt only | 15.13 MB | 7.24 MB | |
| quantised only | 22.64 MB | 11.51 MB | |
| **quantised + meshopt (shipped)** | **11.93 MB** | **5.03 MB** | **0.56 MB** |

Quantisation alone saves only 15 % because the texture coordinates stay float and the
colours were already 8-bit; meshopt is what makes the difference, so it ships, with the
decoder registration as the one renderer change. The 64 wave-1 tiles that are still built
went from 26.72 MB to 11.83 MB. Citywide: 583 tiles, 115.3 MB, largest 0.56 MB
(`t-4_-1`, the Financial District).

| Node | Contents |
|---|---|
| `ground` | The heightfield as triangles split along the (i+1, k)–(i, k+1) diagonal. All-water cells are greedily merged into flat rectangles (an all-bay tile is one quad). `NORMAL` comes from central differences on the global lattice, so seams shade continuously. `COLOR_0`: water blue-grey, land warm grey. |
| `roads` | Surface road ribbons 0.15 m above the mesh ground, each side draped separately, densified to ≤ 8 m. `TEXCOORD_0` = (0 left kerb … 1 right kerb, metres along the edge, continuous across tiles). |
| `freeways` | Freeway and ramp ribbons, draped like roads. The source has no deck heights: they lie on the terrain, and stretches over the bay (the Bay Bridge) are not drawn. A separate node, so a renderer can hide it. |
| `buildings` | Every collider record in the tile, merged, with no normals (glTF loaders shade flat; three.js sets `flatShading`). `COLOR_0` is the facade colour, darker at the foot. `TEXCOORD_0` = (metres along the wall, metres above `baseY`); roof vertices use (x, z). `_FACADE` (three.js: `_facade`, normalized uint8 ×4) = (storey height / 8 m, glazing 0–1, (year − 1840)/190 or 0 if unknown, 1 on roofs). Node `extras.buildings` = `[[colliderId, firstIndex, indexCount], …]` in collider order, so a renderer can hide a building a landmark replaces. |

Materials are plain PBR (`metallic 0`, roughness 0.85–0.95) whose base colour multiplies
the vertex colour. Facade colours are chosen by use, year and height:

* pastel stucco for low-rise residential;
* sandstone or brick before 1945;
* concrete for 1945–1979;
* blue-grey glass for tall or modern buildings;
* brick or corrugated grey for industrial.

Each building gets a deterministic per-id variation. A tower shares its podium's colours.

## Manifest, spawn and report

* `manifest.json`: world `sf`, the origin from `src/geo/project.ts`, `tileSizeM` 500,
  the attribution strings, `roads: "roads.json"`, and per tile `id, ix, iz, bbox, collider,
  glb` plus `stats` (`buildings`, `roadEdges`, `waterFraction`, `maxTopY`). Wave 2 adds,
  additively (`schemas/tile-manifest.schema.json`):
  * `water`: `{ y, bbox, tiles }`: sea level, the candidate rectangle, and the open-water
    tile ids that have no files (see [Tiles](#tiles-the-whole-city));
  * `outside`: `{ description, tiles: [{ id, area }] }`: the land tiles with no file
    (Marin, San Mateo County, Alcatraz, an Ocean Beach strip), where the renderer draws
    far-LOD terrain, never sea;
  * `worldColliders`: `"world.colliders.bin"` (see [World collider pack](#world-collider-pack-worldcollidersbin));
  * `farCellSizeM` and `far`: the far-LOD cells, each `{ id, cx, cz, bbox, glb, stats }`;
  * `layers`: name → file for every data layer (`boundary`, `districts`, `sidewalks`,
    `hydrants`, `fountains`, `transit`, `signals`, `streetCleaning`, `parking`). Each file validates
    against `schemas/<file name without .json>.schema.json`.
* **Spawn:** on the street named in `areas.json` (The Embarcadero), at the point nearest
  37.7951, −122.3932, on a carriageway whose travel direction points toward
  37.7995, −122.3975. That gives x = 13.59, z = 66.97, heading 5.6451 rad (323°, NW): the
  northbound carriageway in front of the Ferry Building, on edge `c12553201`.
* `report.json`: build statistics (tile selection, the `outside` tiles by area, join
  rates, drops, height sources, spike towers dropped and thin towers kept, sidewalk graph,
  layer counts, boundary lengths, collider pack and far-LOD sizes), the ten tallest records,
  the spawn and the probes. Deterministic, like everything else.

## World collider pack (`world.colliders.bin`)

The sim must hold the whole world's collision data deterministically, on every client and
the server, whatever the renderer has streamed. The design's preferred option (a) ships:
one binary pack for the whole city, **12.69 MB** (budget 15 MB), against 82.9 MB for the
583 per-tile JSON colliders. Format FCWC version 1, specified in
[`schemas/world-colliders.md`](../schemas/world-colliders.md): a 64-byte header, a tile
table, every tile's 51 × 51 heightfield as int16 cm and its water mask as bits, then 20-byte
building records (id number, part, tower flag, vertex count, `baseY` int16 cm, height
uint16 cm, first vertex int32 cm) and a stream of int16 cm vertex deltas with an escape for
long edges. `pipeline/lib/world-colliders.ts` has the encoder and the reference reader
(`decodeWorldColliders`, pure TypeScript over a `DataView`, plus `PackGroundIndex`, an O(1)
tile-indexed ground lookup). The reader decodes the pack to exactly the JSON colliders'
values (everything is whole centimetres in both), and a test proves it for every tile.

The per-tile JSON colliders still ship (82.9 MB, inside the 100 MB budget for them): they
are today's contract for the sim's boot and the renderer, and they carry `meta` (footY,
year, use, storeys) the pack leaves out. **The sim should switch to the pack**; see
[What the sim and renderer must change](#what-the-sim-and-renderer-must-change).

## Far-LOD massing (`fX_Z.glb`)

`pipeline/lib/far.ts`. Every collider record (all 177,920), heavily simplified and merged
per large cell, so the skyline and the hills beyond the streaming radius are always drawn.
The grid starts at the candidate rectangle's north-west corner with **2,500 m cells**: the
city fits in 6 × 6, and 33 cells hold something. One glb per cell, one node `far`, one
primitive, so one draw call per cell (budget: 40 draw calls, 600k triangles).

* **Terrain:** the DEM on a 100 m lattice over the whole cell (Marin's headlands and Daly
  City included where the cell reaches them), land quads only, 0.5 m below the true ground
  so the sea plane and near tiles win where they overlap.
* **Tall records** (30 m or more above street level): each record's convex hull, cut to 6
  vertices, flat roof at its `topY`.
* **Everything else:** records closer than 2 m merge into a cluster (in SF, a row of houses
  or a block face); a cluster becomes its convex hull cut to 6 vertices (4 for a lone
  building), at the members' area-weighted mean height above the terrain, the roof following
  the terrain.
* Walls start 3 m below the lowest ground under a hull. No normals (three.js shades flat);
  vertex colours from the largest member's facade palette. Quantised and meshopt-compressed
  like the tiles.

Result: 33 cells, **467,333 triangles, 6.68 MB**. The layer is meant to be drawn only
beyond the streamed radius (a fragment discard inside it, or hiding cells the near tiles
cover); otherwise its hulls, which are larger than the buildings, poke through the
detailed tiles.

## World edge and shore (`boundary.json`)

`pipeline/lib/boundary.ts`, `schemas/boundary.schema.json`. What the sim needs at the edge
of the world, on the global 10 m ground lattice (so it is a pure function of the tiles):

* **`edges`**: the outline of the built tiles, built tiles on the left of travel (+x east,
  +z south), split into runs by what lies under it. **`land`** runs (11.9 km) are where the
  world stops on dry ground: along the last built row at the southern city limit (Daly City,
  Brisbane), where a built tile meets Alcatraz, Marin or the Ocean Beach strip. Beyond them
  there is no ground (the sim's ground is 0 outside the tiles, a 100 m drop at the city
  limit), so **the sim must wall them off**. **`water`** runs (61.1 km) are where the
  outline crosses open water: the sea wall and the towing rule cover them.
* **`shore`**: the land/water line inside the built tiles (marching squares over the
  heightfields' water flags, saddles keeping land connected, Douglas–Peucker at 2.5 m),
  land on the left of travel: 69 lines, 79.4 km. Piers are land in the elevation model, so
  it runs round them. It is the line for the design's **sea-wall collider** and the
  **Bay-edge refill zone** (refill within a few metres of it, on the land side). Open lines
  end at the edge of the built tiles.
* `seaLevelY`: 0.

52 KB. Not emitted yet: deck profiles for the bridges and the Bay Bridge (wave 3 and 8).

## Districts (`districts.json`)

`pipeline/lib/districts.ts`, `schemas/districts.schema.json`. The 41 Analysis
Neighborhoods as MultiPolygons in local metres: outer rings counter-clockwise on a north-up
map (negative shoelace in x, z, like footprints), holes clockwise, rings not closed. Rings
are simplified with Douglas–Peucker at 2 m; a ring the simplification would make
self-intersecting is simplified at half the tolerance, down to 0.1 m, or kept as is. Each
district has `id` (a slug of the DataSF name, e.g. `financial-district-south-beach`),
`name`, `polygons`, `bbox`, `areaM2` and `tiles` (the built tiles it overlaps). Together
they cover 121 km². Geometry only: `content/districts.json` marks districts active.

## Sidewalk graph (`sidewalks.json`)

`pipeline/lib/sidewalks.ts`, `schemas/sidewalks.schema.json`. One graph for the whole world
(33,081 nodes, 58,007 edges, 10.4 MB), so it is connected across
tile seams by construction and the sim can hold all of it. Procedural, from `roads.json`
(DataSF's *Sidewalk Widths* `4g86-grxu` has widths, not walkable geometry):

* every road edge except freeways and ramps gets a sidewalk on each side (`<edge>.L` and
  `<edge>.R`, left and right of the edge's a → b direction), offset from its centreline by
  **half the road width plus 2 m**;
* at each road node the incident edges are sorted clockwise; between each neighbouring pair
  is a **corner node** `<node>.<k>` where the two sidewalks meet: the intersection of their
  offset lines, or the midpoint of the two offset points when the lines are near-parallel,
  meet behind the node or reach more than 3 offsets away; on the inside of a bend the
  offset is mitred, so it stays a full offset from the centreline;
* **crossings** `<node>.x<k>` join the two corners either side of an edge at every node
  with 3 or more walkable edges, at signals and crosswalks, and across a dead end.
  `signal: true` where a working traffic signal controls the node (5,835 crossings),
  `marked: true` where DataSF lists a crosswalk at the node or there is a signal (29,376: the
  crosswalk inventory covers 7,541 of the 7,661 intersections).

**Off the carriageway** (`pipeline/lib/road-surface.ts`): a road's surface is its
centreline ± half its width, the ribbon the GLB draws; pedestrian-only ways do not count.
No corner, and no stretch of sidewalk, comes within **0.5 m** of any road's kerb line:

* a **corner** on or by another road is dropped (3,121: mostly the median side of divided
  roads, whose carriageways are separate centrelines, and the wedge where two
  carriageways meet at one node);
* a **sidewalk** is checked every metre (and at every vertex) and cut where it is not
  clear: 3,269 are cut into pieces `<edge>.<side>.<k>` and 1,581 lie on another road
  their whole length (one carriageway's inner sidewalk on the other carriageway) and are
  dropped. About 293 km of 3,277 km (9 %) is removed. A cut piece ends at a **clip end**
  node `<edge>.<side>@<k>` (`road` is the nearer end node of the road edge, `edge` the road
  edge). Between kept samples at most 1 m apart the line can come at most 0.5 m closer to a
  road, so what is kept never enters a road's surface (tested on every metre of the graph);
* where another road **crosses** the sidewalk's line (a freeway at grade, a slip lane, an
  overlapping centreline) and the gap is at most min(45 m, 2.4 × that road's width + 4 m),
  a straight crossing `<edge>.<side>.x<k>` bridges it (613; `road` is the road crossed).
  A sidewalk that dips into a road running alongside and comes back stays cut, so no
  crossing runs along a road;
* a **corner crossing** that ends at a dropped corner is carried straight on, within 20°
  and 45 m, to the first node beyond: across both carriageways of a divided road to the
  far side's corner (4,177; duplicates from the two sides merge, and `signal`/`marked`
  then hold if either junction has them). Where the carriageways meet at one node, it
  continues round the node to the next corner. 1,197 crossings with no end off the road
  are dropped;
* pieces left in a median with no corner to reach them from are dropped (442 edges).

Nodes carry `y` (the sim's ground) and `road` (their road node). Edges carry `lengthM`,
`road` (the road edge they follow or cross) and, when not straight, interior `points`.
Result: 29,873 sidewalks, 28,134 crossings (4,904 signalised, 26,197 marked), 46
components. The largest holds 31,770 nodes: **99.4 % of the mainland's 31,955** (Treasure
Island and Yerba Buena Island are a walk network of their own, since the Bay Bridge is a
freeway), and spans the city.

## Gameplay data (the wave-2 spike)

Each dataset the roadmap asks for, its DataSF id and licence (read from the dataset's
metadata on 2026-10-20), or the procedural fallback when there is none. Everything emitted
is under `public/tiles/sf/`, local metres, one record per line, with a schema in `schemas/`.

| Data | Source and licence | Shipped as | Fallback |
|---|---|---|---|
| Fire hydrants (water refills) | **No open dataset.** DataSF has no hydrant layer (searched "hydrant", "AWSS", "auxiliary water", "SFPUC" on 2026-10-20). | `hydrants.json`: 4,223 procedural points | **Used:** sidewalk corners at intersections (3+ edges), taken in id order when no hydrant stands within 120 m, then points along sidewalks longer than 120 m. Never on water, inside a building, or within 1 m of any road's kerb line (all tested). |
| Public drinking fountains (water refills) | DataSF *San Francisco Public Bathrooms and Water Fountains*, [`wfq4-upmv`](https://data.sfgov.org/resource/wfq4-upmv.json) (`resource_type = drinking_water`), PDDL 1.0. Names are not requested. | `fountains.json`: 285 points inside built tiles, `bottleFiller`, `dogBowl` | Hydrants and the Bay edge |
| Bay-edge refills, sea wall | USGS 3DEP (public domain), via the tiles' water flags | `boundary.json` `shore`: the land/water line (see [World edge and shore](#world-edge-and-shore-boundaryjson)) | — |
| Transit routes (buses with AI-ad wraps, rail, streetcar) | DataSF *Muni Simple Routes*, [`9exe-acju`](https://data.sfgov.org/resource/9exe-acju.json), SFMTA, PDDL 1.0 | `muni.json` `routes`: 135 route patterns, `mode` bus / rail / streetcar / cable, `direction`, `night` (owl), paths simplified to 1 m | A hand-picked road-graph loop (Sim-Agents) |
| Cable car track | The `PH`, `PM` and `CA` patterns of `9exe-acju` (Powell–Hyde, Powell–Mason, California St), PDDL 1.0 | `muni.json` routes with `mode: "cable"` | — |
| Transit stops | DataSF *Muni Stops*, [`i28k-bkz6`](https://data.sfgov.org/resource/i28k-bkz6.json), SFMTA, PDDL 1.0 | `muni.json` `stops`: 3,260, with street names and the route patterns passing within 25 m | Stops every 400 m along a route |
| Traffic signals | DataSF *Traffic Signals*, [`ybh5-27n2`](https://data.sfgov.org/resource/ybh5-27n2.json), SFMTA, PDDL 1.0. `cnn` is the road-node CNN. | `signals.json`: 1,301 working signals and beacons at road nodes (pending, future and speed-sign rows left out), `ped` heads; sidewalk crossings `signal: true` | Signals at every arterial node, phases from the sim |
| Crosswalks | DataSF *Continental Crosswalks*, [`g9zy-srvv`](https://data.sfgov.org/resource/g9zy-srvv.json), SFMTA, PDDL 1.0 | sidewalk crossings `marked: true` | Crosswalks at every arterial node |
| Signal phases | No dataset | — | Procedural in the sim |
| Turn restrictions | No dataset found ("turn restriction" returns nothing) | — | No turn bans: the GPS respects one-ways only |
| Street Cleaning | DataSF *Street Sweeping Schedule*, [`yhqp-riqs`](https://data.sfgov.org/resource/yhqp-riqs.json), San Francisco Public Works, PDDL 1.0 | `street-cleaning.json`: 37,476 rules by road edge and side (re-expressed for reversed one-ways), ISO weekday (0 = holidays only), hours, weeks of the month. Sign text reads "Street Cleaning"; data ids use `street_cleaning`. | — |
| Parking regulations | DataSF *Parking regulations (except non-metered color curb)*, [`hi6h-neyh`](https://data.sfgov.org/resource/hi6h-neyh.json), SFMTA, PDDL 1.0 | `parking.json`: 7,773 rules matched to the nearest street edge (by the regulation line's midpoint, within 25 m) and side: kind, days, minutes, hour limit, permit areas | — |
| Sidewalks | DataSF *Sidewalk Widths (2014)*, [`4g86-grxu`](https://data.sfgov.org/resource/4g86-grxu.json), PDDL 1.0: widths only | `sidewalks.json` (procedural, above) | **Used:** offset from road edges |
| Stairs (walk-only edges) | The streets dataset's `UPROW` layer (mostly stairways), PDDL 1.0 | Not yet: `UPROW` is dropped from the road graph | Wave 3 (the Lyon St steps are wave 4) |
| Car-wash anchors | *Registered Business Locations* `g8m3-pdis` (NAICS 811192), PDDL 1.0 | Not yet | Procedural kiosks |
| Repair-kiosk anchors | No dataset | Not yet | Procedural, near garages |
| Curb ramps, street trees | DataSF `ch9w-7kih` and `tkzw-k3nq`, PDDL 1.0 | Not used yet (accessibility routing, props) | — |

## What the sim and renderer must change

* **Sim boot (Sim-World, `src/sim/`):** load `manifest.worldColliders` (12.7 MB) instead of
  every `*.collider.json` (583 files, 82.9 MB), decode it with the reference reader
  (`pipeline/lib/world-colliders.ts`, copy it into `src/sim/`), and replace the linear scan
  in `groundHeight()` (it loops over all 583 tiles per call) with a tile-indexed lookup
  (`PackGroundIndex`). Ground where no tile exists is 0 (open water).
* **Renderer boot (Render-World, `src/main.ts`):** stop fetching every collider JSON at boot.
  `main.ts` still fetches all 583 (82.9 MB) before the first frame. Measured after the
  citywide merge, on localhost under SwiftShader: `ready` in 2.4–2.6 s, tiles around the
  spawn settled in 6.6–12.2 s, 239–254 MB of JS heap; on a real connection it is the whole
  download before the first frame. Tile bounds can come from the manifest's `bbox`, and the
  colliders the streamer needs (fallback building, `meta`) can be fetched per tile when it
  loads; the sim can boot from `world.colliders.bin` (above).
* **Renderer tile loader: done in the citywide merge.** `src/render/tile-streamer.ts` loads
  every glb with `createTileLoader()` from `src/render/gltf-loader.ts` (GLTFLoader plus the
  meshopt decoder; quantised positions are dequantised by node transforms, which the
  streamer respects). Without it every compressed tile failed and was rebuilt from collider
  data. A tile with no glb (or a failed one) and no collider ends `failed`, never `ready`.
  `tests/render/tile-streamer.test.ts` streams committed sf tiles through the streamer's own
  loader, and `tests/e2e/sf-world.spec.ts` checks that no tile falls back in the browser.
* **Renderer far-LOD:** draw `manifest.far` cells beyond the streamed radius (one draw call
  each), hidden inside it; raise the camera's far plane (6,000 m today) to about 15 km for
  the high viewpoints.
* **Renderer water:** draw the sea at `manifest.water.y` over `water.bbox` and beyond; the
  235 open-water tiles have no files. Over the 52 `manifest.outside` tiles draw the far-LOD
  terrain even inside the streaming radius, never sea (Alcatraz and the Daly City hills).
* **Sim world edge (Sim-World):** wall off the `land` runs of `boundary.json` `edges` (the
  car otherwise drops about 100 m at the southern city limit, where the ground beyond the
  last tile is 0), and use `shore` for the sea-wall collider and the Bay-edge refill zone.
* **Sim agents (Sim-Agents):** walkers can use `sidewalks.json` as is: no node or sidewalk
  stretch lies on a road. Crossings (`kind: "crossing"`) are the only edges on a road;
  extended crossings over a divided road join two junctions' corners.

## Sizes

| Files | Bytes |
|---|---|
| 583 × `t*.glb` (quantised + meshopt) | 112.86 MB (largest 0.53 MB) |
| 583 × `t*.collider.json` | 82.86 MB (largest 0.40 MB) |
| `world.colliders.bin` | 12.69 MB |
| `sidewalks.json` | 10.36 MB |
| 33 × `f*.glb` (far-LOD) | 6.68 MB |
| `roads.json` | 4.54 MB |
| `street-cleaning.json` | 3.73 MB |
| `storefronts.json` | 1.55 MB |
| `parking.json` | 1.25 MB |
| `muni.json` | 0.66 MB |
| `hydrants.json`, `districts.json`, `signals.json`, `fountains.json`, `boundary.json` | 0.73 MB |
| `manifest.json` + `report.json` | 0.23 MB |
| **Total (the whole city, 1,213 files)** | **238.12 MB** (238,121,951 bytes; budget 300 MB) |

Budgets live in `tests/pipeline/budgets.json` and `tests/pipeline/budgets.test.ts` enforces
them: each tile glb and each collider JSON ≤ 1.5 MB, all tile glbs ≤ 150 MB, all collider
JSON ≤ 100 MB, the boot collider pack ≤ 15 MB, far-LOD ≤ 40 cells, 600k triangles and 15 MB,
each data layer ≤ 15 MB, the world ≤ 300 MB. (Wave 1's 40 MB budget covered the 77-tile
M0 + M1 world, 34.62 MB; it is superseded.)

## Determinism

Inputs are sorted by source id, coordinates are rounded to cm, JSON is written with a fixed
key order (one building, node, edge or record per line, so data changes diff as line
changes), meshopt encoding is deterministic, and there are no timestamps. `--check`
rebuilds from cache and compares every byte (all 1,213 files byte-identical on
2026-10-20).

**Rebuilds belong in one commit.** The world is about 238 MB of committed files and a
rebuild rewrites most of them, so every commit that rebuilds the world adds a full copy to
the history. Squash a branch's data rebuilds into one commit (or squash-merge it) so each
version of the world lands once. `tests/pipeline/build-fixture.test.ts` builds a synthetic world twice, in
memory, and compares SHA-256 of every file.

## Known limitations

* **The LiDAR is from 2010.** Buildings finished since then get assessor-storey heights,
  which are approximate (2,409 buildings), or an override (415 Mission St). Buildings that replaced a
  different 2010 building on the same footprint keep the old height.
* **Two-tier massing is a model.** The tower is centred on the podium's centroid; the real
  tower may sit at a corner. The tower test reads summary statistics, not the point cloud,
  so a real but very slender tower (a church spire under 25 m²) becomes part of its roof,
  and a bleed wide enough to pass (≥ 25 m² and ≤ 10:1) can still make a tower unless the
  assessor contradicts it. The spike check has one known false positive among the probes:
  **Mission Dolores Basilica** (`201006.0001563`, a 14 m nave with one assessor storey and
  a 39 m bell tower) loses its tower. Landmarks should be replaced by hand-made models.
* **Assessor storeys are corrected, not verified.** The plausibility band drops the
  contradictions; a wrong count inside the band survives.
* **Sutro Tower is missing.** The LiDAR fills its upper structure's outline (683 m²,
  median 210 m, max 286 m), which made one block at 231 m and columns at 228 m and 225 m
  (a 16 m² one). Overrides now make those three records 3 m plinths, so Sutro crest shows
  only the plinths and the equipment buildings. All six records within 60 m are listed
  under the `sutro-tower` probe for a landmark replacement; `content/landmarks.json` has no
  Sutro entry yet.
* **Freeway and bridge decks** have no elevation in the source. The graph has them
  (flagged `gradeSeparated` / `bridge`); the GLB drapes them on land and omits freeways over
  water. Treasure Island and Yerba Buena Island are built, but no road joins them to the
  city (wave 8: the Bay Bridge deck).
* **Pier buildings** stand on water: the bare-earth DEM has no pier decks. Their roofs are
  at the LiDAR's absolute height.
* **Sidewalks are procedural.** No sidewalk lies on a road, so a median too narrow for one
  has none, and a median wide enough keeps its inner sidewalks. Where a sidewalk is cut
  next to another road (an acute wedge between two streets, a slip lane alongside) its
  piece ends in a dead end rather than a link; very short edges can make corners overshoot
  (clamped at 3 offsets). Freeways have no deck height yet, so a street under an elevated
  freeway is cut and bridged by a crossing as if the freeway were at grade. Hydrants are
  procedural.
* **Far-LOD hulls are convex**, so a block cluster's hull covers its back yards.
* **Some thin LiDAR towers remain:** 52 under 60 m² over a low podium, all under 54 m
  (steeples, rooftop structures, and spikes the data cannot tell from them). Towers of
  60 m² and more are kept when the moment model accepts them. A tree mask (DataSF *Urban Tree
  Canopy* `ni2e-vpbg`) would catch the remaining tree-made ones.
* **The world's edge:** footprints and roads that straddle the outermost tiles extend past
  the last heightfield. The sim's ground outside the tiles is 0; `boundary.json` gives the
  land runs to wall off. The southern wall follows the 500 m tile grid, up to 500 m south of
  the real city limit.
* `report.json` and the tests live with the data. `tests/schemas/schemas.test.ts` (harness)
  also validates every sf file against the schemas.

## Tests (`tests/pipeline/`, no network)

* `sf-world.test.ts`: goldens on the committed world:
  * schemas (manifest, roads, every collider, every data layer), the tile grid, no stray
    files, wave-1 area coverage (built or open water);
  * the tallest building in the M0 box is the 415 Mission St tower at 325.1 m (within 10 %
    of 326 m). That golden checks the override in `pipeline/overrides.json`, and its name
    says so. The LiDAR scaling is checked by override-free goldens, each within 10 % of the
    public-record roof: 600 Montgomery St (258.6 m vs 260), 555 California St (243.3 vs
    237), 101 California St (189.3 vs 183) and 301 Mission St (194.9 vs 197);
  * condominium towers whose units list 1–2 storeys keep their LiDAR towers (within 10 %):
    One Rincon Hill (179.9 m vs 182), 757 Market St (130.4 vs 130) and the Watermark
    (73.0 vs 73);
  * every tower wave 1's last fix built (631 ids in `wave1-towers.json`) still stands,
    unless the file lists it as a canopy or spike drop that its meta confirms;
  * Sutro Tower's six probe records are under 20 m (three are override plinths);
  * no needles: every tower covers at least 20 m² and rises at most 10.6× its width above
    its podium; the review's needle examples are single prisms near their median roof;
  * meta storeys agree with the LiDAR height, and condominium towers are not one-storey
    houses;
  * ground at the origin is a few metres up, the bay is water, Telegraph Hill is above 60 m,
    and tile borders are shared exactly;
  * every building's `baseY` is within 1 m of the ground under its centroid, and no
    footprint vertex has `footY` above the ground;
  * every road edge references existing nodes and starts and ends on them; numbered
    streets have no zero padding; freeways are `gradeSeparated` and the I-80 Bay Bridge
    approach is a `bridge`;
  * the spawn is on The Embarcadero, heading along it, and the sim drives 3 s from it
    without a hit;
  * storefronts face out of their building and carry no names or ids.
* `citywide.test.ts`: coverage (toll plaza, Presidio, Ocean Beach, Lands End, Lake Merced,
  the southern limit, Hunters Point, Treasure Island, Yerba Buena) and open water; the Twin
  Peaks summit next to 37.7544, −122.4477 at 270–290 m (the coordinate itself is on the
  north slope at 250 m; the summit is 120 m south), Mount Davidson, the city's maximum under
  290 m; Ocean Beach at sea level; the road graph routes the Ferry Building to Pier 70 in
  ≤ 5.5 km and reaches the toll plaza and Ocean Beach; district polygons valid; the
  `outside` tiles by area (Alcatraz, Marin, San Mateo County); the sidewalk graph connected
  across seams (99 %+ of the mainland in one piece) with offsets as specified, and no node
  within 0.5 m of a road and no point of any sidewalk on one (sampled every metre, against
  an independent road-surface index); hydrants on land, at least 1 m off every road,
  outside buildings, 120 m apart; the boundary outline between built tiles and tiles with
  no file, land walls at the southern limit and water off Ocean Beach, the shore with land
  on its left and on Ocean Beach's waterline; thin LiDAR towers capped (200, under 60 m);
  the Sutro Tower probe; transit, cable car lines, Street Cleaning and parking edges.
* `world-colliders.test.ts`: the pack decodes to exactly the JSON colliders and re-encodes
  byte for byte; its ground lookup equals the sim's; escapes, negative coordinates, parts,
  towers; refusals and a corrupt file.
* `budgets.test.ts`: every budget in `budgets.json`.
* `sf-glb.test.ts`: every tile and far cell through the Khronos validator (compressed and
  decoded) and three.js's `GLTFLoader` with the meshopt decoder; the quantisation grid;
  ground on the lattice after dequantisation; seams meet exactly; building ranges match
  the collider; far cells are one mesh each.
* `layers.test.ts`: the layer builders on synthetic inputs: sidewalk corners and crossings,
  a freeway crossing a street with no junction (cut and bridged), a divided road whose
  median is too narrow (no median sidewalk, one crossing over both carriageways), hydrant
  spacing and kerb clearance, parsing, far-LOD hulls, districts.
* `build-fixture.test.ts`: the whole build on a synthetic two-tile world. Byte-identical
  twice, plus every modelling rule above: the boundary outline and shore, oneway `T`
  reversal, layer drops, classcode mapping, two-tier pairing, an outlier max making no
  tower, tree canopy and a LiDAR spike removing a tower the moment model accepts,
  condominium joins, a condominium tower whose units list 1–2 storeys keeping its tower,
  implausible storeys, freeway and bridge flags, the assessor-storey
  rule, overrides, footY on a slope, water, seams, storefront filtering and privacy, and
  GLB validity.
* `tower-rule.test.ts`: the tower rule on real DataSF statistics: the 600 Montgomery
  pyramid, the Ferry Building clock tower, Coit Tower, the Russ Building and an office slab
  keep their towers; five measured needles (including the review's four) do not.
* `geotiff.test.ts`: the TIFF reader against TIFFs built byte by byte.
