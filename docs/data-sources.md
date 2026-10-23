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
408/425/428/429/5xx are retried up to 9 times with exponential backoff capped at 60 s. A warm
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
| Height corrections and added buildings | `pipeline/overrides.json`: public-record heights for buildings newer than the LiDAR, placeholder plinths where the LiDAR saw a lattice as a solid block, LiDAR towers kept against the spike check, and buildings the footprint layer does not have (`add: true`, with the 2010 record they replaced retired) | `heightM` (with `placeholder: true` for a stand-in) or `keepTower: true`; an added building's parcel or position and size, storeys, year, use; a `source` note per entry | Facts, cited per entry |
| Lot outlines for newer buildings (W-04) | DataSF *Parcels – Active and Retired*, [`acdm-wktn`](https://data.sfgov.org/resource/acdm-wktn.json): the polygons of the 9,046 parcels built since 2010 | `blklot`, `shape` | PDDL 1.0. "City and County of San Francisco, DataSF" |
| Park land (W-18) | DataSF *Recreation and Parks Properties*, [`gtr9-ntp6`](https://data.sfgov.org/resource/gtr9-ntp6.json): 255 properties; National Park Service land resources boundaries (the GGNRA units in the city) | property type, `shape` | PDDL 1.0; NPS data are public domain |
| Tree canopy (W-18) | DataSF *Urban Tree Canopy*, [`ni2e-vpbg`](https://data.sfgov.org/resource/ni2e-vpbg.json): 97,104 polygons (114,069 parts) | `the_geom` | PDDL 1.0. "City and County of San Francisco, DataSF" |
| Inland lakes (W-11) | USGS National Hydrography Dataset, large-scale waterbodies: 59 in the city box, 28 used (`pipeline/landcover.json`) | permanent identifier, FTYPE, outline | Public domain (USGS) |

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
| 870 | **581** | 519 | 533 | 574 | 234 | 56 (55 candidates, 1 beyond) |

Open-water tiles are listed in `manifest.json` `water.tiles`, beside `water.y` (0, sea
level) and `water.bbox` (the candidate rectangle, [−11000, −4500, 3500, 10500]). The 56
land tiles with no file are listed in `manifest.json` `outside.tiles`, each with its area. The
list holds every land tile 4-adjacent to a built tile (W-40), the candidate rectangle's or
not: the east tip of Yerba Buena Island (`t7_-5`) lies beyond it.

| `area` | Tiles | What it is |
|---|---|---|
| `marin` | 29 | The Marin headlands across the Golden Gate |
| `san-mateo-county` | 21 | Daly City and Brisbane: row 20 from `t-20_20` to `t0_20`, south of the last built row since the Daly City strip became far scenery (W-42) |
| `alcatraz` | 4 (`t-6_-8`, `t-5_-8`, `t-6_-7`, `t-5_-7`) | Alcatraz Island. It **is** San Francisco, but no footprint, street or neighbourhood polygon covers it, so it is not built. The design has it "visible from the start" and reached by ferry later, never driven: the far-LOD terrain draws it, a landmark model can sit on it. |
| `pacific-shore` | 1 (`t-22_7`) | A strip of Ocean Beach sand west of the last built tile, outside the neighbourhood polygons |
| `yerba-buena-island` | 1 (`t7_-5`) | The island's east tip, beyond the candidate rectangle beside the built `t6_-5` (W-40) |

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
| Mission Dolores | `201006.0001563`, `201006.0001563-tower` (the bell tower, kept against the spike check by a `keepTower` override) |
| Conservatory of Flowers | `201006.0001537`, `201006.0001537-tower` |

`content/landmarks.json` must list a landmark's records exactly as its probe does
(`sf-world.test.ts` checks every replaced id exists and matches the probe of the same id). After the wave-1/wave-2 reconciliation the one entry
with `replacesBuildingIds`, the Ferry Building, still matches its probe; the probes whose
records changed (Sutro Tower and the Beach St pier lost their `-tower` records; Mission
Dolores has its `-tower` again since the `keepTower` override) have no landmark entry yet.

**Heights.** The footprint dataset's height statistics come from a **June 2010 LiDAR
survey** (the `201006` prefix and the `p2010_*` fields), even though the footprints
themselves are newer. For each footprint, in order:

1. **Override** (`pipeline/overrides.json`), keyed by `sf16_bldgid` and checked against
   the parcel. Each entry sets exactly one of `heightM` and `keepTower` (`checkOverrides`;
   the build fails otherwise, and when an entry matches no footprint). There are five.
   415 Mission St (completed 2018), whose LiDAR median is 0.24 m (the 2010 site was the
   old Transbay ramps), is set to its public-record 326 m roof. Three Sutro Tower records
   are set to 3 m plinths with `placeholder: true`: the footprint dataset outlines the open
   lattice's upper structure as seen from above and the LiDAR fills the outline (683 m² at
   a 210 m median, max 286 m), so they were solid blocks 225–231 m tall over the west side.
   The plinths stand in until a landmark model replaces the probe's records. A placeholder
   record keeps `parcel` and `year` but no `stories`, `use`, `units` or `condo`: the parcel's
   3 storeys of "Commercial Retail" describe a building that is not drawn, and a facade
   must not paint 3 storeys on a 3 m block. The fifth, `keepTower: true` on Mission Dolores
   (`201006.0001563`), changes no height: it exempts the building from the spike check
   (below), and the build fails if the building ends up without a tower.
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
       (73 buildings). These are mostly the scan catching a neighbouring tower, a crane or
       a tree: 26–59 m² slivers 30–60 m above 7–15 m shops and offices downtown
       (`201006.0007252`, a 1-storey shop on a 70 m sliver; `201006.0000531`, 4 storeys on
       a 70 m one). **The check can also remove a real steeple** over a nave the roll counts
       as 1 or 2 storeys. Mission Dolores Basilica (a 14.1 m nave, 1 storey, a 39.0 m bell
       tower of 55 m²) was one; a `keepTower` override keeps it (`spikeTowersKept` = 1).
       How many others there are cannot be read from the data: the 2025 roll has no
       religious or civic use code (churches, schools and institutions are filed under
       `COMM` Commercial Misc, `MISC` Miscellaneous/Mixed-Use or `GOVT`), and the build
       selects no finer class. `report.json` `buildings.spikeTowersDroppedByUse` splits the
       73 drops by the parcel's `use_code`: **COMR 29, MISC 14, none 13, COMM 9, COMO 4,
       IND 2, GOVT 1, SRES 1**. The 24 on `COMM`, `MISC` and `GOVT` bound the false
       positives among landmarks of that kind; the 33 on retail and office podiums are
       the downtown slivers above. A real steeple found later gets its own `keepTower`
       entry with a source note.
   * **Two-tier massing** for the rest, in **2,326 buildings**: a podium at `hgt_median`
     over the whole footprint, plus a tower at `hgt_max` covering `a` of it. The tower
     footprint is the building's footprint clipped to a square of that area, centred on the
     centroid and aligned with the longest wall (lengthened along the wall where the
     building is narrower than the square). A long hall therefore gets a compact tower, not
     a slab. This keeps the Ferry Building a low hall with a clock tower (a = 0.018,
     181 m²) rather than a 75 m wall. 53 thin towers remain (under 60 m² over a podium
     under 15 m, rising 15+ m), all under 54 m (`report.json` `buildings.thinTowers`,
     `thinTowerMaxM`; a test caps them at 200 and 60 m): steeples and rooftop structures,
     Mission Dolores' bell tower among them.

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
   removed, less the one spike `keepTower` exempts (Mission Dolores), so 123 + 73 removed,
   2,326 towers left, 53 thin ones under 54 m. Every rejected max, by any of the
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
the kept footprints, 165,962 have a year built and 161,549 a storey count. With the 2,326
towers that is **177,921 collider records**. Three corrections:

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
  one). 384 counts fail and are left out: condo units, a parcel's tower storeys on its low
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
  (not real streets), `PRIVATE_PARKING`, `PSEUDO`, `UPROW` (unpaved, mostly stairways),
  except that UPROW and PAPER stairways are kept as `stairs` edges (W-33, below).
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
    candidate tiles' water flags after the pier decks are raised, the DEM beyond them): the
    I-80 Bay Bridge west span to Yerba Buena Island and the stub east of it, in both
    directions; the Golden Gate Bridge approach off the toll plaza (Hwy 101 both ways); I-280
    and two of its ramps over Islais Creek and the Mission Creek channel; the 3rd St, 4th St
    and Illinois St bridges. Node `y` is the ground; the road surface is the deck.
  * `deck: true` where part of the edge is carried on a deck, `tunnel: true` where part runs
    in a bore, `stairs: true` on a stairway (always with `pedestrian`). See [Streets, hills
    and structures](#streets-hills-and-structures-world-qa-2026-10-21).

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

## Streets, hills and structures (world QA, 2026-10-21)

The world QA report (`docs/qa/`) found the footprints, the DEM and the street centrelines
disagreeing in ways that wall streets, bury buildings and drape roads over hills. The build
now runs these passes, in this order, after the buildings and the road graph
(`pipeline/lib/build.ts`; numbers from the sf build):

1. **Piers (W-13, `piers.ts`).** The bare-earth DEM has no pier decks: its hydro-flattening
   reaches under them, so the old build stood pier sheds in the bay and ran pier roads at
   y = 0. A *pier shed* is a footprint of 400 m² or more at least half over water; a *pier
   street* is a surface street over water within 25 m of a shed (Al Scoma Way, Pier 45 Vly,
   Pier 50 Vly). The deck is the union of the sheds grown by 4 m and the pier streets grown to
   their kerbs plus 4 m; every lattice sample inside it that is water or under 3 m is raised to
   **3 m** and becomes land (32 sheds, 2,199 samples, 22 ha). Road node heights, the `bridge`
   flags and the pier buildings' foot and base are then taken from the raised ground; their
   roofs keep the LiDAR's absolute height (it measured them from the water). Smaller
   structures over water float where they are (61, 4,400 m² in all: Mission Creek's
   houseboats, Fisherman's Wharf's stalls and boathouses, the Pier 70 shipyard's cranes and
   huts). The shore (`boundary.json`) follows the raised decks.
2. **Tunnels (W-02, `tunnels.ts`, lined in `decks.ts`).** Tunnel edges are found by name
   (`Tunl`, `Tunnel`) and, for the freeway tunnels, by route and place (`FREEWAY_TUNNELS`: the
   MacArthur Tunnel on Hwy 1, the Presidio Parkway's Battery and Main Post tunnels on Hwy 101,
   the Yerba Buena Island tunnel on I-80). Edges the source splits inside a tunnel are one
   chain. The road through a hill is the highest profile under the ground that never climbs
   faster than 6% (the ground eroded by a 6% cone); a bore is where the hill stands more than
   3 m over it, run on to where the cover over its straight line falls to 0.1 m (the portals).
   The Yerba Buena Island tunnel has fixed portals instead, where the road's benches (cut into
   the island at about 52 m and 57 m) meet the ridge: the Bay Bridge spans either side are at
   sea level in the DEM and the island's flanks fall steeply under its viaducts, so no cone
   from the ground finds it. A street tunnel's bore is final. A freeway's is a *zone* the deck
   pass (7) lines: through it the road is free of the ground and runs straight between the
   profile the rest of the network sets at its ends, and the bore is where that line is
   under the hill, out to where the cover falls to 0.1 m; the rest of the zone is open road
   again and solved as such (so a portal can open onto a viaduct, as the Presidio Parkway's
   does over the valley west of the Battery tunnel). A ramp that joins its freeway inside a
   bore (the island's westbound on-ramp) gets a bore of its own from that node out (8% at
   most). Each bore is a `tunnels` ribbon with a 5 m ceiling, its edge is flagged `tunnel`,
   and the buildings over it get an underside (`underY`) at their foot, or 0.3 m over the
   ceiling where the cover is thin (68 records). Both Broadway bores, the
   Stockton and Toll Plaza tunnels, the MacArthur Tunnel (both directions), the Presidio
   Parkway's tunnels (the Battery tunnel northbound, the Main Post tunnel southbound) and the
   Yerba Buena Island tunnel (both decks, side by side as the source draws them, not stacked)
   have bores.
3. **Carriageway and path clearance (W-01, W-39, W-43, W-16, `clearance.ts`).** No footprint
   may wall a street or a path. In order: a `-tower` record a freeway crosses is an overhead
   structure, not a tower, and is dropped (the Golden Gate approach over Fort Point); a
   footprint that a street added or rebuilt after the June 2010 LiDAR crosses for 5 m or more
   (street dates from DataSF `3psu-pn9h` `date_added`/`date_altered`), on a parcel the roll
   does not date before 2010, is gone (101: Treasure Island, Pier 70, the Presidio Parkway);
   where buildings stand in a corridor but a clear one exists within 3 m to one side, the
   centreline moves into it (528 edges re-registered); what still intrudes is cut out of the
   footprint, and a structure tall enough to have a passage under it keeps the piece over the
   street as a span record (`-b<n>`, `meta.piece` `span`) with an underside 4.6 m over the
   highest road under it (the Transit Center over 1st St, the Moscone bridge over Howard).
   The corridor is the centreline buffered by 2.6 m on two-way streets of two or more lanes,
   1.6 m on one-lane streets and alleys, 0.9 m on paths. An UPROW or PAPER stairway that still
   runs through a building is dropped instead of cutting houses. Freeways and ramps are the
   deck pass's. After every pass a tower stands inside its podium: where a pass cut the
   podium back from a street or a path the tower overhung (Lick Pl, Emma St, Minna St,
   Fallon Pl), the tower is cut to what is left of the podium, or dropped under 4 m².
4. **Terraces (W-05, W-28, `terrace.ts`).** A footprint with more than 6 m of relief under it
   is cut into strips across its slope (the downhill direction of a plane fitted to the
   ground), each with at most 3.5 m of relief where a 3 m wide strip allows, and each strip
   is its own record (`-s<n>`, `meta.piece` `strip`) with its own ground and roof (its mean
   ground plus the building's LiDAR height above ground). Every record's roof stands at least
   2.5 m over the highest ground under it. The clearance pass runs again afterwards for the
   strips whose roofs rose.
5. **Shared walls (W-36, `shared-walls.ts`).** Footprint simplification preserves topology:
   vertices of different footprints within 5 cm snap together, a vertex 5–12 cm from the
   interior of a neighbour's wall is inserted into it, every vertex a neighbour uses is kept,
   a wall within 0.6 m of a neighbour may move only 3 cm, a wall shared by two footprints is
   simplified once for both, and a vertex left within 12 cm of a neighbour's wall that one of
   its walls runs along is welded onto it. A simplified ring that crosses itself is untangled
   (its largest simple part) before falling back to the source ring (W-30). In the houses
   audit's four sample boxes no pair that touches in DataSF is a crack any more, and the city
   has fewer 5–60 cm cracks (about 14,400) than the source (21,174,
   `tests/pipeline/fixtures/shared-walls.json`).
6. **Stairways (W-33, `roads.ts`).** UPROW and PAPER segments (otherwise dropped) are kept
   when steeper than 25% (UPROW) or 30% (PAPER), and a pedestrian way steeper than 20% is a
   stairway: such edges are `pedestrian` and `stairs`, one lane, two-way, 3 m wide (185
   edges, among them the Filbert, Greenwich, Lyon, 16th Avenue tiled (Moraga St), Vulcan and
   Harry steps).
7. **Decks (W-03, W-07, W-12, W-14, `decks.ts`).** Every freeway and ramp gets one profile
   over the whole network: the lowest that stands on the ground, 5 m over every street it
   crosses, 1 m over every low roof under it, 3 m over water, never steeper than 6% (8% along
   a ramp; 0.5% over water, so the I-280 viaducts hold their height over Mission Creek and
   Islais Creek), with no crest tighter than 150 m; through a freeway bore's zone it runs
   straight (2). Three upper bounds shape it, each a cone the ground alone may override: a
   ramp comes down to its street at 8% at most; a freeway under a street on top of it (below)
   stays on its ground there and comes down to it at 6%; and a lower bound over a cone gives
   way to it. A ramp the source draws too short to come down from its gore at 8% runs the
   straight line from its street to its gore instead (1: the Sterling St on-ramp to the Bay Bridge, 29 m long in the source, at 27.5%; `report.json`
   `decks.shortRamps`). Where the profile stands more than 0.1 m over the ground it is a deck
   (kind `freeway` or `ramp`, layer 2 where it crosses over another deck), thinned to the
   vertices a straight line needs (5 cm across, 1 cm in height); open water longer than
   400 m, or running out of the world, is a bridge the world does not model (no deck, no
   ribbon). Grade separations (two edges crossing with no node in common) are resolved from
   what the DEM kept: the edge that dips (into a cut under its removed span) or humps (up its
   approach embankments) is on top and gets an `overpass` deck along its chain (same-named
   edges through nodes no other road meets), the straight line between its approaches raised
   by a smooth bump to 5 m over the road under it, wide enough that its crest is no tighter
   than 100 m where the chain leaves room and never tighter than a car at 1.3 times the
   street's speed limit keeps its wheels on (at least 25 m). A street that cannot bridge a
   freeway within its chain (a junction too near) leaves the freeway to bridge over it
   instead (1); a street on top of one carriageway is on top of its twin; between
   two streets one order holds per pair (the clearest dip or hump decides); and wherever a
   structure passes over the other road by less than 5 m after all that (a neighbouring
   bridge, a ramp's foot, a portal), the street on top bridges it properly, or the crossing
   is listed in `decks.unresolvedCrossings` (7: neither road can bridge the
   other there). Where neither moves, the freeway is a viaduct over the street. Every surface
   street over water gets a `bridge` deck on the straight line between its banks (3rd St and
   4th St over Mission Creek, 3rd St and Illinois St over Islais Creek), and the Lefty O'Doul
   Bridge (3rd St over Mission Creek) is a `movable` bascule hinged at its north end. Edges
   with a deck are flagged `deck`. `pipeline/lib/surfaces.ts` is the reference road-surface
   lookup over decks and tunnels for the sim. (25,963 freeway samples, 13,760 on decks, up to 47.1 m over the ground; 309 streets under a freeway, 42 overpass pieces, 11 streets bridging a freeway near a portal or a ramp's foot, 41 decks over another, 105 low roofs cleared, 9 creek bridge pieces)
8. **Road surfaces (W-09, W-10, W-32, `mesh.ts`).** A road ribbon on the ground is draped on
   the ground mesh's own triangles (each ribbon triangle clipped to the lattice triangles
   under it, unless the ground under it is one plane within 1.5 cm) and lifted 2 cm, so the
   drawn road and the ground the sim drives on agree within 5 cm everywhere and the ground
   never shows through. A draped vertex sits on the glb's own 1/64 m position grid and keeps
   its 2 cm over the ground there (on a cliff, a centimetre across is centimetres up). On a
   deck, in a bore or an overpass the ribbon is level across at the structure's surface. Where
   three or more streets meet, each ribbon stops where it clears every other street's ribbon
   from the node out (an acute fork trims further than a square crossing; a street running
   straight through is not trimmed by its own continuation), at least the widest street's half
   width and at most 30 m or half the edge; one junction polygon (the convex hull of the kerbs
   the trimmed ribbons give up) covers the crossing, and a ribbon the hull still reaches into
   stops where the hull ends. The polygon has texture coordinates (0.25, 0): plain asphalt, no
   kerb strip or lane line. Double-drawn street area on the checked tiles fell from 6.2% (W-32)
   to 0.38% (at most 0.5% asked), and the trims leave under 0.01% of the street area undrawn.
   Where two street ribbons run side by side (within 30 degrees of parallel) closer than their half widths together, a divided street's carriageways
   or a frontage road, each gives up its share of the overlap (never under 1 m half width) so
   their kerbs meet instead of z-fighting. A deck's level ribbon is lifted over any hump of the
   ground mesh between its stations. Elevated decks get a `structures` node (sides, underside,
   columns every 30 m).

Contract fields these passes use (all additive, `src/sim/contract.ts` and the schemas):
`underY` and `meta.piece`/`meta.pieceOf` on buildings, `decks`, `tunnels` and `movable` on
colliders (and their FCWC extension sections), `deck`, `tunnel` and `stairs` on road edges.

## Ground cover, newer buildings, houses and the far ring (world QA, 2026-10-22)

The second half of the world QA round (`docs/qa/`): what the ground is, the buildings the
2016 footprint layer misses, the data the house kit needs, and the far layer the streaming
ring stops against. Numbers from the sf build.

**Ground cover (W-11, W-18, W-34; `pipeline/lib/landcover.ts`, rules in
`pipeline/landcover.json`).** Every lattice sample gets one class in the tile collider's
`ground.cover` string (one character per sample, the heights' layout): `u` urban or bare,
`g` grass, `f` forest, `s` sand, `w` the Bay or the ocean, `0`–`9` an inland lake (the index
into `ground.lakes`, `{ id, name, y }`). Citywide: 1,054,822 urban, 130,472 grass, 91,166
forest, 11,564 sand, 207,809 sea and 15,348 lake samples.

* *Lakes:* the 28 open waterbodies of USGS NHD (public domain) listed by permanent id in
  `landcover.json` (every NHD lake or pond in the city; of the reservoirs only the open ones:
  the covered reservoirs and the treatment plant's tanks are roofs). The level is the lake's
  lattice median where the DEM is hydro-flattened (60% of its samples within 5 cm of it), else
  its 10th percentile (Mountain Lake and Lily Pond were surveyed rough). Every sample inside
  the outline no more than `bankM` (2.5 m) over the level is flattened to it, and the lake
  grows over the flat samples beside it (5 cm, up to 30 m out). Lake Merced is 5.25 m (South
  Lake) and 5.3 m (North Lake), Stow 87 m, Spreckels 40.9 m, Pine 12.8 m, Mountain Lake
  41.66 m, the Palace of Fine Arts lagoon 1.4 m. A lake's water flag stays 0 (that flag is sea
  level only); the collider pack's `LAKE` section carries the mask for the sim, and the ground
  mesh draws lake samples in the water colour, never grass.
* *Grass:* DataSF *Recreation and Parks Properties* (`gtr9-ntp6`) of the park types listed in
  `landcover.json` (327 properties) and the National Park Service units (the Presidio, Lands
  End, Ocean Beach, Fort Funston, Fort Mason; 36 polygons, public domain).
* *Forest:* DataSF *Urban Tree Canopy* (`ni2e-vpbg`, 114,069 polygons) rasterised at 2.5 m: a
  sample is forest where canopy covers half its cell and it is park land or half the 50 m
  window around it is canopy (a wood, not a back-yard tree).
* *Sand:* land within a shore distance of the open water and under a height, inside named boxes
  (Ocean Beach, Baker Beach, China Beach, the Crissy Field and Aquatic Park beaches): the box says
  where a beach is, the shore and the height which samples are sand.
* *Foliage:* the glb nodes `foliage-broadleaf` and `foliage-conifer` (`EXT_mesh_gpu_instancing`,
  used but not required): one tree per 10 m cell whose canopy cover is 40% or more, at the
  canopy's centroid in the cell, never in a building, on a road ribbon or on water or sand;
  146,932 trees.

**Newer buildings (W-04; `pipeline/lib/newer.ts`).** The footprint layer is a 2016 snapshot
measured by the 2010 LiDAR. A 2025-roll parcel built in 2010 or later with storeys and no
record within 15 m of its point takes its lot outline from DataSF *Parcels – Active and
Retired* (`acdm-wktn`), less the part any record already covers, at storeys × the use's storey
height; a lot whose every parcel lists an implausible count (the Hunters Point Shipyard's 680
and 688) takes its block's median. 197 lots are added (6 two-tier); their ids are
`201006.9000001` up, `meta.outline: "parcel"`. `pipeline/overrides.json` entries can now add
a building (`add: true`: The Avery, 33 Tehama, Fifteen Fifty, Chase Center; ids
`201006.99xxxxx`, `meta.outline: "override"`) and retire the 2010 record a new one replaced
(two retired). Park Tower at Transbay is 184.5 m. Mission Rock and the Shipyard hilltop come
from the parcel pass.

**The Daly City strip (W-42).** Records south of the county line (z > 9,600 m) in no San
Francisco neighbourhood never make a tile built (`docs/design.md`, decision log 2026-10-21).
Row 20 is no longer built west of x = 140: its tiles are `outside` (`san-mateo-county`). Inside
row 19 (the 500 m grid reaches past the county line) the world stops at the line itself: a 10 m
lattice cell is cut when its centre is south of z = 9,600, in no neighbourhood, and more than
`COUNTY_POCKET_M` (15 m) beyond every road's kerb, and `boundary.json`'s land edges run round
the cut cells. The pocket round each San Francisco street that carries on a little past the line
(Mission St, Geneva Ave, I-280 and about 70 others) keeps every lane and sidewalk at least 7.9 m
clear of the wall. A strip record wholly in cut cells is scenery: no collider, storefront or
district; its tile's glb draws it in a `buildings-scenery` node (the renderer hides the far layer
over a streamed tile, so it must be in the tile) and the far layer draws it everywhere. A strip
record that reaches into a pocket stays a near record, drawn and solid. `report.json` `farOnly`:
2,967 scenery records (2,938 drawn in row-19 tiles, 29 in row 20), 393 kept solid in pockets.

**House data (W-15, W-29, W-37, W-38, W-46 to W-50; `pipeline/lib/house.ts`,
`docs/qa/house-kit-spec.md` K0 to K8).**

* *Street level (K0):* `meta.streetY` is the ground at the middle of the record's street wall
  (its wall of 3 m or more nearest a street, within 6 m of the kerb), written where it differs
  from `baseY` by 10 cm or more. The facade's storey grid starts there (uv v = 0).
* *Storeys (K2):* a residential facade's storeys are its wall height (roof less a roof allowance
  of up to 3 m, from the street) over 3.2 m, each at most 4.2 m; a 1920–1960 row shows at least
  the roll's storeys plus its garage storey. `_FACADE.x` is the storey height / 8 m.
* *Wall classes (K1):* per footprint edge, `_FACADE.w` = 0 rear or side, 85 party (another
  outline within 0.6 m along 60% of it), 170 front (a street or path straight out within its
  half width + 12 m, or a storefront anchor on it), 255 roof.
* *Fronts (K4–K8):* node `extras.fronts` on the buildings node lists one row per facade (a run
  of front walls facing the same way, through bay facets and recesses of up to 3 m), framed by
  its chord: `[record index, middle x and z (dm from the tile's north-west corner), bearing
  (degrees), length (dm), street level (cm), first floor's rise over the sidewalk (dm), storeys,
  storey height (cm), flags]`. Flags: 1 bay (residential, built 1925 or earlier, a facade of
  4.5 m or more and two storeys), 2 stoop (the first floor 1 m or more over the sidewalk), 4
  garage (residential, 1920–1960, the house 5 to 16 m wide along the facade and 2.8 m of facade
  for the door), 8 shopfront (a storefront anchor on it), 16 roofline (residential or mixed, before
  1940, in a row). The renderer and the assets' house kit lay their modules from these rows.
  `storefronts` is now a manifest layer (K5).

**The far ring (W-17, W-40, W-41; `pipeline/lib/far.ts`).** See [Far-LOD massing](#far-lod-massing-fx_zglb).

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

Written with `@gltf-transform/core` and `@gltf-transform/extensions`. All 581 tiles (and
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
| `ground` | The heightfield as triangles split along the (i+1, k)–(i, k+1) diagonal. All-water cells are greedily merged into flat rectangles (an all-bay tile is one quad). `NORMAL` comes from central differences on the global lattice, so seams shade continuously. `COLOR_0` by ground class (`ground.cover`): water (the Bay and every lake) blue-grey, grass, forest, sand, land warm grey. |
| `foliage-broadleaf`, `foliage-conifer` | Instanced trees (W-18): a small vertex-coloured prototype drawn once per instance by `EXT_mesh_gpu_instancing` (used, not required); instance `TRANSLATION` about the tile centre (the node's translation, scale 1), `SCALE` (crown width, height, crown width). Only in tiles with trees. |
| `buildings-scenery` | The Daly City strip's records past the county-line wall (W-42), built like `buildings` (same material, attributes and wall classes) but never collided with; node `extras.scenery` = `[[id, firstIndex, indexCount], …]`. Only in row-19 tiles that reach past the county line. The renderer's layer rule (`/^buildings?/`) already draws it as buildings. |
| `roads` | Surface road ribbons 0.15 m above the mesh ground, each side draped separately, densified to ≤ 8 m. `TEXCOORD_0` = (0 left kerb … 1 right kerb, metres along the edge, continuous across tiles). |
| `freeways` | Freeway and ramp ribbons, draped like roads. The source has no deck heights: they lie on the terrain, and stretches over the bay (the Bay Bridge) are not drawn. A separate node, so a renderer can hide it. |
| `buildings` | Every collider record in the tile, merged, with no normals (glTF loaders shade flat; three.js sets `flatShading`). `COLOR_0` is the facade colour, darker at the foot. `TEXCOORD_0` = (metres along the wall, metres above `baseY`); roof vertices use (x, z). `_FACADE` (three.js: `_facade`, normalized uint8 ×4) = (storey height / 8 m, glazing 0–1, (year − 1840)/190 or 0 if unknown, wall class: 0 rear or side, 85 party, 170 front, 255 roof). `TEXCOORD_0.y` is metres above the record's street level (`meta.streetY`) or its base. Node `extras.buildings` = `[[colliderId, firstIndex, indexCount], …]` in collider order, so a renderer can hide a building a landmark replaces; `extras.fronts` lists the house kit's facades (see [House data](#ground-cover-newer-buildings-houses-and-the-far-ring-world-qa-2026-10-22)). |

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
    `hydrants`, `fountains`, `transit`, `signals`, `streetCleaning`, `parking`, `storefronts`). Each file validates
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
one binary pack for the whole city, **14.75 MB** (budget 15 MB), against 97.3 MB for the
581 per-tile JSON colliders. Format FCWC version 1, specified in
[`schemas/world-colliders.md`](../schemas/world-colliders.md): a 64-byte header, a tile
table, every tile's 51 × 51 heightfield as int16 cm and its water mask as bits, then 20-byte
building records (id number, part, tower flag, vertex count, `baseY` int16 cm, height
uint16 cm, first vertex int32 cm) and a stream of int16 cm vertex deltas with an escape for
long edges. `pipeline/lib/world-colliders.ts` has the encoder and the reference reader
(`decodeWorldColliders`, pure TypeScript over a `DataView`, plus `PackGroundIndex`, an O(1)
tile-indexed ground lookup). The reader decodes the pack to exactly the JSON colliders'
values (everything is whole centimetres in both), and a test proves it for every tile. An
extension block (header offset 28) carries the additive fields: building pieces and
undersides (`BEXT`), every tile's decks (`DECK`), tunnels (`TUNL`) and movable spans
(`MOVE`), with their ids in a string table (`STRS`), and the inland-lake masks (`LAKE`, W-11:
a lake sample is water at its height, which is the lake's level). The ground cover classes and
the lakes' names stay in the JSON (`ground.cover`, `ground.lakes`): they are the renderer's.
Encoded for the static web build (gzip level 6, base64) the pack is 14.19 MB, over that build's
14 MB per-file margin, so `scripts/build-web.ts` writes it as parts the page joins.

The per-tile JSON colliders still ship (97.3 MB, inside the 100 MB budget for them): they
are today's contract for the sim's boot and the renderer, and they carry `meta` (footY,
year, use, storeys) the pack leaves out. **The sim should switch to the pack**; see
[What the sim and renderer must change](#what-the-sim-and-renderer-must-change).

## Far-LOD massing (`fX_Z.glb`)

`pipeline/lib/far.ts`. Every record (the 193,197 collider records and the Daly City strip's
2,967 scenery ones), simplified and merged per large cell, with the terrain beyond the
streaming radius. The grid starts at the far box's north-west corner with **3,500 m cells**;
26 cells hold something. One glb per cell, one node `far`, one primitive, so one draw call per
cell (budget: 40 draw calls, 600k triangles). The far box is the config's (`areas.json`
`far`: the Marin headlands to San Bruno Mountain) and the candidate rectangle, grown over every
`outside` tile: [−11000, −7500, 4000, 13500].

* **Terrain (W-17, W-40),** per 500 m tile square: every tile border is a polyline through the
  near tiles' own 10 m lattice samples, simplified to 0.5 m and keeping every 100 m point,
  shared exactly by the squares either side, and lowered 0.5 m; so where the streaming ring
  stops, the far terrain meets the near ground (never above it, at most 1 m below) and no sea
  shows through. Inside, a 100 m lattice on a built tile, 50 m where 100 m misses the 10 m
  lattice by more than 10 m (the hills); 250 m or 100 m on every other square; cells along a
  border are fans through its vertices (no T-junction cracks). Samples are the near lattice
  where a candidate tile has one (lakes flattened, piers raised), else the DEM (Marin, the
  Peninsula, the island tip). A cell whose corners are all water is drawn when land lies on its
  sides (a sliver of shore). Colours by ground class. 104,480 terrain triangles.
* **Tall records** (30 m or more): their own outline, simplified (the convex hull only when the
  footprint is close to convex) and taking more vertices until it stands over no other record's
  interior point of a different height; flat roof at `topY`.
* **Everything else (W-41):** records closer than 6 m whose heights above the ground differ by
  at most 5 m merge, as long as the cluster's roofs span at most 8 m; a cluster becomes its
  convex hull, or its members' own outlines where that hull would stand over another record
  whose roof differs by more than 5 m from the hull's there. At each hull vertex the roof is the
  roof of the member nearest it (a stepped row on a hill slopes from roof to roof). A record
  alone keeps its own flat roof, and a record over a tall record's interior point is never
  clustered.
* Every hull is pushed out 0.1 m (never over another record's interior point), so the cell's
  1/16 m position grid leaves no record outside its roof. Walls start 3 m below the lowest
  ground under a hull. No normals; vertex colours from the largest member's palette; quantised
  and meshopt-compressed like the tiles.

Result: 26 cells, **588,718 triangles, 7.77 MB**. Against the near records: every record is
under a hull; every record 30 m or taller is within 3 m of its hull's roof at its interior
point; the rest are within 5 m at p99 (`tests/pipeline/far-hulls.test.ts`). The layer is drawn
only where no streamed tile is (the renderer's tile mask).

## World edge and shore (`boundary.json`)

`pipeline/lib/boundary.ts`, `schemas/boundary.schema.json`. What the sim needs at the edge
of the world, on the global 10 m ground lattice (so it is a pure function of the tiles):

* **`edges`**: the outline of the built tiles, built tiles on the left of travel (+x east,
  +z south), split into runs by what lies under it. **`land`** runs (17.6 km) are where the
  world stops on dry ground: along the county line inside the last built row (cell by cell,
  round the road pockets: W-42) and that row's south edge at the southern city limit (Daly
  City, Brisbane), where a built tile meets Alcatraz, Marin or the Ocean Beach strip. Beyond them
  there is no ground (the sim's ground is 0 outside the tiles, a 100 m drop at the city
  limit), so **the sim must wall them off**. **`water`** runs (61.1 km) are where the
  outline crosses open water: the sea wall and the towing rule cover them.
* **`shore`**: the land/water line inside the built tiles (marching squares over the
  heightfields' water flags, saddles keeping land connected, Douglas–Peucker at 2.5 m),
  land on the left of travel. The pier decks are land (raised by `piers.ts`, see [Streets,
  hills and structures](#streets-hills-and-structures-world-qa-2026-10-21)), so it runs round
  them. It is the line for the design's **sea-wall collider** and the
  **Bay-edge refill zone** (refill within a few metres of it, on the land side). Open lines
  end at the edge of the built tiles. **The inland lakes are water here too** (W-11): the
  marching squares run over sea or lake samples, and each lake's outline is a closed line
  tagged `lake` (its id, as in the colliders' `ground.lakes`), so the sim's existing shore walls
  stop a car at the bank of Lake Merced, Stow Lake and the rest as they do at the Bay, and a
  path that crosses a lake on a bridge gets a corridor. 30 lake rings, 23.8 km. A lake whose
  water meets the sea's (the Crissy Field marsh, the India Basin pond) is inside the sea's line.
* `seaLevelY`: 0.

84 KB. Not emitted yet: deck profiles for the bridges and the Bay Bridge (wave 3 and 8).

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

**After the world QA's second half (2026-10-22), open:**

* **Sim (Sim-World): lakes.** The pack's `LAKE` section (`ground.lake` in `src/sim/pack.ts`)
  marks inland-lake samples; treat them as the Bay is treated (walls or the tow rule), so a car
  cannot drive across Lake Merced (W-11). No SimState change.
* **Render (Render-World): ground cover and the house kit.** The ground's `COLOR_0` is by
  class already; the foliage nodes are standard `EXT_mesh_gpu_instancing` (three.js's
  GLTFLoader builds `InstancedMesh`es). The facade shader can branch on `_FACADE.w` (party walls
  blank, rear walls fewer windows) and lay garage doors, shop glazing and door rectangles from
  `extras.fronts`; the assets' house kit (`assets/blender/runtime/house-kit.ts`) places bays,
  stoops and cornices from the same rows. The far layer's stitches at the city's outer edge
  are no longer needed: the far terrain shares the near border.

**After the world QA passes (2026-10-21), still open:**

* **Sim (Sim-World): decks and tunnels.** `surfaceHeight(x, z, yHint)` must read the pack's
  `DECK` and `TUNL` sections (`src/sim/pack.ts` decodes them): the highest surface at or below
  the body among the ground, the decks under it and, in a bore, the bore's floor with its
  ceiling capping the body. `pipeline/lib/surfaces.ts` is the reference, tested on the sf pack
  (`tests/pipeline/surfaces.test.ts`). Until then cars drive the freeways on the ground under
  their decks and drive over Russian Hill instead of through the Broadway Tunnel. The Lefty
  O'Doul bascule's angle (`MOVE`) is sim state. Buildings with `underY` (spans over streets,
  houses over bores) pass bodies under them (qa/sim, SIM_VERSION 3).
* **Sim (Sim-World, Sim-Agents): stairs.** `stairs` edges are pedestrian: never route a car
  onto them.
* **Render (Render-World):** the `structures` node (deck sides, undersides, columns) keeps its
  vertex colours; junction polygons carry TEXCOORD_0 (0.25, 0), which the road shader already
  draws as plain asphalt; draped ribbons sit 2 cm over the ground mesh (no polygon offset
  needed so far); tunnel portals are not drawn yet, and a bore's road lies under the hill's
  ground mesh.

**Earlier notes:**

Status 2026-10-21 (city-runtime integration, `integrate/wave1`): the sim boot, renderer boot,
far-LOD, water and world-edge items below are **done**: `src/sim/pack.ts` decodes the pack,
`groundHeight()` looks tiles up by index, `src/io/world-load.ts` loads the pack, road graph
and boundary for the game, the browser sim lab and Node alike (no collider JSON is fetched),
`src/render/far-layer.ts` draws the far cells wherever no streamed tile is in the scene (the
outside tiles included), the camera sees 20 km, the sea is drawn at `water.y` to the far
plane, and `src/sim/boundary.ts` walls the land edges, the outline and the shore (with gaps
where surface roads cross it). Walkers do not use `sidewalks.json` yet. The original notes:

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
| 581 × `t*.glb` (quantised + meshopt) | 148.41 MB (largest 0.77 MB, `t-4_-1`; budget 150 MB) |
| 581 × `t*.collider.json` | 97.34 MB (largest 0.57 MB; budget 100 MB) |
| `world.colliders.bin` | 14.75 MB (budget 15 MB) |
| `sidewalks.json` | 10.54 MB |
| 26 × `f*.glb` (far-LOD) | 7.76 MB |
| `roads.json` | 4.63 MB |
| `street-cleaning.json` | 3.73 MB |
| `storefronts.json` | 1.52 MB |
| `parking.json` | 1.25 MB |
| `muni.json` | 0.66 MB |
| `hydrants.json`, `districts.json`, `signals.json`, `fountains.json`, `boundary.json` | 0.73 MB |
| `manifest.json` + `report.json` | 0.26 MB |
| **Total (the whole city, 1,202 files)** | **291.61 MB** (291,613,740 bytes; budget 300 MB) |

The world QA's ground cover, foliage and house data (2026-10-22) added about 20 MB to the tile
glbs and 3 MB to the collider JSON; the Daly City strip's move to scenery (W-42) gave back
0.9 MB of collider JSON and 0.15 MB of pack. Three budgets are still close: the tile glbs
(1.59 MB left), the collider JSON (2.66 MB) and the collider pack (0.25 MB), so the next
per-tile or per-record addition needs room made first. A regeneration peaks at 5.0 GB of resident memory
(`--max-old-space-size=8192`).

Budgets live in `tests/pipeline/budgets.json` and `tests/pipeline/budgets.test.ts` enforces
them: each tile glb and each collider JSON ≤ 1.5 MB, all tile glbs ≤ 150 MB, all collider
JSON ≤ 100 MB, the boot collider pack ≤ 15 MB, far-LOD ≤ 40 cells, 600k triangles and 15 MB,
each data layer ≤ 15 MB, the world ≤ 300 MB. (Wave 1's 40 MB budget covered the 77-tile
M0 + M1 world, 34.62 MB; it is superseded.)

## Determinism

Inputs are sorted by source id, coordinates are rounded to cm, JSON is written with a fixed
key order (one building, node, edge or record per line, so data changes diff as line
changes), meshopt encoding is deterministic, and there are no timestamps. `--check`
rebuilds from cache and compares every byte (all 1,202 files byte-identical on
2026-10-22).

**Rebuilds belong in one commit.** The world is about 269 MB of committed files and a
rebuild rewrites most of them, so every commit that rebuilds the world adds a full copy to
the history. Squash a branch's data rebuilds into one commit (or squash-merge it) so each
version of the world lands once. `tests/pipeline/build-fixture.test.ts` builds a synthetic world twice, in
memory, and compares SHA-256 of every file.

## Known limitations

* **The LiDAR is from 2010, the footprints from 2016.** Buildings finished since then get
  assessor-storey heights, which are approximate (2,410 buildings), or an override; buildings the
  footprint layer lacks get their lot's outline (197) or an override's (4), at storeys × a storey
  height: a lot outline is the building's envelope, not its plan. Buildings that replaced a
  different 2010 building on the same footprint keep the old height unless an override says so.
* **Two-tier massing is a model.** The tower is centred on the podium's centroid; the real
  tower may sit at a corner. The tower test reads summary statistics, not the point cloud,
  so a real but very slender tower (a church spire under 25 m²) becomes part of its roof,
  and a bleed wide enough to pass (≥ 25 m² and ≤ 10:1) can still make a tower unless the
  assessor contradicts it. The spike check removed one real tower among the probes,
  **Mission Dolores Basilica**'s 39 m bell tower over a 14 m nave with one assessor storey;
  a `keepTower` override now keeps it, but as the model draws every tower, centred on the
  footprint, not on the facade where the real towers stand. How many other steeples the
  check removed is bounded, not known: 24 of the 73 spike drops sit on the `COMM`, `MISC`
  and `GOVT` use codes under which churches and civic buildings are filed (see LiDAR spikes
  above). Landmarks should be replaced by hand-made models.
* **Assessor storeys are corrected, not verified.** The plausibility band drops the
  contradictions; a wrong count inside the band survives.
* **Sutro Tower is missing.** The LiDAR fills its upper structure's outline (683 m²,
  median 210 m, max 286 m), which made one block at 231 m and columns at 228 m and 225 m
  (a 16 m² one). Placeholder overrides now make those three records 3 m plinths with no
  storeys or use, so Sutro crest shows only the plinths and the equipment buildings: the
  city's most visible skyline landmark is absent until a landmark model replaces all six
  records listed under the `sutro-tower` probe (an Assets task). `content/landmarks.json`
  has no Sutro entry yet. Removing the three overrides brings back the solid blocks if a
  crude silhouette is preferred to none in the meantime.
* **Freeway and bridge decks are modelled, not surveyed.** The source has no deck heights;
  `decks.ts` derives them from the streets they cross, the ground and the grade and crest
  limits, so a viaduct's height is the least that clears what is under it, not the real
  one, and a grade separation is classified from the DEM's dips and humps. Where the source
  contradicts itself (a street crossing a ramp a few metres from the ramp's foot and a
  junction) the crossing is left as it is and listed (`decks.unresolvedCrossings`); one ramp
  (the Sterling St on-ramp to the Bay Bridge, 29 m long in the source) runs a straight 27.5%
  grade. The Bay Bridge and the Golden Gate Bridge are absent (Assets, W-24); their
  approaches hold their bank height over the water. Treasure Island and Yerba Buena Island
  are built, but no road joins them to the city (wave 8: the Bay Bridge deck); the island's
  tunnel has its two decks side by side, not stacked.
* **Freeway tunnels follow the DEM and the source's centrelines.** The Presidio Parkway was
  rebuilt (2012–2015) on new alignments: the Battery tunnel is bored northbound and the Main
  Post tunnel southbound, where the DEM's hill stands over the line; the other direction's
  hill is too shallow (under 3 m of cover) and runs over it.
* **The collider pack is 0.25 MB under its budget** (14.75 of 15 MB raw). The static web build
  splits any encoded file over 14 MB into parts (`scripts/build-web.ts`), so the host's 15 MB
  file limit is not the constraint; the pipeline budget is.
* **Lakes are flat water, not basins.** A lake is its outline flattened to its level (up to
  2.5 m of bank cut away); there is no lake bed. The sim keeps cars off a lake by its shore
  ring in `boundary.json` (walls, as at the Bay); it does not read the `LAKE` samples
  themselves yet (swimming, towing and refill at a lake are Sim-World's).
* **House data is data.** The wall classes, storeys and fronts are in the glbs; the shader
  branches (party walls blank, garage doors, shopfront glazing) and the instanced bays, stoops
  and cornices are the renderer's and the assets' (house kit K1–K8). Pitched roofs (K8) are not
  modelled: roofs stay flat at the LiDAR ridge.
* **No 2 m road profile (W-31).** The road surface is the 10 m lattice (drawn exactly as the
  sim drives it); the 1 m DEM that a 2 m road-profile pass needs is not among the cached
  inputs.
* **No quay faces (W-35).** The shore is the lattice's land/water line: land slopes into the
  water across a 10 m cell; no seawall face is drawn.
* **Pier decks are flat land at 3 m** (`piers.ts`): the bare-earth DEM has none, and no
  Port of SF pier outline is used. The deck is the sheds' and pier streets' buffered union on
  the 10 m lattice, so its edge is a 10 m slope into the bay, not a quay face. Small
  structures over water (houseboats, wharf stalls, shipyard cranes: 61) stand at sea level.
* **Sidewalks are procedural.** No sidewalk lies on a road, so a median too narrow for one
  has none, and a median wide enough keeps its inner sidewalks. Where a sidewalk is cut
  next to another road (an acute wedge between two streets, a slip lane alongside) its
  piece ends in a dead end rather than a link; very short edges can make corners overshoot
  (clamped at 3 offsets). Freeways have no deck height yet, so a street under an elevated
  freeway is cut and bridged by a crossing as if the freeway were at grade. Hydrants are
  procedural.
* **Far-LOD clusters are convex** where that stands over no record of a different height, so a
  block cluster's hull covers its back yards.
* **Some thin LiDAR towers remain:** 53 under 60 m² over a low podium, all under 54 m
  (steeples, rooftop structures, and spikes the data cannot tell from them). Towers of
  60 m² and more are kept when the moment model accepts them. A tree mask (DataSF *Urban Tree
  Canopy* `ni2e-vpbg`) would catch the remaining tree-made ones.
* **The world's edge:** footprints and roads that straddle the outermost tiles extend past
  the last heightfield. The sim's ground outside the tiles is 0; `boundary.json` gives the
  land runs to wall off. The southern wall follows the 500 m tile grid, up to 500 m south of
  the real city limit.
* `report.json` and the tests live with the data. `tests/schemas/schemas.test.ts` (harness)
  also validates every sf file against the schemas.
* **The roads and collider schemas are closed.** `roads.json`, its nodes and edges, and a
  collider, its buildings and its ground reject any key the schema does not declare
  (building `meta` stays open: dev-city uses `zone` and `kind`). A track that adds a field
  declares it in `schemas/` in the same change. A key starting with `x-` is accepted at
  every closed level, for experiments; it is never a contract, and the pipeline writes none.

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
  * Sutro Tower's six probe records are under 20 m (three are override plinths); the
    placeholder plinths carry no storeys, use or units, while 415 Mission St keeps its 63
    storeys; Mission Dolores keeps its bell tower, the one `keepTower` override, and every
    spike drop is attributed to a use code;
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
  byte for byte, through both readers; its ground lookup equals the sim's; escapes, negative
  coordinates, parts, towers, the extension block and the `LAKE` section; refusals and a
  corrupt file.
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
  rule, overrides (a placeholder plinth without the parcel's storeys and use, `keepTower`
  keeping a spike tower and failing the build when no tower results, `checkOverrides` on
  malformed entries and on `pipeline/overrides.json`), footY on a slope, water, seams,
  storefront filtering and privacy, and GLB validity.
* The world QA passes, on the committed world (each fails on the world before them):
  `shared-walls.test.ts` (W-36: no touching pair cracked in the audit boxes, fewer cracks
  than the source), `rings.test.ts` (W-30: simple rings, towers inside their podiums),
  `grounding.test.ts` (W-05, W-28: relief under a roof, the downhill/uphill wall ratio),
  `carriageway-clearance.test.ts` (W-01, W-39, W-43: no blocking footprint within a car's
  half width of a drivable centreline or a walker's reach of a path; spans pass under),
  `landmark-records.test.ts` (W-16: no phantom tower on a street), `stairs.test.ts` (W-33),
  `tunnels.test.ts` (W-02: the named tunnels' bores, straight, under their hills, nothing in
  them), `piers.test.ts` (W-13), `freeway-decks.test.ts` (W-03, W-07: decks 5 m over the
  streets they cross, at most 6% (8% on a ramp), no crest under 150 m, 3 m over the creeks,
  no freeway through a building, the freeway tunnels bored), `bridges.test.ts` (W-12),
  `grade-separations.test.ts` (W-14: launching crests round crossings at most half the bare
  DEM's, the report's named crossings never worse and 40% better together, Richland Ave
  smooth, every overpass 5 m over the road under it), `ribbon-ground.test.ts` (W-09, W-10:
  the drawn ribbons against the ground mesh) and `surfaces.test.ts` (the reference lookup on
  decks and in the Broadway Tunnel).
* The world QA's second half (2026-10-22), on the committed world: `ground-cover.test.ts`
  (W-18, W-34: every sample classed, 90% of Rec and Park land green and no property under
  10%, 90% of the four beaches sand, trees in every listed park and never in a building or on
  a road), `inland-water.test.ts` (W-11: 90% of each lake's outline water at its level, the
  measured levels, no flattened basin left dry, the pack's `LAKE` mask equal to the JSON's,
  lakes drawn as water), `completeness.test.ts` (W-04: at most 10 post-2015 parcels without a
  record and no cluster of 3, the Shipyard hilltop and Mission Rock, published heights within
  10%), `far-ring.test.ts` (W-17, W-40: near against far every 5 m along every built tile's
  border, the bare south-edge and island tiles covered, the outside ring complete, San Bruno
  Mountain), `far-hulls.test.ts` (W-41: every record under a hull, tall ones within 3 m, the
  rest within 5 m at p99), `facade-storeys.test.ts` (W-15, W-29: storeys under 5 m, the
  garage storey, the grid at the sidewalk) and `house-kit.test.ts` (W-46 to W-50 data: wall
  classes, 30th Ave's fronts and garage doors, Liberty St's bays, stoops, storefront walls,
  the facade grouping). `citywide.test.ts` also checks the Daly City strip: scenery past the
  county-line wall, drawn by the row-19 glbs, the outline's county-line runs (W-42).
  `network.test.ts` (W-42, the report's acceptance test): every built tile with buildings has a
  drivable street or is on the named list of 13 pier-end and shoreline tiles, and every solid
  strip record reaches a road's pocket. `inland-water.test.ts` also checks every lake's tagged
  ring in `boundary.json` and drives a sim car at South Lake Merced from both banks: it stops
  at the shore (the QA's C4 drive went 625 m across the water).
* `tower-rule.test.ts`: the tower rule on real DataSF statistics: the 600 Montgomery
  pyramid, the Ferry Building clock tower, Coit Tower, the Russ Building and an office slab
  keep their towers; five measured needles (including the review's four) do not.
* `geotiff.test.ts`: the TIFF reader against TIFFs built byte by byte.
