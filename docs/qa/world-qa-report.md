# Fog City world QA report: buildings, landscape and hills

> **Evidence files.** The scripts, outputs and screenshots this document names (paths such as `critic/c2-drive-all.mjs`, `synth/h1-head-sim.mjs` or `houses/shots/h03-sunset-30th.png`) lived in the QA run's scratch space (`qa-world/`, outside the repository) and are not committed. The numbers quoted from them are the record; the gate (`world-continuity-gate.md`) re-measures them in the repository's own tests.

**Requirement.** "The QA needs to ensure that the houses and landscape are feature complete with hills and everything that's very important to the continuity of the game."

**Builds.**
- Six audits and their adversarial verifications measured 7dbb362 (integrate/citywide, the whole-city world).
- The completeness critic, and the QA lead's own rechecks, measured head 54ee728 of integrate/wave1. Head adds:
  - the walls from `boundary.json`;
  - a sim booted from the collider pack;
  - the far skyline;
  - green parks;
  - car pitch and roll;
  - the Sutro placeholder and the condo tower rule.

Every defect below carries a status on head; how each status was decided is in `world-qa-status.md`.

**Paths.**
- Scripts, outputs and screenshots are relative to the QA run's scratch folder `qa-world/` (not committed; see the note above).
  - The audit folders are `buildings/`, `terrain/`, `streets/`, `visual/`, `houses/` and `play/`.
  - Their verifications are `verify-*/`.
  - The critic is `critic/` and the lead's head rechecks are `synth/`.
- Edge ids (`c…`) are `public/tiles/sf/roads.json` ids.
- Record ids (`201006.…`) are collider record ids.

**Severity.**
- **Blocker**: breaks continuity of play. Falling or driving out of the world, an impassable street or seam, a missing block, an invisible wall.
- **High**: obviously wrong to a player.
- **Medium**: noticeable on a normal drive.
- **Low**: polish.

Where verifications of merged findings disagreed, the majority severity was kept and the dissent is noted.

## Summary

| | Defects | Fixed on head | Partly fixed | Open on head |
|---|---|---|---|---|
| Blocker | 8 | 1 | 0 | 7 |
| High | 19 | 3 | 1 | 15 |
| Medium | 25 | 0 | 2 | 23 |
| Low | 15 | 0 | 1 | 14 |

There are 135 source defects:
- 90 audit findings.
- 34 items the verifiers found the auditors had missed (35 listed; one is a pass).
- 11 critic findings.

They consolidate into 52 blocker, high and medium defects (W-01 to W-52) and 15 low ones (L-01 to L-15). Duplicates across the six dimensions are merged, and each defect lists its source ids. No finding was refuted outright; eight sub-claims were (Appendix A).

The world is real San Francisco where it matters most:
- 175,595 footprints are in place, and none was lost by the pipeline.
- Summits are within 1 m of the DEM.
- The famous 31.5% blocks measure 31.7 to 31.9% and are drivable.
- Tile seams are exact, in both the sim and the render.
- The world edge is now walled.

What breaks continuity on head:
- **Streets walled by footprints.** 303 street edges cannot be driven end to end (W-01).
- **Tunnels and freeways on the bare ground.** They are draped over hills and through houses (W-02, W-03).
- **Missing blocks.** Post-2010 blocks are absent (W-04).
- **Buried hillside buildings.** They make invisible walls and teleport the car (W-05).
- **Two regressions from the new walls.** The water side of the shore walls launches cars hundreds of metres into the air (W-06), and I-280 dead-ends at invisible sea walls (W-07).

The landscape is not feature complete: no foliage, most parks grey, lakes as dry lawn, beaches grey, the bridges and Sutro Tower absent. The houses are boxes with 5 to 8 m storeys and no bay windows, garages, stoops or storefronts.

## How to read a defect

- **Merges**: the source finding ids.
- **Where**: lat/lon and district.
- **Evidence**: measured numbers, with the build named when it matters.
- **Shots**: screenshot paths.
- **Cause**: why it happens.
- **Fix**: what to change.
- **Test**: the acceptance test, also listed in `world-continuity-gate.md`.
- **Head**: the status on 54ee728.

---

# Blockers

## Pipeline

### W-01 Real streets are walled by building footprints: 303 edges (40.5 km) cannot be driven end to end

- **Merges:** BLD-01, PC-02, CR-04, buildings-M1, buildings-M4, play-M6. All verified as blockers.

- **Where:**
  - **Arterials:**
    - 1st St c105000, 37.78933,-122.39703 (Financial District). The Transit Center slab 201006.0000060 is 2.58 m tall, with a 68.1 m phantom tower on the street (W-16).
    - Howard St c7038000, 37.78379,-122.40203 (South of Market). The Moscone bridge 201006.0000802 is drawn as a solid wall from the ground.
    - Kearny St c7759000 (37.79502,-122.40490; 201006.0000664) and c7752000 (37.79034,-122.40375), Chinatown.
    - Upper Market St c8776102 and c8776203, 37.75631,-122.44108 (Twin Peaks). Houses sit on the centreline (201006.0021341).
  - **Collectors:**
    - Battery St c2757000 (37.79465,-122.40025).
    - Elk St c5152000 and c5153000, Glen Park: 15 houses on the line.
    - Mason St c19523000 and c19524000, and Lundeen St c19781000, in the Presidio (201006.0000173, 37.80476,-122.4491).
  - **Others:**
    - Houston St c7026000 (37.80385,-122.41636, North Beach).
    - Crescent Ave c4495000 and c4496000 (37.7346,-122.4144, Bernal Heights).
    - Winston Dr c13686101 and c13686201 (37.7270,-122.4779, Lakeshore; 201006.0000004).
    - Walnut St c15354000 (Presidio Heights).
    - Clipper Cove Ave (Treasure Island).
    - The Pier 70 streets 21st, 22nd, Maryland and Louisiana.
    - Mission alleys: Lilac, Poplar, Horace, Quane, Cypress and Osage.

- **Evidence:**
  - **Head (critic c2), every street driven.** Every non-pedestrian, non-freeway edge was driven in each allowed direction: 26,792 runs and 3,240 km, with the real `stepCar`, walls on, at the posted speed up to 20 m/s.
    - 98.2% of runs reach the end. 434 stop dead against a building and 58 start inside a footprint.
    - 303 edges have a blocked run, and 238 are blocked in every allowed direction (200 on the mainland, 38 on Treasure Island), across 31 districts.
    - 287 of the 303 have a blocking footprint within the car's half-width (0.95 m) of the centreline. The other 16 are corridors narrower than the car's swept path.
    - Fully blocked edges by district: North Beach 21, Mission 19, Financial District 19, Chinatown 18, Russian Hill 14, Nob Hill 11, Glen Park 10, Tenderloin 10, Presidio 9.
  - **7dbb362 (verify-buildings).**
    - Exact clipping finds 181 vehicular crossings deeper than 2 m: 110 edges, 161 buildings, 3,929 m.
    - The sim's own `boxBlocked` collides mid-edge on 319 vehicular edges (12,548 m).
  - **7dbb362 (verify-play), configuration-space test.**
    - 154 of 235 candidate edges are impassable within the street.
    - Still impassable with the corridor widened by 8 m: 1st St, Howard, Kearny c7759000, Upper Market c8776102, Battery, Elk c5152000, Houston and Crescent.
  - **Browser raycasts.**
    - 48.5 m of the 1st St centreline lies under the Transit Center slab (baseY 5.22, top 7.81).
    - 5.5 m of Howard lies under the Moscone bridge, drawn as a wall.

- **Shots:**
  - `buildings/shots/first-st-transit-center.png`
  - `play/shots/B-1st-st-transit-center-wall-chase.png`
  - `verify-play/r3/shots/B-1st-st-slab-street-fly.png`
  - `verify-play/r3/shots/C-howard-moscone-street-fly.png`

- **Cause:** four kinds of place.
  - Structures that span a street are extruded solid from the lowest ground under them (Transit Center, Moscone bridge, the Kearny and Battery structures). The sim's building test also ignores `baseY`: a building blocks whenever `y < topY`.
  - Footprints from 2010 meet 2025 centrelines where the land was redeveloped (Treasure Island, Pier 70, the Presidio).
  - Centrelines are misregistered 1 to 3 m into building fronts (Houston, Crescent, Elk, Upper Market, Kearny).
  - Alley corridors are narrower than the 1.9 x 4.6 m car's swept path.

- **Fix:**
  - **Pipeline:** a carriageway clearance pass.
    - Clip footprints out of each drivable corridor (centreline ± widthM/2).
    - Emit street-spanning structures with an underside at least 4.5 m above the road, not from the ground. This needs an additive collider field (`underY`); flag it as a contract change.
    - Re-register centrelines to the corridor's medial axis where the offset is under 3 m.
    - Drop 2010 footprints that a 2025 street crosses for more than 10 m when the parcel was rebuilt.
    - Mark edges whose free corridor is under 2.5 m as pedestrian.
    - Override the Transit Center as a deck at about 20 m over 1st and Fremont.
  - **Sim:** a building blocks a body only when the body's height range overlaps [underside, topY].

- **Test:**
  - Nightly `tests/sim/world/drive-every-street.test.ts` (the c2 harness, about 9 min): 0 stuck and 0 start-blocked runs on mainland edges.
  - Per PR `tests/pipeline/carriageway-clearance.test.ts`: no drivable centreline sample within 0.95 m of a footprint whose roof is more than 0.5 m above the ground and whose underside is below road + 4.5 m. A listed allow-list covers tunnels and decks.

- **Head: open.** `synth/q-c2.mjs` confirms each listed stop:
  - 1st St at 1/58 m.
  - Howard at 195/279 m.
  - Upper Market c8776102 at 12/132 m.
  - Elk c5152000 at 48/156 m and 8/156 m.

  Kearny c7751000 reaches its end.

### W-02 Tunnels are draped over the hills: the Broadway Tunnel is impassable

- **Merges:** BLD-02 and TER-01 (blockers); STR-04 and FC-VIS-07 (high); streets-M3, visual-M7 and buildings-M7.

- **Where:**
  - The Broadway Tunnel (Robert C Levy Tunl) c3186101 and c3186201. Its portals are at 37.79609,-122.42011 and 37.79742,-122.41026 (Russian Hill / Nob Hill / Chinatown).
  - Stockton Tunl c12225000, from 37.78943,-122.40696 to 37.79318,-122.40773.
  - The Toll Plaza Tunnel c19939000 (Presidio, 37.80729,-122.47533).
  - The MacArthur, Presidio Parkway and Yerba Buena Island tunnels are draped too; the MacArthur numbers were not reproduced.

- **Evidence (7dbb362):**
  - **Broadway:**
    - The ground rises 49.45 m above the portal-to-portal line, and the raw DEM rises 49.73 m: this is the bare-earth source.
    - The steepest 10 m grade is 46.7% eastbound and 59.9% westbound.
    - 417 m of centreline lies inside 31 footprints. Four of them are deeper than 2 m: 201006.0012041 (6.5 m), 0002781 (4.9 m), 0002492 (4.3 m) and 0073107 (3.3 m).
    - The edge is 882 m; the real bore is 493 m.
  - **Stockton:** rises 18.7 m with a steepest grade of 56.8% and no buildings on it. At full throttle the car is airborne 3.7 to 3.9 s cresting Nob Hill.
  - **Toll Plaza:** rises 3.95 m above its bore, with 16 m inside 2 footprints.

- **Shots:**
  - `buildings/shots/broadway-tunnel-west.png`
  - `verify-buildings/shots/v-broadway-west-approach.png`
  - `terrain/tunnels-profile.png`
  - `streets/shots/04-broadway-tunnel-over-russian-hill.png`
  - `streets/shots/15-broadway-tunnel-west-portal.png`
  - `verify-streets/shots/v04-broadway-tunnel-over-hill.png`
  - `visual/broadway-tunnel-street.png`
  - `visual/broadway-tunnel-aerial.png`

- **Cause:**
  - The 3DEP DEM is bare earth.
  - `roads.json` has no tunnel flag, and the collider schema has no tunnels.
  - Houses above the bore keep solid colliders.

- **Fix:**
  - **Pipeline:**
    - Flag tunnel edges by name (Tunl, Tunnel) plus a hand list: MacArthur, YBI, Presidio Parkway, Toll Plaza.
    - Trim each edge to its real portals.
    - Emit a tunnel ribbon on the straight portal-to-portal profile, with a ceiling. This is design.md's `tunnels` schema, an additive collider change; flag it.
    - Draw portals, and do not drape the tunnel on the surface.
  - **Sim:** `surfaceHeight(x, z, yHint)` follows the bore and skips buildings above the ceiling.

- **Test:**
  - `tests/sim/world/tunnels.test.ts`: both Broadway bores, Stockton and Toll Plaza, driven at 25 m/s: 0 hits, y within 1 m of the portal line, 0 airborne ticks.
  - `tests/pipeline/tunnels.test.ts`: every tunnel edge has a ribbon, and 0 m of tunnel centreline lies inside a footprint below the ceiling.

- **Head: open.**
  - c3186101 stops at 202/885 m on 201006.0012041, and c3186201 at 91/883 m on 0002781.
  - Stockton reaches the end both ways at posted speed, airborne 0.85 and 0.98 s, landing at 7.3 m/s.
  - Toll Plaza stops at 4/98 m.

### W-03 Freeways run on the bare ground: the player is stopped dead by buildings on I-80 and I-280, launched off viaducts, and drives through houses

- **Merges:**
  - BLD-06 (raised to blocker).
  - TER-07, STR-03 and FC-VIS-06 (high).
  - CR-11 (medium).
  - streets-M5 (robotaxis on freeways, fixed on head).

- **Where:**
  - I-80 WB and EB, c14249000 and c14248000, through 201006.0000040 at Rincon Point (37.789149,-122.387718).
  - I-280 NB and SB, c19298000 and c19342000, and ramp c19337000, in Dogpatch (37.7504 to 37.7523, -122.3912 to -122.3920; 201006.0002744, 0002399, 0003602 and others).
  - US-101 c19205000 and c19256000 through Fort Point 201006.0000856 and 0001323 (Presidio).
  - The Central Freeway at Mission and 13th (37.76975,-122.42001).
  - I-80 on Yerba Buena Island (37.80905,-122.36621).

- **Evidence:**
  - **7dbb362:**
    - 435 m of the 103.5 km of freeway and ramp centreline lies inside buildings, on 8 edges.
    - 20 buildings have at least 4 m² of drawn freeway under their roof (4,825 m²; 0000856 782 m², 0000040 755 m²).
    - Ground lies above the freeway ribbon on 10.0% of its area.
    - There are 274 at-grade crossings with surface streets, at 154 places.
    - Grades reach 141% over a 10 m window, and 6.96 km is steeper than 8%.
    - Full-world drives stop dead on I-80 WB after 5.75 s (against 0000040) and on I-280 NB at 37.750348,-122.391604 after 3.1 s (against 0002744).
  - **Head (critic c2 fwy):** 219 edges, 220 runs, 105 km at 20 m/s or less.
    - 6 runs stop on buildings (0002399, 0003602, 0000856 and YBI 0170087), and 5 at shore walls (W-07).
    - 62 runs are airborne 0.5 s or more, 36 rise 1 m or more, and 35 land at 5 m/s or more.
    - Worst: I-80 EB on YBI c14240000, 3.92 s and 16.2 m, landing at 17.4 m/s; Hwy 101 SB at Fort Point, 3.48 s and 12.8 m; I-80 WB, 3.18 s and 15.8 m.

- **Shots:**
  - `verify-buildings/shots/v-rincon-i80-0000040.png`
  - `verify-buildings/shots/v-dogpatch-i280.png`
  - `streets/shots/02-i80-soma-viaduct-draped.png`
  - `streets/shots/03-us101-central-fwy-at-mission.png`
  - `visual/central-freeway-101-street.png`
  - `visual/i280-dogpatch-aerial.png`
  - `visual/bay-bridge-i80-aerial.png`

- **Cause:** the source has no deck heights. `mesh.ts` and the sim drape freeways on the bare-earth DEM like streets, so viaducts follow every hill, cut and creek, and pass through the buildings under them.

- **Fix:**
  - **Pipeline:** freeway deck profiles, emitted as collider decks and ribbons. Each profile is smoothed, has a maximum grade of 6%, stands at least 5 m above every street it crosses, and clears the buildings under it.
  - **Sim:** `surfaceHeight` reads the decks.
  - **Until decks land:** close the freeway on-ramps to the player with a barrier at the ramp start, so the city reads as continuous on surface streets.

- **Test:**
  - `tests/pipeline/freeway-decks.test.ts`: 0 m of freeway or ramp centreline inside footprints, except on an allow-list; 0% of freeway ribbon area under the ground; the deck at least 5 m above every crossed street.
  - Nightly `tests/sim/world/drive-freeways.test.ts`: every freeway and ramp edge, driven at 25 m/s, reaches its end with no airborne interval over 0.3 s and no landing over 3 m/s.

- **Head: open.** The traffic part is fixed: `synth/h1` C7 finds 0 of 110 gradeSeparated edges open to robotaxis.

### W-04 Post-2010 blocks and towers are missing

- **Merges:**
  - BLD-03 (blocker; the rubric lists a missing block as a blocker).
  - BLD-04 (high, partly verified).
  - FC-VIS-10 (high; its verifier would rate the vacant lots high, since play continues).
  - visual-M6 and buildings-M8.

- **Where:**
  - The Hunters Point Shipyard hilltop, block 4591C, 37.727477,-122.369460 (Bayview Hunters Point): 59 parcel points, built 2017 to 2023.
  - Lakeshore block 7331, 37.715020,-122.475735: 40 of 78 points.
  - Mission Rock, block 8719, 37.77485,-122.38888 (Mission Bay): 0 records in a 7.3 ha box. Its 4 tower parcels are 8 to 23 storeys, built 2024.
  - Transbay: 33 Tehama (37.787260,-122.396264, 35 storeys); The Avery (37.787902,-122.394360, 188 m); 706 Mission (37.785971,-122.403220, 146 m roof).
  - Fifteen Fifty, 1550 Mission (37.77355,-122.41767): drawn at 15.6 m or less, against 116 to 122 m.
  - Chase Center (37.76797,-122.38750).
  - The new Treasure Island blocks.

- **Evidence:** at 7dbb362, 122 post-2015 parcel points with storeys have no footprint within 25 m (verify-buildings). At 15 m the count is 197 points, 2,792 units. The Mission Rock box holds only 6 low 2010 parking structures, correctly dropped. The source simply has no newer footprints.

- **Shots:**
  - `verify-buildings/shots/v-mission-rock.png`
  - `visual/bayview-hunters-point-aerial.png`
  - `visual/mission-bay-3rd-bridge-aerial.png`

- **Cause:** the DataSF footprint layer is a 2016 snapshot measured by 2010 LiDAR. The pipeline has no second outline source, and overrides cannot add footprints.

- **Fix:**
  - A newer-buildings pass: for 2025-roll parcels built in 2010 or later that have storeys and no footprint within 15 m, take the parcel polygon, inset 1 to 2 m, at storeys × storey height.
  - Let overrides add and replace footprints and retire a predecessor record.
  - Hand-author Mission Rock, the Transbay towers and Chase Center, with heights from public records.
  - Licence-check any other outline source (OSM and Microsoft are ODbL).

- **Test:** `tests/pipeline/completeness.test.ts`:
  - At most 10 post-2015 parcel points with storeys and no record within 25 m, and no 100 m cell with 3 or more.
  - The Mission Rock box holds at least 4 records of 40 m or more.
  - The Avery, 706 Mission, 33 Tehama and Fifteen Fifty are within ±10% of their published heights.

- **Head: open.**
  - h0: 0 footprints added at head.
  - h1 B, tallest record within 30 m of each point: The Avery 72.6 m; 33 Tehama 47.2 m; Fifteen Fifty's record 14.6 m. 706 Mission's parcel point lies in no record.
  - Park Tower is present at 173.7 m; the claim that it was missing is refuted.
  - Head's condo rule restored One Rincon Hill (182 m) and the Four Seasons (130 m), which are pre-2010 towers.

### W-05 Buried hillside buildings: invisible underground walls, the car teleported 11 to 23 m, the hill showing through roofs

- **Merges:** HOUSES-01 (blocker), houses-M1 (blocker), BLD-05 (high) and FC-VIS-13 (low).

- **Where:**
  - 201006.0000980, Russian Hill, 37.79996,-122.41631.
  - 0000592, West of Twin Peaks, 37.72663,-122.44925.
  - 0000837, Nob Hill, 37.79429,-122.41175.
  - 0001096, Outer Mission, 37.72165,-122.44749.
  - 0000706, Nob Hill, 37.79224,-122.41340.
  - 0000116, Mission, 37.76522,-122.40601.
  - 0009459, Bayview, 37.75049,-122.40090.
  - Castro: 0010129, 0010415 and 0009973, about 37.7573,-122.4467.

- **Evidence:**
  - **Roofs under ground (7dbb362).**
    - 18 records have ground above the roof inside the footprint: 10 by more than 1 m, 6 by more than 2 m, with 5,449 m² of roof under the ground.
    - 0000980 has ground 10.66 m above its roof, and 1,037 of its 2,331 m² of roof is under the ground.
    - 269 records stand less than 2 m above the highest ground; 79 of them are 4 m or taller.
    - 30 buildings have 1,121 m of wall whose drawn height is 0.3 m or less; 244 m of it is within 3 m of a sidewalk.
  - **Walker:** 5 of 5 walkers stop outside the footprint at an underground wall.
  - **Car:**
    - The car drives onto the buried part, because the collider skips a building while `y >= topY`.
    - When its y drops below the roof inside the polygon, it is pushed out in one tick: 23.49 m at 0000592 (at 20.7 m/s) and 11.18 m at 0000116.

- **Shots:**
  - `houses/shots/h15-hill-through-roof.png`
  - `houses/shots/x05-hill-roof-castro.png`
  - `houses/shots/x08-walker-view-mission.png`
  - `houses/shots/x08-walker-view-russian.png`
  - `buildings/shots/r2-980-roof-under-ground.png`
  - `buildings/shots/r2-837-roof-under-ground.png`
  - `verify-houses/shots/v01-eye-0592.png`
  - `verify-houses/shots/v01-air-0592.png`
  - `verify-buildings/shots/v-r980-topdown.png`

- **Cause:**
  - The pipeline builds one flat prism per footprint, at the median ground plus the LiDAR height, over 8 to 30 m of relief.
  - The walker collides with every footprint at any height.
  - The car ignores a building while above its roof, then resolves the full penetration in one tick.

- **Fix:**
  - **Pipeline:** terrace footprints with more than 6 m of relief into strips of 4 m relief or less, each with its own base and roof (shared with W-28). At minimum, keep `topY >= max ground + 2.5 m`, or clip the buried part.
  - **Sim:** the walker skips a building when its y is at least `topY - 0.3 m`, as the car does. Cap the per-tick push-out (shared with W-06, W-23 and W-51).

- **Test:**
  - Per PR `tests/pipeline/grounding.test.ts`: 0 records with the ground above the roof anywhere in the footprint (1 m raster), and 0 records of 4 m or taller standing less than 2 m above their highest ground.
  - `tests/sim/world/buried-buildings.test.ts`: a car and a walker at each of the 30 sites. No tick moves a body more than speed·DT + 0.5 m, and a walker either crosses or stops at a wall at least 2.5 m tall.

- **Head: open.** `synth/h1`:
  - B: the ground over the roof is 10.66, 5.46 and 4.64 m, unchanged.
  - C1: the teleports are 23.49 m and 11.18 m, identical with the full `step()` and walls on.
  - C6: the walker at 0000592 is held 308 ticks outside the footprint while standing above the roof's level.

## Sim

### W-06 The water side of every shore wall launches cars 50 to 1,612 m into the sky (new on head)

- **Merges:** CR-02.

- **Where:**
  - The code: `src/sim/collide.ts` `boxWallPush` (each pass pushes up to `WALL_DEPTH_M` = 3 m, 4 passes, inside up to 6 car substeps), and `src/sim/car.ts`, which sets `vy = (g1.h - g0.h) / DT`.
  - Entry points through the road gaps:
    - The 4th St bridge, 37.77483,-122.39233 (Mission Bay).
    - The I-280 ramps, 37.77055,-122.39783.
    - 3rd St over Islais Creek, 37.74714,-122.38749.
  - Worst sweep sites:
    - Lands End, 37.78786,-122.50605.
    - Marina, 37.80735,-122.43067.
    - Outer Richmond, 37.78425,-122.51172.
    - Bayview, 37.75221,-122.37641.

- **Evidence (head, critic c1-launch-replay):**
  - **Replay:** a car runs at 30 m/s from dry land through the 4th St gap. At t=122 one tick moves it 8.0 m (expected 0.47 m), and vy goes from 3.64 to 101.84 m/s. It is 126 m up at t=200 and 261 m up at t=300. The browser game's `step()` matches to 0.000 m.
  - **Sweep:** every 50 m of shore, starting 2.5 m and 6 m on the water side, at 5, 15 and 30 m/s: 8,958 approaches.
    - 8,137 rise more than 2 m or stay airborne more than 1 s.
    - 5,376 rise more than 10 m, and 3,055 more than 50 m.
    - Worst peaks: 1,612 m at Lands End, 653 m at the Marina, 614 m in the Outer Richmond and 574 m in Bayview.

- **Shots:** `critic/shots/L-4th-st-gap-launch-head.png`.

- **Cause:**
  - The walls are one-sided and act on box points up to 3 m behind them. A body approaching from the water is dragged through the wall, up to 8 m in one tick.
  - `stepCar` then turns the ground change under that move into vertical speed.
  - This is the same family as W-23 and W-51.

- **Fix:**
  1. `stepCar` never derives vertical speed from a collision push: compute the ground rate from the intended move before the push, or clamp it to |v| · max slope + 1 m/s.
  2. A body behind a wall is pushed back to the side it came from, and the per-tick wall push is capped at speed·DT + 0.5 m.
  3. Close the gaps on the water side (W-21).

- **Test:**
  - `tests/sim/world/wall-launch.test.ts` reruns the sweep: no car rises more than 1 m above the ground, and no tick moves a car more than speed·DT + 0.5 m.
  - A unit test in `tests/sim/`: a box pushed sideways onto a 3 m bank gains no upward vy.

- **Head: open, new.**

### W-07 I-280 ends in invisible sea walls at Mission Creek and Islais Creek (new on head)

- **Merges:** CR-01.

- **Where:**
  - Mission Creek: I-280 NB c19300000 stops at 37.77093,-122.39733, and SB c19338000 at 37.77055,-122.39846.
  - Islais Creek: NB c19298000 stops at 37.74762,-122.39307.
  - The code: `src/sim/boundary.ts` `roadSegments()` skips gradeSeparated edges, so `gapsFor()` cuts no gap for freeways.

- **Evidence (head):**
  - **Static:** 9 freeway edges cross an uncut wall: these three, plus I-80 at the Bay Bridge shore and on YBI, and Hwy 101 at Fort Point.
  - **Drives:** at 20 to 25 m/s the car stops dead at each I-280 crossing, at 0.0017 m/s after 4.5 s, with no building in the car box.
    - Because the freeway is draped into the creek (W-03), the ground at the wall is 0 to 0.67 m.
    - The ramps beside it (c19330000, c19288000) did get gaps, so the ramps open onto the creek while the mainline is walled.
  - **Browser:** a replay ends at the identical point.

- **Shots:**
  - `critic/shots/W-i280-mission-creek-wall-street-head.png`
  - `critic/shots/W-i280-mission-creek-wall-chase-head.png`

- **Cause:** walls cut gaps only for surface roads, and the draped freeway crosses the shore line.

- **Fix:**
  - **Now:** cut gaps for gradeSeparated edges whose two endpoints are on land. Keep the walls only where a freeway runs out to open water: the Bay Bridge and the Golden Gate, where the bridges are not modelled (W-24).
  - **Then:** deck profiles for I-280 over both creeks (W-03).

- **Test:** `tests/sim/world/freeway-continuity.test.ts`:
  - I-280 NB from Alemany to King St, and SB back, at 25 m/s: both reach the end with 0 wall contacts.
  - No gradeSeparated edge with both endpoints on land crosses a wall segment.

- **Head: open, new.** `synth/q-c2.mjs`: c19300000 stops at 280/831 m, c19298000 at 613/1653 m and c19338000 at 561/697 m.

### W-08 No world edge: cars and walkers leave the world, a 181 to 201 m drop at the county line, open water a drivable floor (FIXED on head)

- **Merges:**
  - PC-01, TER-02, STR-01 and FC-VIS-01 (all blockers).
  - terrain-M1, visual-M2 and buildings-M5.

- **Where:**
  - The southern land edge at z = 10000 to 10500; the worst point is 37.70540,-122.43701, with ground at 201.4 m.
  - Every shore.

- **Evidence (7dbb362):**
  - 12 of 12 southbound cars fell 197 to 201 m to y=0, and the walker dropped 181.41 m in one tick.
  - From Marina Green a car drove 3,321 m across the Bay.
  - North from Crissy Field the car reached z = -2034 after 40 s, still at 28.6 m/s.
  - 26 built-tile borders drop at least 1 m to zero ground; 5,280 m of border drops 50 m or more.

- **Shots:**
  - `play/shots/E-south-world-edge-fall-chase.png`
  - `verify-play/r3/shots/F-county-line-cliff-fly.png`
  - `visual/south-edge-aerial.png`
  - `streets/shots/12-south-edge-from-above.png`

- **Fix (landed in c231878):** walls are built from the land edges and shore of `boundary.json`.

- **Test (kept in the gate):** `tests/sim/world/world-edge.test.ts` rams every wall every 100 m, as a car at 30 m/s at 0/±30/±60° and as a sprinting walker. 0 crossings, 0 bodies outside the built tiles.

- **Head: fixed.** In 6,064 ram tests from 758 dry starts along all 152 km of walls, 0 crossed a real wall (critic c1-walls-cross). The residual escapes go through the 22 road gaps, tracked as W-21; their launch side effect is W-06.

---

# High

## Pipeline

### W-09 The car sinks into the drawn road: the ribbon and the sim ground disagree

- **Merges:** TER-05, PC-05, FC-VIS-02 (high); buildings-M2; terrain-M3 (medium, the constant 0.15 m).

- **Where:** citywide. The worst places:
  - Kearny St c7774000, 37.80469,-122.40622 (Telegraph Hill): the ribbon is 3.98 m above the sim.
  - Point Lobos Ave, 37.77720,-122.51249 (Outer Richmond): the car is 3.10 m under the drawn road.
  - San Jose Av On Ramp, 37.73216,-122.43504: -3.38 m.
  - Twin Peaks Blvd, 37.75495,-122.44774.

- **Evidence:**
  - **The car against the drawn road** (verify-play, 92,597 samples every 20 m of every street):
    - The car is more than 0.3 m under the road at 2.47% of samples, more than 0.5 m at 0.90% and more than 1 m at 0.12%.
    - It floats more than 0.3 m above the road at 1.06%.
    - Twin Peaks Blvd has 25.3% of its samples sunk more than 0.3 m, Great Hwy 6.4% and 19th Ave 4.2%.
    - In the live game on Twin Peaks Blvd the road is at 253.08 m and the car at 251.61 m: all four wheel bottoms are 1.25 to 1.70 m below the road.
    - On flat streets the wheels sit 0.13 to 0.15 m under the road everywhere, because of `ROAD_LIFT_M`.
  - **The ribbon against the sim ground** (verify-terrain, by area):
    - p50 +0.159, p99 +0.538, extremes -2.52 and +3.49 m.
    - Visible sink beyond 30 cm covers 1.6% (area) to 2.9% (centreline).
  - **Cause precision:** with the kerb mean 0.5 to 1 m above the centre, 97% of samples sink more than 0.3 m; with a bench under 0.2 m, only 0.19% do. So the driver is a concave cross-profile, not cross-slope as such.

- **Shots:**
  - `play/shots/C-twin-peaks-blvd-car-sunk-in-road-chase.png`
  - `verify-play/r3/shots/D-twin-peaks-blvd-car-vs-road-fly.png`
  - `visual/hill-closeup-040s.png`
  - `visual/hill-closeup-086s.png`
  - `streets/shots/01-car-wheel-closeup.png`
  - `verify-streets/shots/v01-tyres-side.png`

- **Cause:** `pipeline/lib/mesh.ts` `roadMeshes` drapes only the two kerbs, every 8 m or less, at the planar ground plus 0.15 m. The sim reads the bilinear lattice under the car's centre. The design's road-profile pass is not built.

- **Fix:**
  - One road surface for both sides: the 2 m road-profile pass of design.md, with a bounded cross-slope.
  - The sim's `surfaceHeight` reads it on the carriageway, and the ribbon is draped from it with no lift. Z-fighting is handled by polygon offset, or by lowering the ground under the road.
  - Until then, take ribbon heights from the sim's own function, at lattice density.

- **Test:** `tests/render/road-vs-sim.test.ts`: on every centreline and kerb-inset sample, |drawn road top - sim surface| ≤ 0.05 m. The browser tour shows whole wheels on Filbert, Twin Peaks Blvd and Kearny.

- **Head: open.** In critic scene E, with pitch now applied, all four wheel bottoms are 0.29 to 0.32 m under the drawn road on Filbert. `mesh.ts` and the terrain are unchanged.

### W-10 The ground mesh pokes through road ribbons

- **Merges:** STR-09 and FC-VIS-03.

- **Where:**
  - San Jose Ave ramps by I-280, 37.73216,-122.43505: 3.32 m.
  - Michigan St, 37.75883,-122.38642: 2.36 m.
  - Bay Shore Blvd, 37.71657,-122.39824: 1.89 m.
  - Cesar Chavez St: 1.65 m.
  - Market St at Twin Peaks, 37.75281,-122.44262: 1.33 m.
  - Telegraph Hill Blvd at Lombard.
  - I-80 on YBI.

- **Evidence (7dbb362):**
  - Ground lies above the ribbon on 2.31% of road area and 11.5% of freeway area (verify-streets).
  - By area: 1.58% over 5 cm, 0.85% over 15 cm, 0.17% over 0.5 m.
  - Freeways are about six times worse than streets.

- **Shots:**
  - `visual/telegraph-coit-street.png`
  - `visual/market-castro-aerial.png`
  - `visual/noe-22nd-aerial.png`
  - `visual/lombard-crooked-street-down.png`
  - `verify-visual/shots/michigan-poke-street.png`
  - `verify-visual/shots/michigan-poke-aerial.png`

- **Cause:** the ribbon quads have vertices only at the kerbs, at most 8 m apart. The 10 m ground triangles between them rise above the flat quad on crowns, crests and cuts.

- **Fix:**
  - Cut road footprints into the ground mesh, or lower the ground under each ribbon to the ribbon's height.
  - Both come from the W-09 road surface.

- **Test:** `tests/pipeline/ribbon-ground.test.ts`: on a 0.5 m grid over every ribbon, the ground is never more than 0.02 m above the ribbon top.

- **Head: open.** `mesh.ts`, the terrain and the roads are unchanged.

### W-11 Inland lakes are dry, drivable land, and head paints them as lawn

- **Merges:**
  - TER-04, STR-07 and FC-VIS-05.
  - streets-M1 and visual-M5.
  - The lake part of CR-06.

- **Where:**
  - Lake Merced: South Lake 37.71910,-122.49611 and North Lake 37.72784,-122.50133 (Lakeshore).
  - Stow Lake, 37.77018,-122.47738.
  - Spreckels Lake, 37.77144,-122.49532.
  - Pine Lake, 37.73631,-122.48953.
  - The Palace of Fine Arts lagoon, 37.80306,-122.44767.
  - The Crissy Field marsh, 37.8043,-122.4583.
  - Laguna Honda Reservoir, 37.75314,-122.46288.
  - Elk Glen Lake and the Chain of Lakes.
  - Mountain Lake, Lily Pond and Lloyd Lake are not flattened in the DEM, so they need outlines.

- **Evidence (7dbb362):**
  - **Lake Merced:** 90.4 ha within ±5 cm of 5.25 m, with no water flag.
  - **Other flattened lakes:**
    - Stow, 87.00 m, 2.17 ha.
    - Spreckels, 40.9 m, 1.76 ha.
    - Pine, 12.8 m, 0.99 ha.
    - The Palace lagoon, 1.40 m, 1.55 ha.
    - Laguna Honda, 112.2 m, 0.67 ha.
    - Elk Glen, 50.8 m, 0.61 ha.
  - **Flood fill:** 14 regions, 109.9 ha in all.

- **Shots:**
  - `terrain/lake-merced.png`
  - `streets/shots/07-lake-merced-as-land.png`
  - `streets/shots/14-lake-merced-close.png`
  - `visual/lake-merced-aerial.png`
  - `visual/lake-merced-street.png`
  - `verify-visual/shots/lake-merced-low.png`
  - Head: `critic/shots/P-stow-lake-aerial-head.png`

- **Cause:**
  - `terrain.ts` treats only samples below 0.1 m as water, and there is no inland-water source.
  - The renderer has one sea plane.
  - At head, `parks.ts` tints every park-district vertex at or above 1.5 m, lake surfaces included.

- **Fix:**
  - **Pipeline:** an inland-water layer, from USGS NHD waterbodies (public domain) or a named-lakes override list. Write water flags with a per-body surface level.
  - **Render:** draw each body at its level with the water shader, and never tint water as grass.
  - **Sim:** treat lakes like the Bay (walls or the tow rule).

- **Test:** `tests/pipeline/inland-water.test.ts`:
  - At least 90% of lattice samples inside each named lake's outline are water at its level.
  - No water sample carries a grass colour.
  - A sim drive into Lake Merced is stopped or towed.

- **Head: open, and worse.**
  - `synth/h1` C4: a car drives 625 m across South Lake at y 5.25 to 5.27 m, with 0 hits, at 28.1 m/s, identical to 7dbb362.
  - The Stow, Spreckels and Elk Glen surfaces (5.0 ha) are now tinted grass.

### W-12 The bridges over Mission Creek and Islais Creek dip to sea level

- **Merges:** TER-06 (high) and STR-02 (partly verified, lowered from blocker to high).

- **Where:**
  - 3rd St (Lefty O'Doul) c182000 and c183000, 37.77648,-122.39005.
  - 4th St c270002 and c271000, 37.77503,-122.39235 (Mission Bay).
  - 3rd St over Islais Creek c197101 and c197201, 37.74750,-122.38724.
  - Illinois St c15166000, 37.74699,-122.38618.

- **Evidence (7dbb362):**
  - **Length at exactly 0 m** (bank heights in brackets):
    - 3rd St over Mission Creek: 17 + 26 m (3.66 and 3.53 m).
    - 4th St: 19 + 11 m (3.39 and 3.49 m).
    - 3rd St over Islais Creek: 20 + 20 m (3.38 and 4.04 m).
    - Illinois St: 91 m (2.91 and 3.35 m).
  - **Drives at 15 m/s:**
    - 3rd St bottoms out at y=0.
    - 4th St stalls at 350 of 417 m after 1 hit.
    - Illinois St: 20 airborne ticks, 3 hits, stalls at 425 of 496 m.
    - Launches out of the channel (73 to 81 airborne ticks) happen only at full throttle.

- **Shots:**
  - `visual/mission-bay-3rd-bridge-street.png`
  - `visual/mission-bay-3rd-bridge-aerial.png`

- **Cause:** the bare-earth DEM has no decks. The edges carry a `bridge` flag that nothing uses.

- **Fix:** a linear deck between the bank heights for every non-freeway `bridge` edge, emitted as collider decks and as the drawn ribbon. The sim's `surfaceHeight` reads the deck.

- **Test:** `tests/sim/world/bridges.test.ts`: at 15 and 25 m/s over all four bridges, y never falls below the lower abutment minus 0.2 m, with 0 airborne ticks and no wheel over water. A pipeline test checks that every surface `bridge` edge has a deck.

- **Head: open.**
  - At posted speed the edges are drivable: 3rd St c197201 is airborne for 0.17 s.
  - At head these are the wall gaps, so the dip now leads out onto the water (W-21) and into the launch (W-06).

### W-13 Piers: sheds stand in the water, and pier roads lie at y = 0

- **Merges:**
  - BLD-07 and TER-03 (both partly verified; high).
  - STR-10 (high).
  - FC-VIS-09 (medium).
  - streets-M4.

- **Where:**
  - Mission Bay: 201006.0000016 at 37.77564,-122.38678 (16,884 m²); Pier 50, 0000020.
  - Pier 26, 0000040.
  - Pier 1, 0000146 at 37.79721,-122.39443.
  - Pier 39 sheds, 0030019.
  - Fisherman's Wharf: Al Scoma Way c15207000 and Pier 45 Vly c15356000.
  - Pier 50 Vly c15358000.
  - Pier 70, Unnamed 42 c12929000.

- **Evidence (7dbb362):**
  - **Buildings on water:** 95 buildings (141,359 m²) stand at least half over all-water render cells. Other tests find 78 to 109 buildings, depending on the water test. All but one have baseY 0.
  - **Pier-street length at y = 0:**
    - Al Scoma Way: 175 of 258 m.
    - Pier 45 Vly: 132 of 305 m.
    - Pier 50 Vly: 326 of 427 m.
    - Unnamed 42: 51 of 84 m.
  - **Inconsistent coverage:** Piers 15, 27, 39 and 70 sit on DEM land.
  - **Pier 50 Vly:** stopped by 201006.0000020, which covers its centreline. That is a W-01 overlap a deck would not fix.

- **Shots:**
  - `streets/shots/06-piers-1-to-9-on-water.png`
  - `streets/shots/13-pier45-road-on-water.png`
  - `visual/mission-bay-3rd-bridge-aerial.png`
  - `verify-visual/shots/pier50-aerial.png`

- **Cause:** the bare-earth DEM has no pier decks, and the water threshold turns pier cells into sea.

- **Fix:**
  - Pier deck polygons from the buffered union of the pier-shed footprints and pier street ribbons, or from Port of SF pier outlines, raised to deck height (about 3 m) as land or collider decks.
  - Pier buildings' footY and baseY move to the deck.
  - Correct the contradictory pier sentences in `docs/data-sources.md` (line 518 against line 713).

- **Test:** `tests/pipeline/piers.test.ts` and `tests/sim/world/piers.test.ts`:
  - 0 buildings at least 50% over water without a deck.
  - Drives along Al Scoma Way, Pier 45 Vly and Pier 50 Vly keep y at 2.5 m or more, with 0 hits.

- **Head: open.**
  - The data is unchanged, and Pier 50 Vly still stops at 398 of 429 m.
  - The walls now make the aprons unreachable except through the pier-road gaps (W-21).

### W-14 Streets that cross freeways, rail cuts and creeks launch the car (trenches and humps)

- **Merges:**
  - PC-04 (high).
  - play-M7 (Richland Ave).
  - TER-07's overpass dips.

- **Where:**
  - Richland Ave c11011002 over I-280: a trench about 15 m deep.
  - San Jose Ave over I-280, 37.73147,-122.43509.
  - Treasure Island Rd over I-80.
  - Paul Ave over US-101.
  - 23rd St over US-101, 37.75449,-122.40301 (6.5 m dip).
  - Geneva Ave over I-280, 37.72137,-122.44812 (5.3 m dip).

- **Evidence (7dbb362):**
  - **Crossings:** 291 street-over-freeway crossings, each driven straight at a held 15 m/s.
    - 38 left the car airborne 0.5 s or more, and 9 for 1 s or more.
    - 13 peaked 1 m or more above the ground, and 22 landed at 5 m/s or more.
    - 20 trenches and 9 humps are deeper or higher than 3 m.
    - Worst: Treasure Island Rd, 1.7 s and 3.0 m; San Jose Ave, 1.62 s, 2.8 m, landing at 9.9 m/s.
  - **The source:** sim ground is within 1.27 m of the raw DEM at every crossing.
  - **Richland Ave:**
    - The road runs 73.6 m, then 58.7 m, then 71 m within about 60 m.
    - At 16 m/s: 1.65 s airborne, 4.4 m up, landing at 16.5 m/s.
    - At 20 m/s westbound it peaks 17.8 m above the floor.

- **Shots:**
  - `play/shots/D-richland-ave-over-i280-trench-chase.png`
  - `verify-play/r3/shots/G-richland-trench-street-fly.png`

- **Cause:** bare-earth 3DEP removes overpass decks and keeps freeway cuts. Bridge-flagged and crossing edges have no height profile.

- **Fix:** in the road-profile pass (W-09), give crossing edges a deck-style linear profile between the abutments.

- **Test:** `tests/sim/world/grade-separations.test.ts`:
  - 0 crossings with a trench or hump over 1 m.
  - Richland Ave at 16 and 20 m/s has no airborne interval over 0.2 s.

- **Head: open.**
  - `synth/h1` C5: the Richland profile is identical, at 16 m/s 1.65 s airborne and 4.41 m up, and at 20 m/s westbound 17.81 m up.
  - Critic c2 at posted speed: 84 street runs airborne 0.5 s or more; the worst are Blanken Ave (2.33 m, 1.35 s) and 22nd St in Potrero Hill (2.31 m).

### W-15 Houses are drawn with 5 to 8 m storeys

- **Merges:** HOUSES-05 (high) and BLD-12 (medium). Kept at high, because it is visible on every residential street.

- **Where:**
  - Citywide. Sunset/Parkside has 17,805 of 24,056 houses at 5 m storeys or more (74%).
  - 201006.0106890 (Marina, 37.80479,-122.44018): 5.52 m storeys.
  - 201006.0066045: one 8 m storey.
  - 201006.0005193: a Marina condo drawn with 8 m storeys.

- **Evidence (7dbb362):**
  - 61% of 155,882 residential footprints (63% of the 151,746 that have storeys) are drawn with storeys of 5 m or more.
  - 102,307 of 175,595 records overall, and 22,302 at 8 m.
  - 90,110 of those houses have the roof at the LiDAR maximum (the ridge).
  - Even the LiDAR median gives 5.78 m per assessor storey, because the roll leaves out garage and attic levels.

- **Shots:**
  - `houses/shots/h03-sunset-30th.png`
  - `houses/shots/h07-marina-avila.png`
  - `verify-houses/shots/v05-sunset-30th.png`
  - `verify-houses/shots/v05-marina-avila.png`
  - `buildings/shots/r2-marina-8m-storeys.png`

- **Cause:**
  - `mesh.ts` `facadeStyle` sets `storeyM = heightM / stories`, clamped to 8 m.
  - `plausibleStories` lets an assessor count of 1 stand for houses up to 21 m.

- **Fix:** house kit K2.
  - Residential storeys = round((heightM - roof allowance) / 3.2), capped at 4.2 m.
  - At least assessor storeys + 1 for 1920 to 1960 row houses: the garage level.

- **Test:** `tests/pipeline/facade-storeys.test.ts`: fewer than 2% of residential records drawn with storeys of 5 m or more.

- **Head: open.** The facade code is unchanged.

### W-16 Phantom LiDAR towers: 68 m on 1st St and a 65 m block on Fort Point

- **Merges:** buildings-M4 and the Fort Point part of HOUSES-02.

- **Where:**
  - 201006.0000060-tower: 246 m², topY 73.33 (68.1 m), standing on the 1st St centreline at 37.789176,-122.396805 (Financial District).
  - 201006.0000856-tower: 1,087 m² to 64.6 m above the ground, on Fort Point at 37.81056,-122.47711 (Presidio).

- **Evidence:**
  - The 1st St tower is a 2010 LiDAR return over the Transbay excavation. The real Transit Center roof park is about 20 m.
  - At Fort Point, the LiDAR over the footprint has a mean of 30.2 m and a maximum of 64.18 m: it is the Golden Gate Bridge's south approach deck, which crosses over the fort. It is drawn as a house-palette block.

- **Shots:**
  - `houses/shots/l17-fort-point.png`
  - `verify-houses/shots/v02-fortpoint.png`
  - `buildings/shots/first-st-transit-center.png`

- **Cause:** the two-tier tower rule turns overhead structure returns into towers.

- **Fix:** overrides that drop both tower records: Fort Point keeps its 15.7 m podium, and 1st St becomes the Transit Center deck (W-01). Also add a check: a tower whose LiDAR spread matches a road deck or a bridge crossing is dropped.

- **Test:** `tests/pipeline/landmark-records.test.ts`: Fort Point's topY is no more than 25 m above its ground, and no record over 30 m stands on a drivable centreline.

- **Head: open.** `synth/h1` B: both records are unchanged.

### W-17 The streaming-ring seam: near and far terrain step up to 21.5 m, and the sea shows through (visible since head)

- **Merges:** CR-05 (high) and TER-09 (medium, measured as data at 7dbb362).

- **Where:**
  - The Lakeshore bluffs, t-20_17 and t-20_18, 37.71441,-122.50346: near 53.5 m, far 32.0 m.
  - West of Twin Peaks, t-9_13 and t-8_13, 37.73376,-122.43912: +20.65 m.
  - The Presidio, t-16_-1 and t-15_-1, 37.79958,-122.47885: far above near by 19.61 m.

- **Evidence (head, critic c4), every tile border every 5 m, 202,784 directed land samples:**
  - |near - far|: p50 0.60, p90 2.41, p99 7.43, max 21.45 m.
  - The step is over 5 m along 25.7 km of border, and over 10 m along 3.8 km.
  - The far side is above the near side by more than 1 m along 82.7 km, and by more than 3 m along 23.5 km. There, the sea shows through the crack.
  - In the live game at radius 60: +21.53 m and -19.61 m.
  - At the default radius the ring is 1.5 to 2 km out, visible from every hill. It also flashes while tiles stream in.

- **Shots:**
  - `critic/shots/R-ring-t-16_-1-t-15_-1-street-head.png` (sea through the crack)
  - `critic/shots/R-ring-t-16_-1-t-15_-1-aerial-head.png`
  - `critic/shots/R-ring-t-20_17-t-20_18-aerial-head.png`
  - `terrain/far-steps.png`

- **Cause:** `pipeline/lib/far.ts` samples the DEM on a 100 m lattice, lowered 0.5 m. It shares no border samples with the near tiles, and neither layer has a skirt.

- **Fix:**
  - Far-terrain border vertices from the near lattice: 10 m vertices along every tile edge.
  - Vertical skirts on both layers.
  - A 25 to 50 m far lattice in hill districts.
  - Extend the far bounds to the Marin ridgeline and San Bruno Mountain (TER-09).

- **Test:**
  - `tests/pipeline/far-ring.test.ts`: |near - far| at every border every 5 m is ≤ 1 m at p99 and ≤ 2 m at max.
  - `tests/e2e/far-ring.spec.ts`: at radius 60, no downward ray near the three borders reaches the sea plane.

- **Head: open.**

### W-18 Ground cover: most park land is grey, there is no foliage, and beaches and lakes are painted lawn (partly fixed on head)

- **Merges:** STR-06 and FC-VIS-04 (high), houses-M3 (medium) and CR-06 (high, at head).

- **Where:**
  - Golden Gate Park, the Presidio forest, McLaren Park and Lincoln Park are tinted at head.
  - Still grey at head:
    - Lake Merced Park, 248 ha, 37.71978,-122.49349.
    - The SF Zoo, 53 ha.
    - Glen Canyon, 37.74035,-122.44451.
    - Buena Vista, 37.76837,-122.44112.
    - Mission Dolores Park, 37.75976,-122.42714.
    - Mt Davidson, 37.73878,-122.45479.
    - Stern Grove, 37.73606,-122.47859.
    - Twin Peaks, 37.75007,-122.44808.
    - Bernal Heights Park, 37.74341,-122.41388.
    - Sunset Dunes and Marina Green.

- **Evidence:**
  - **7dbb362:** one land colour family (height-tinted grey) and 0 of 583 tile GLBs carry a foliage node. Trees are runtime street props only.
  - **Head (critic c5, 255 DataSF Rec and Park properties):**
    - 603 of 1,379 ha of park land is green (43.7%).
    - 240 of 253 properties are under 10% green (769 ha).
    - 32.6 ha of shore land is tinted grass, including Baker Beach and the Crissy shore (27.3 ha in the Presidio).

- **Shots:**
  - `streets/shots/05-golden-gate-park-bare.png`
  - `visual/golden-gate-park-aerial.png`
  - `visual/presidio-forest-aerial.png`
  - `visual/haight-buena-vista-aerial.png`
  - Head:
    - `critic/shots/P-dolores-park-aerial-head.png`
    - `critic/shots/P-buena-vista-park-aerial-head.png`
    - `critic/shots/P-glen-canyon-aerial-head.png`
    - `critic/shots/P-stow-lake-aerial-head.png`

- **Cause:**
  - No land-cover source and no ground classes in the pipeline.
  - At head, the renderer tints by 4 neighbourhood polygons, not by a park layer.

- **Fix:**
  - **Pipeline** writes a ground class per lattice vertex:
    - Grass and forest from the Rec and Park properties (gtr9-ntp6), the Presidio Trust and GGNRA extents, and the Urban Tree Canopy (ni2e-vpbg).
    - Water from lakes (W-11).
    - Sand for beaches (W-34).
  - **Pipeline** also adds a foliage node of instanced trees from the canopy and the Street Tree List.
  - **Render** colours by class for near and far, draws foliage, and drops the district tint.

- **Test:** `tests/pipeline/ground-cover.test.ts`:
  - At least 90% of park land vertices are grass or forest.
  - 0 lake-surface vertices are grass.
  - At least 90% of the Ocean, Baker, China and Crissy beach vertices are sand.
  - Every listed park tile has a non-empty foliage node.

- **Head: partly fixed** (4 park districts tinted). The rest is open, with two regressions: lakes and beaches painted lawn.

## Render

### W-19 The car is drawn level on hills (FIXED on head)

- **Merges:** PC-06 and visual-M1.

- **Evidence (7dbb362):** on Filbert at 31.9% (37.80027,-122.41817) the sim pitch is 17.7° while the drawn car has rotation.x = 0. The front wheels sit 0.64 to 0.68 m under the road and the rear wheels 0.18 to 0.22 m above it. On the Richland trench wall it is about ±1.1 m.

- **Shots:**
  - `play/shots/F-filbert-31pct-car-level-fly.png`
  - `verify-play/r3/shots/E-filbert-level-car-wheels-fly.png`
  - Head: `critic/shots/E-filbert-car-pitch-head.png`

- **Fix (landed):** `actors.ts` applies pitch and roll in YXZ order.

- **Test (kept):** `tests/e2e/car-pose.spec.ts`: on Filbert, the model's pitch is within 1° of the sim's.

- **Head: fixed.** rotation.x is 0.309 rad. The residual 0.29 to 0.32 m sink is W-09.

### W-20 The far LOD is not drawn: nothing beyond 1.5 km, and Marin, Alcatraz and Daly City show as sea (FIXED on head)

- **Merges:** TER-08 and FC-VIS-08 (high), and STR-17 (medium).

- **Shots:**
  - `visual/twin-peaks-street.png`
  - `verify-visual/shots/crissy-goldengate-street.png`
  - Head:
    - `critic/shots/T-twin-peaks-ring-view-head.png`
    - `critic/shots/T-twin-peaks-ring-view-night-head.png`

- **Fix (landed in 5f308bc):**
  - The far skyline is drawn day and night.
  - The far plane is 20 km.
  - The sea plane is 42 km wide.

- **Head: fixed.** The new defects of the far layer are W-17, W-40 and W-41.

## Sim

### W-21 Gaps in the sea wall for pier and bridge roads let cars and walkers out onto the Bay (new on head)

- **Merges:** CR-03.

- **Where:** `src/sim/boundary.ts` `gapsFor()` cuts 22 gaps for 11 roads:
  - Pier 45 Vly, 5 gaps (37.8095 to 37.8105, -122.4169 to -122.4184).
  - Al Scoma Way.
  - The Embarcadero c15357000.
  - Pier 50 Vly.
  - Unnamed 42 (Pier 70).
  - Rankin St.
  - 3rd St and 4th St over Mission Creek.
  - 3rd St and Illinois St over Islais Creek.
  - The I-280 ramps at Mission Creek, 4 gaps.

- **Evidence (head):**
  - **Turn tests:** 26 of 36 runs that turn on the water side get more than 20 m out (205 m at most).
  - **Pier 45 Vly:** a car reached 37.81351,-122.40508, 1,213 m out on open water at y=0, within 60 s.
  - **Islais Creek channel:** runs along it went 443 to 952 m.
  - **Walkers:** walk 33 m out.
  - **Browser:** the replay ends at the identical point.

- **Shots:**
  - `critic/shots/B-pier45-gap-on-the-bay-aerial-head.png`
  - `critic/shots/B-pier45-gap-on-the-bay-chase-head.png`

- **Cause:** a gap is cut across the shore line for the road, and nothing bounds the road on the water side. The road itself lies on the water (W-12, W-13).

- **Fix:** give each gap two kerb rails along the stretch of road whose ground is water, so the gap becomes a walled corridor. Then add decks (W-12, W-13).

- **Test:** `tests/sim/world/shore-gaps.test.ts`:
  - At every gap, a car turning 30, 60 or 90° either way at 10 and 25 m/s stays within 1 m of the corridor. So does a sprinting walker.
  - No body ends more than 3 m on the water side of any uncut shore line.

- **Head: open, new.**

### W-22 Render ground (triangles) and sim ground (bilinear) disagree off-road by up to 4.37 m

- **Merges:**
  - BLD-08 and TER-11 (partly verified; high).
  - STR-08 (high).
  - PC-07 (partly verified; its verifier rates it low by area). Kept at high by the majority of three verifiers. The dissent: by area, only 0.87% of land is off by more than 0.3 m.

- **Where:**
  - Lincoln Park, 37.78771,-122.49469: the render gives 15.52 m and the sim 11.14 m.
  - Outer Richmond, 37.78257,-122.51331: 2.97 m.
  - Telegraph Hill below Coit Tower, 37.80176,-122.40352: 2.77 m.
  - Corona Heights, 37.76527,-122.43724: 2.72 m.
  - Duboce Ave, 1.9 m on a road.

- **Evidence (7dbb362):**
  - **Per-cell maximum:** p50 0.037, p95 0.292, p99 0.567, max 4.37 m. 18,306 cells (about 1.8 km²) peak above 0.5 m.
  - **By area:** 5.76% of land differs by more than 10 cm and 1.06% by more than 25 cm.
  - **Random points:** 0.87% are off by more than 0.3 m, with p99 0.283 m.
  - **The cause is exact:** every difference is the twist term |h00 + h11 - h10 - h01| / 4, with a residual under 0.06 m.

- **Shots:**
  - `streets/shots/01-car-wheel-closeup.png`
  - `verify-streets/shots/v01-tyres-side.png`

- **Cause:** `src/sim/world.ts` `groundHeight` is bilinear, while `mesh.ts` splits each cell along the (i+1,k)-(i,k+1) diagonal.

- **Fix:**
  - `groundHeight` uses the mesh's triangle split (the pipeline already has `Ground.meshHeightAt`). This changes replays: bump `SIM_VERSION` and say so.
  - Or tessellate cells with a centre vertex at the bilinear value.

- **Test:** `tests/sim/world/ground-parity.test.ts`: at 10,000 seeded random land points, |sim - mesh| ≤ 0.02 m.

- **Head: open.** `groundHeight` is still bilinear (`heightIn` in `world.ts`).

### W-23 Ramming a building on a hill launches the car

- **Merges:** play-M1.

- **Where:**
  - Russian Hill, around 37.80012,-122.42150.
  - West of Twin Peaks, 37.75770,-122.44885.
  - Bernal Heights.

- **Evidence:**
  - **7dbb362:** 169 of 360 rams at 25 m/s into buildings on ground of 15% or steeper launched the car (0.5 s or more airborne, or 1 m or more up). The worst rose 18.6 m.
  - **Head (`synth/h1` C3, same seed):** 176 of 360 launch: Russian Hill 50, west of Twin Peaks 74, Bernal 52. The worst rose 27.1 m (201006.0007825-tower).

- **Cause:**
  - `stepCar` turns any collision push across a slope into vertical speed.
  - `collide.ts` then ignores buildings once the car is above their roof, so the car clears low houses.

- **Fix:** shared with W-06.
  - No vertical speed from a push.
  - Clamp the ground rate to |v| · slope + 1 m/s.

- **Test:** `tests/sim/world/ram-launch.test.ts` (the same 360 seeded rams): none airborne more than 0.3 s or more than 0.5 m up.

- **Head: open.**

## Assets

### W-24 The Golden Gate Bridge and the Bay Bridge are absent, and their approaches end at the shore

- **Merges:**
  - STR-05 (high).
  - The bridges part of HOUSES-02 (high).
  - visual-M3.
  - terrain-M2.

- **Where:**
  - The GGB south tower, 37.8116,-122.4774.
  - The Bay Bridge west span off Rincon Point, 37.788,-122.385.
  - Hwy 101 ends at z = -1753, at the toll plaza.
  - I-80 has no geometry between x = 491 and x = 2080 (1.59 km).

- **Evidence:**
  - `content/landmarks.json` has 2 entries (ferry-building, r-evolution), and there is no bridge model or far silhouette.
  - At 7dbb362, I-80 EB reached sea level 105 m in, and a car followed it 2,809 m across the Bay to Yerba Buena Island.
  - Hwy 101 NB drapes 55 m down the Fort Point bluff (a 45.3% grade).

- **Shots:**
  - `streets/shots/08-golden-gate-strait-no-bridge.png`
  - `streets/shots/09-bay-bridge-absent.png`
  - `houses/shots/l08-golden-gate.png`
  - `houses/shots/x06-bay-bridge-embarcadero.png`
  - `verify-houses/shots/v02-ggb-crissy.png`
  - `verify-houses/shots/v02-baybridge.png`

- **Cause:** no landmark model has been commissioned, and decks are scheduled later (GGB approach wave 4, Bay Bridge wave 8).

- **Fix:**
  - Low-poly, far-visible silhouettes of both bridges (towers, deck, main cables) through `landmarks.json` now.
  - Decks when scheduled.
  - The GGB is on design.md's pre-release legal checklist (trademark): keep the asset brief generic, and review it before release.

- **Test:** `tests/assets/landmarks.test.ts`: golden-gate-bridge and bay-bridge-west entries load. The screenshot tour views from Crissy Field and from Rincon Park show both.

- **Head: open.** At head the approaches stop at uncut walls instead of running onto the water: I-80 EB c14248000 at 97/2811 m, and Hwy 101 NB at 467/540 m.

### W-25 Sutro Tower is absent: three 3 m plinths and no model (new on head)

- **Merges:** CR-07.

- **Where:** Twin Peaks, 37.7552,-122.4528 (t-11_8): records 201006.0009087, 0062170 and 0168289.

- **Evidence (head):**
  - The three records stand 2.8 to 3.4 m above the ground, from `heightSource` override placeholders (`synth/h1` B).
  - `landmarks.json` has no Sutro entry and `public/models` has no tower.
  - The real 298 m lattice is the tallest object on the west-side skyline.

- **Shots (the 7dbb362 slab):**
  - `houses/shots/l07-sutro-tower.png`
  - `verify-buildings/shots/v-sutro-from-east.png`

- **Fix:**
  - An interim proxy: three tapered legs and a mast as thin prisms, or a simple Blender lattice, registered in `landmarks.json` at the probe.
  - A far-cell silhouette.
  - Keep the plinths as the base collider.

- **Test:**
  - `tests/assets/landmarks.test.ts`: a sutro-tower entry whose top is at least 290 m above the ground at 37.7552,-122.4528.
  - The far cell has a silhouette at least 250 m above the ground within 30 m.

- **Head: open, new.**

### W-26 Sutro Tower drawn as a solid 231 m slab (FIXED on head)

- **Merges:** BLD-09 and HOUSES-03.

- **Evidence (7dbb362):** 201006.0009087 was 683 m² at 231.3 m above its base, drawn as a glass curtain wall.

- **Head: fixed** by 74c473b: topY went from 486.54 to 258.06. The absence it leaves is W-25.

### W-27 Hero landmarks read as office boxes; Dragon Gate and Sutro Baths are absent; Coit Tower is 20% short

- **Merges:** HOUSES-04 (high), buildings-M3, BLD-17 (the Coit part), houses-M4 and FC-VIS-14.

- **Where and evidence (7dbb362):**
  - **Transamerica** (201006.0000687, 37.79518,-122.40278): a 68 m block plus a 385 m² square shaft to 258.6 m, not a pyramid.
  - **City Hall** (0000041): a 26.4 m block plus a 421 m² square "dome" to 88 m, with office windows and a shop band.
  - **Coit Tower** (0006230-tower, 37.80243,-122.40585): 51.3 m against a published 64 m, lit like an apartment block.
  - **Palace of Fine Arts** (0000986): a block plus a tower, with window grids.
  - **The ballpark:** a slab to 55.4 m.
  - **Grace Cathedral, the Conservatory and the Dutch Windmill:** blocks with centred towers.
  - **The Painted Ladies:** 7 ordinary rows.
  - **Dragon Gate and the Sutro Baths ruins:** absent.
  - **Models:** only the Ferry Building and R-Evolution.

- **Shots:**
  - `houses/shots/l02-coit-tower.png`
  - `houses/shots/l03-transamerica.png`
  - `houses/shots/l05-city-hall.png`
  - `houses/shots/l06-palace-fine-arts.png`
  - `houses/shots/l16-dragon-gate.png`
  - `houses/shots/l18-sutro-baths.png`
  - `verify-houses/shots/v04-transamerica.png`
  - `verify-houses/shots/v04-cityhall.png`

- **Cause:**
  - Landmarks are extruded footprints, with office glazing from `facadeStyle`.
  - The models are scheduled across waves 3 to 7.

- **Fix:**
  - **Pipeline:** tag the records that the places-table probes list as `meta.landmark`, and draw them with glazing 0 and a stone or white palette. Add a tapered Transamerica override.
  - **Assets:** models per the roadmap, plus Dragon Gate as a small instanced prop now.
  - **Content:** fix the Saints Peter and Paul probe (L-04).

- **Test:** `tests/assets/landmarks.test.ts`:
  - Every places-table landmark has a model or a documented interim shape with no office window grid.
  - Coit is within 5% of 64 m.
  - At 200 m height, the Transamerica silhouette is narrower than 40% of its base.

- **Head: open.**
  - Coit is still 51.25 m.
  - Mission Dolores now keeps its 39.25 m bell tower and no longer carries the 1-storey count (74c473b), a partial shape fix.

---

# Medium

## Pipeline

### W-28 Large hillside buildings are one flat prism over up to 30 m of relief

- **Merges:** BLD-10, and HOUSES-13 (partly verified; the "merged rows" framing is corrected: the examples are single terraced condo complexes).

- **Where:**
  - 201006.0001291, Nob Hill, 37.79782,-122.41318: a 60-unit 1980 condo, 1,930 m².
  - 0000739, Potrero Hill, 37.76186,-122.39873: a 65-unit 1996 condo.
  - 0001215, Potrero Hill: 88 units, 1978.
  - 0000744, Inner Sunset.
  - 0001003, Nob Hill.

- **Evidence:**
  - 3,896 records have more than 6 m of relief under one roof, 479 more than 10 m and 14 more than 20 m.
  - The downhill wall against the uphill wall: 27.74 vs 0.44 m (0001291) and 27.18 vs 1.97 m (0000739).

- **Shots:**
  - `buildings/shots/nob-hill-1291-downhill.png`
  - `buildings/shots/russian-hill-980-downhill.png`
  - `buildings/shots/r2-filbert-house.png`

- **Fix:** terrace by ground (strips of 4 m relief or less) or by condo unit or parcel. Each part gets its own base and roof. This is shared with W-05.

- **Test:** `tests/pipeline/grounding.test.ts`:
  - 0 drawn parts with more than 10 m of relief under one roof.
  - The downhill/uphill wall ratio is 1.3 or less at p50, on ground steeper than 30%.

- **Head: open.** 0001291 and 0000739 now carry a tower record, and their podiums dropped 3 m. The 24 to 27 m downhill wall remains.

### W-29 Facade storeys start at the centroid's ground, not at the street

- **Merges:** BLD-11.

- **Evidence:**
  - 6,617 of 59,564 street-facing buildings (11.1%) have the first-storey line more than 1.5 m off the sidewalk: 3,130 above and 3,487 below.
  - 1,149 are more than 3 m off.
  - The worst is 201006.0009973 at -11.19 m (37.757077,-122.446197, Castro/Upper Market).

- **Fix:** store `meta.streetY`, the ground at the wall nearest a road, and use it as the facade's v = 0. This is house kit K0 (the street level) and K2.

- **Test:** at most 1% of street-facing buildings are off by more than 1.5 m.

- **Head: open.**

### W-30 Self-intersecting tower rings draw double roofs and roof slabs outside the walls

- **Merges:** BLD-13.

- **Where:**
  - 201006.0000174-tower (Bernal Heights, 37.74712,-122.42079).
  - 0000080-tower (Lakeshore).
  - 0000176-tower (Mission Bay).
  - The non-tower 0169162 (37.723406,-122.484718).

- **Evidence:**
  - 192 rings are self-intersecting, 19 of them towers.
  - 90 draw at least 1 m² of roof twice.
  - 55 draw at least 1 m² outside their walls, 1,167 m² in total.
  - 0000174-tower has 509 m² outside its walls, at roof y 76.53.

- **Shots:**
  - `verify-buildings/shots/v-174-tower-slab-above-N.png`
  - `buildings/shots/r2-floating-roof-slab.png`

- **Fix:** after `towerFootprint` and `simplifyRing`, reject or repair any non-simple ring, using the convex hull of the clipped ring or a robust intersection.

- **Test:** `tests/pipeline/rings.test.ts`: 0 non-simple rings in any collider or GLB.

- **Head: open.** 0000174-tower is unchanged.

### W-31 The 10 m lattice adds bumps on roads that cross hillsides; there is no 2 m road-profile pass

- **Merges:** TER-10.

- **Evidence:** the steepest 10 m grade, sim against the 1 m DEM:
  - Twin Peaks Blvd c12770000: 10.7% vs 2.9%, with a 23.8-point grade break against 3.2 at 37.75366,-122.44803.
  - Vermont St c13216002: 32.4% vs 17.6%. Part of that comes from the 4 to 5 m source DEM (22.2%).
  - Vasquez Ave: 18.0% vs 9.8%.
  - Kensington Way: 17.4% vs 10.6%.

  Average grades agree within 0.6 points. The roadmap has no road-surface task.

- **Shots:** `terrain/vermont-profile.png`.

- **Fix:** the road-profile pass (W-09), sampling the 1 m DEM (L-06) every 2 m and keeping intersection plateaus. Schedule it.

- **Test:** `tests/pipeline/road-profile.test.ts`:
  - 0 surface edges with a grade break more than 10 points above the DEM's.
  - The famous blocks stay within 0.5 points of the 1 m DEM.

- **Head: open.**

### W-32 Junction ribbons overlap, z-fight and paint lane lines through crossings

- **Merges:** STR-11.

- **Evidence:** 1.19 to 1.35 km² of road is covered by two ribbons at the same lift, and markings run through junctions. Example: Larkin and Hyde at Broadway, 37.7962,-122.4190.

- **Shots:** `streets/shots/11-intersection-overlap-closeup.png`.

- **Fix:** junction polygons and trimmed ribbons, as the renderer's fallback builder already does (`nodeHalfWidth`), with markings faded inside.

- **Test:** less than 0.5% of road area under two ribbons, and no marking inside a junction polygon.

- **Head: open.**

### W-33 Stairways are dropped, or drawn as smooth ramps that the car can drive

- **Merges:** STR-13 (medium) and PC-08 (low).

- **Evidence:**
  - The UPROW stairs are dropped: the 16th Ave tiled steps (Moraga, 37.7563,-122.4728), the Harry St steps and the Linda Vista steps.
  - The kept stairs (Filbert, Greenwich, Lyon, Vulcan) are smooth 6.5 m ribbons.
  - Stairways are classed as residential streets, and the car drives up 53 to 80% grades.
  - `sidewalks.json` is read by nothing in `src/`.

- **Fix:**
  - Keep the stair segments as pedestrian `stairs` edges, closed to vehicles.
  - Stepped geometry or a stair texture (Assets).

- **Test:** `tests/pipeline/stairs.test.ts`:
  - The Filbert, Greenwich, Lyon, 16th Ave, Vulcan and Harry stairs are pedestrian `stairs` edges joined to the walk graph.
  - 0 stair edges are drivable.

- **Head: open.**

### W-34 Beaches are grey; at head some are painted lawn

- **Merges:** STR-15.

- **Where:**
  - Ocean Beach, 37.7640,-122.5112 and 37.7355,-122.5072.
  - Baker Beach, 37.7935,-122.4836.
  - China Beach, 37.7882,-122.4912.
  - The Crissy Field beach.

- **Shots:**
  - `streets/shots/10-ocean-beach-grey-sand.png`
  - `visual/ocean-beach-aerial.png`

- **Fix:** a sand ground class (W-18).

- **Test:** the ground-cover test (W-18).

- **Head: open.** The Baker and Crissy shores are tinted grass.

### W-35 No seawall is drawn; the shoreline is a 10 m staircase; the Embarcadero promenade ramps into the Bay (partly fixed on head)

- **Merges:** STR-16 and FC-VIS-12 (low).

- **Where:**
  - The Embarcadero at Pier 14 (37.7930,-122.3925) and at Pier 7 (37.7985,-122.3985).
  - Marina Green (37.8055,-122.4400).

- **Evidence:**
  - The lattice interpolates the seawall into a slope.
  - The renderer drops whole 10 m water cells, which makes a staircase with 45° cuts.

- **Shots:** `streets/shots/06-piers-1-to-9-on-water.png`.

- **Fix:**
  - Extrude a quay face along the shore polylines wherever the land stands 1.5 m or more.
  - Clip the ground mesh to the shore line.

- **Test:**
  - The promenade keeps 3 m or more within 1 m of the shore.
  - The drawn water edge follows the `boundary.json` shore within 1 m.

- **Head: partly fixed.** The sim walls stop cars at the shore line, but nothing is drawn.

### W-36 Footprint simplification opens 5 to 60 cm cracks between row houses

- **Merges:** HOUSES-06.

- **Evidence:**
  - 82,927 crack pairs, 735 km long, on 61,898 houses.
  - Pairs that touch in DataSF became cracks: Sunset 140 of 1,464, Mission 157 of 649, Marina 151 of 888, Russian Hill 146 of 542.
  - The mouth is open by 10 cm or more at the street in 97 of 183 (Sunset) up to 303 of 465 (Mission).

- **Shots:** `houses/shots/x07-crack-mouth-mission-liberty.png`.

- **Fix:** topology-preserving simplification. Snap shared vertices within 5 cm, and simplify each shared chain once.

- **Test:** 0 touching-to-crack transitions in the four sample boxes, and a citywide crack count no higher than the raw data's.

- **Head: open.** The footprints are identical.

### W-37 One facade class and a washed-out palette; the Painted Ladies look like any other row

- **Merges:** HOUSES-12.

- **Evidence:**
  - 169,765 of 175,595 footprints (96.7%) are pastel at glazing 0.25.
  - There are 34 wall colours, with saturation at most 0.23.
  - The 7 Painted Ladies records (710 to 720 Steiner) are drawn as an ordinary row with 5.1 to 6.8 m storeys.

- **Shots:**
  - `houses/shots/h02-painted-ladies.png`
  - `verify-houses/shots/v12-painted-ladies.png`

- **Fix:** house kit K3, with a Content override for the 7 ids.

- **Test:**
  - At least 30% of pre-1915 houses have saturation 0.3 or more.
  - No two adjacent houses on a block face share a colour.
  - The override is applied to all 7 ids.

- **Head: open.**

### W-38 Every roof is flat at the LiDAR ridge height: no gables, parapets, cornices or rooftop kit

- **Merges:** houses-M2 (medium) and HOUSES-14 (low).

- **Evidence:**
  - 0 of 177,857 decoded building ranges have a vertex above the collider roof.
  - 90,110 houses have the flat roof at the LiDAR maximum, a median 1.31 m above the LiDAR median roof surface.

- **Shots:**
  - `houses/shots/h13-sunset-aerial.png`
  - `houses/shots/h16-russian-hill-aerial.png`

- **Fix:** house kit K8.

- **Test:** the K8 test in `house-kit-spec.md`.

- **Head: open.**

### W-39 33 public stairways and paths are blocked on foot by footprints

- **Merges:** CR-08. First measured at head; the footprints have not changed since 7dbb362.

- **Where:**
  - Pemberton Pl c10324000 and c10325000 (Castro, 37.7584,-122.4468).
  - Vista Ln c13334000 (Twin Peaks).
  - Cottage Row c4461000 (Japantown, 37.78622,-122.43220): 54.5 m inside 6 houses.
  - Hyde St c7153000 and c7154000: 47.5 m.
  - Acme Aly: 37 m.
  - Otega Ave: 31.5 m.
  - Redfield Aly: 29.5 m.
  - Moraga St c9332000 (Inner Sunset).

- **Evidence (head):**
  - 170 pedestrian edges were walked both ways with the real `stepFoot`: 264 of 340 walks reach the end.
  - 33 edges are blocked both ways (2.35 km) and 10 one way.
  - All 33 have their centreline inside a footprint, 596.5 m in total.

- **Fix:** a 1.5 m pedestrian clearance pass, shared with W-01.

- **Test:** `tests/sim/world/walk-every-path.test.ts`: every pedestrian edge, walked both ways, reaches the end.

- **Head: open.**

### W-40 No far terrain beyond the south-edge tiles: the city edge floats over the sea

- **Merges:** CR-09, play-M4 and play-M5.

- **Where:**
  - t-16_21 (37.69865,-122.48169).
  - t-4_21 (37.69865,-122.41357).
  - t-3_21 (37.69865,-122.40789).
  - t7_-5 (37.81577,-122.35112, beside Yerba Buena Island).

  None of the four is in `manifest.tiles` or `manifest.outside`.

- **Evidence:**
  - Far coverage is 0% in all four.
  - 340 land border samples (1.7 km) face no far terrain, 310 of them toward these tiles.
  - The near tiles end in drops of 37.1, 34.4 and 6.8 m.

- **Shots:**
  - `verify-play/r3/shots/F-county-line-cliff-fly.png`
  - `visual/south-edge-aerial.png`

- **Fix:** derive `manifest.outside` as every tile 4-adjacent to a built tile whose DEM has land, and build far terrain for all of them.

- **Test:** `tests/pipeline/far-coverage.test.ts`:
  - Every land border sample has far terrain within 1 m across it.
  - The 4 tiles have at least 95% far coverage.

- **Head: open.**

### W-41 The far skyline pops when tiles stream in

- **Merges:** CR-10.

- **Where:**
  - 201006.0000518 (37.79260,-122.40061): an 89.5 m building under a 211.9 m hull.
  - 0009508 (Tenderloin): +75.5 m.
  - 0000703: +75.3 m.
  - 0001065: +74.9 m.

- **Evidence (head):**
  - Of the 1,093 records 30 m or taller, 41 differ from their far hull by more than 10 m, up to +122.4 m.
  - Among lower records, p90 is 3.46 m, 937 differ by more than 10 m, and 690 have no far hull at all.

- **Fix:**
  - Use the simplified footprint, not the convex hull, for tall records, or clip each hull to its footprint plus 1 m.
  - Never let a hull cover another record's centroid.
  - Give every record a hull or a cluster.

- **Test:** `tests/pipeline/far-hulls.test.ts`:
  - Every record 30 m or taller is within 3 m at its centroid.
  - Every record lies under a hull.
  - Records under 30 m are within 5 m at p99.

- **Head: open.**

### W-42 1,356 Daly City buildings stand on a strip south of the county line with no streets

- **Merges:** visual-M4.

- **Evidence:**
  - The buildings have centroid z > 9850 and x from -9550 to 140, on a strip 150 to 650 m wide.
  - The last road point is at z = 9821.

- **Fix (design decision):** either crop the built area at the county line, so the strip becomes far LOD, or add its streets.

- **Test:** `tests/pipeline/network.test.ts`: every built tile with buildings has a drivable edge, or is listed as scenery-only.

- **Head: open.** The strip is now inside the walls.

### W-43 Lombard St: the centreline cuts into a house at the top approach

- **Merges:** PC-03 (partly verified, lowered from high to medium).

- **Where:**
  - c8449000 (the approach from Hyde) and c8448000 (the crooked block), Russian Hill, 37.8021,-122.4187.
  - Houses 201006.0021655 and 0020610.

- **Evidence:**
  - The centreline enters 0021655 by 0.19 m at 37.80198,-122.41919, and 11.3 m of it is closer than the car's half-width.
  - A centreline follower sticks at 37.80199,-122.41921.
  - A path planned through the free space, up to 7.9 m off the centreline, gets down with 0 contacts. The block is passable; the drawn line, the AI line and the GPS line are wrong.

- **Shots:**
  - `play/shots/A-lombard-crooked-block-stuck-chase.png`
  - `verify-play/r3/shots/A-lombard-topdown-fly.png`

- **Fix:** hand-author the crooked block's centreline through the middle of the corridor, with radii of 5.3 m or more, and clip 0021655 back from the carriageway.

- **Test:** centreline clearance of at least 1.5 m on both edges. Scripted descent and climb at 5 m/s with 0 contacts.

- **Head: open.** A road follower stops on c8449000 at 50/82 m and on c8448000 at 14/144 m (against 0020610).

## Render

### W-44 Street trees and lamps stand in roadways and inside buildings

- **Merges:** STR-12 and FC-VIS-11.

- **Where:**
  - Mission St at 13th under the Central Freeway, 37.76975,-122.42001.
  - Broadway at the tunnel portal.
  - The Market St median at Castro, 37.76267,-122.43519.
  - Ortega St.
  - Pine St.

- **Evidence:**
  - 4.1% of trees stand on carriageways. The 440 to 473 on freeways belong to the streets under the draped freeways.
  - 5.8% of trees stand inside buildings citywide, and 9.2% in the Castro and Mission Bay samples.
  - 6 to 9% of lamps stand on carriageways.

- **Shots:**
  - `visual/central-freeway-101-street.png`
  - `verify-visual/shots/market-castro-low-aerial.png`

- **Fix:**
  - Reject any spot inside a ribbon plus 0.5 m, inside a footprint or over water, using the pipeline's `RoadSurface` clearance query.
  - Better: place trees from the Street Tree List.

- **Test:** `tests/render/props-placement.test.ts`: 0 lamps or trees on a ribbon, and 0 inside a footprint.

- **Head: open.** `src/render/roads.ts` is unchanged.

### W-45 No sidewalks are drawn anywhere in the sf world

- **Merges:** streets-M2. Severity medium, set by the QA lead; the verifier gave none.

- **Evidence:**
  - The GLB roads node carries carriageway ribbons only.
  - The streamer builds its fallback roads, with sidewalks, only when a tile has no roads node.
  - Walkers walk on bare grey ground beside the kerb.

- **Shots:** `verify-streets/shots/v01-tyres-side.png`.

- **Fix:** the pipeline adds sidewalk ribbons from `sidewalks.json` (clipped per L-09), or the renderer draws them.

- **Test:** `tests/render/sidewalks.test.ts`: a drawn sidewalk on every side where `sidewalks.json` has one.

- **Head: open.**

### W-46 to W-50: the house features

Each is ranked, specified and given its acceptance test in `house-kit-spec.md`. All are open on head: the facade, material and geometry code is unchanged.

**W-46 Facades have no front** (HOUSES-07).
- There is one `_FACADE` per building, so street fronts, party walls and rear walls carry the same window grid.
- Residential wall splits as 19.2% front, 47.2% party and 33.6% side or rear.
- 1,461,979 m² of party wall exposed above a lower neighbour is drawn with windows.
- Shots: `houses/shots/h16-russian-hill-aerial.png`.
- Kit K1.

**W-47 Storefronts are not rendered** (HOUSES-08).
- 9,775 of 10,641 storefront anchors (91.9%) sit on walls with no shop band, including 1,123 of 1,159 in the Mission.
- `storefronts.json` is read only by `src/content`.
- Shots: `houses/shots/h10-mission-st.png`, `verify-houses/shots/v08-mission-st.png`.
- Kit K5.

**W-48 No garage doors** (HOUSES-09).
- There are 52,774 to 74,504 candidates, depending on the classifier; 16,816 are in Sunset/Parkside.
- Shots: `houses/shots/h03-sunset-30th.png`, `houses/shots/h13-sunset-aerial.png`.
- Kit K4.

**W-49 No bay windows** (HOUSES-10).
- 46,283 residential buildings date from 1915 or earlier.
- Where a footprint does include a bay (Steiner 710 to 722), it is a plain prism with the ordinary window grid.
- Shots: `houses/shots/h01-mission-liberty.png`, `houses/shots/h04-pacific-heights.png`.
- Kit K6.

**W-50 No stoops or entry stairs; blank plinths** (HOUSES-11).
- 12,542 houses have a blank band of 3.5 m or more at the foot of the front, and 2,499 have 5 m or more. The cause is the tall storeys of W-15 combined with centroid anchoring (W-29).
- Shots: `houses/shots/h05-russian-hill-filbert.png`, `verify-houses/shots/v11-plinth.png`.
- Kit K7.

## Sim

### W-51 A car placed overlapping a footprint launches 144 to 178 m (respawn, teleport, mission placement, join offsets)

- **Merges:** play-M2.

- **Evidence:**
  - **7dbb362:** 141 to 180 m up for more than 9 s.
  - **Head (`synth/h1` C2):**
    - Congdon St (37.73225,-122.42584): moves 4.47 m in the first tick, reaches vy 59.2 m/s and 178.0 m up.
    - Market St at Octavia (37.77162,-122.42412): 7.53 m, 144.1 m up.
    - Octavia St: 30.9 m up.
  - **Spawn slots:** 58 of the 26,792 street runs start inside a footprint, so a respawn onto those starts would launch. 0 of the 8 multiplayer spawn slots do.

- **Fix:**
  - The W-06 change: no vertical speed from a push, and a capped push.
  - Respawn and teleport search for a clear spot first.

- **Test:** `tests/sim/world/placement.test.ts`: a car placed at each start-blocked street start rises less than 0.5 m and moves no more than speed·DT + 0.5 m per tick.

- **Head: open.**

### W-52 The walker has no vertical state: any drop is a one-tick teleport (partly fixed on head)

- **Merges:** play-M3.

- **Evidence:**
  - At 7dbb362 the walker dropped 181.41 m in a single tick at the county line, because y snaps to the ground.
  - `stepFoot` has no fall and no maximum grade, so a walker can climb any cliff (Lands End, the freeway trench walls). This was not measured.

- **Fix:**
  - Walker vertical speed with gravity, a maximum climbable step and grade, and a fall state.
  - This changes `FootState`: an additive contract change, which needs a `SIM_VERSION` bump.

- **Test:** `tests/sim/world/walker-falls.test.ts`:
  - Walking off a 3 m drop takes at least 0.7 s to land.
  - A walker cannot climb a slope over 100% that is taller than 1 m.

- **Head: partly fixed.** The county-line case is walled off, but the mechanism remains.

---

# Low (audit only)

By the workflow's design, low findings were not verified. Each status below is decided from the data diff and the code.

| ID | Source | Owner | Defect | Head |
|---|---|---|---|---|
| L-01 | BLD-14 | pipeline | 23 duplicate and 24 coplanar-roof footprint pairs z-fight. | open |
| L-02 | BLD-15 | pipeline | Wall bottoms float 5 to 25 cm above the drawn ground on 38 buildings. | open |
| L-03 | BLD-16, buildings-M6 | pipeline | Two buildings straddle the south edge and hang over the void: 201006.0017547 by 118.6 m (37.705434,-122.462201) and 0008708 by 16.4 m (37.705490,-122.416322). | open (now behind the wall; visual only) |
| L-04 | BLD-17 (probe) | content | The saints-peter-and-paul probe in `pipeline/areas.json` points 143 m away, at 201006.0003946. The church is 201006.0001265 and its -tower. (Coit is in W-27.) | open |
| L-05 | BLD-18 | render | If a tile GLB fails, the collider fallback extrudes from baseY - 1 m: 51,328 hillside buildings would float, 5,172 of them by more than 3 m. | partly (head retries a failed GLB once after 1.5 s; the fallback is unchanged) |
| L-06 | TER-12 | pipeline | The DEM is requested at about 4 x 5 m although USGS serves 1 m. With the 10 m lattice, cliffs, cuts and retaining walls are rounded off by up to 6.6 m (lattice) and 9.3 m (request). | open |
| L-07 | TER-13 | pipeline | 2 to 4 m notches in road ribbons at sharp polyline bends. | open |
| L-08 | TER-14 | pipeline + assets | Alcatraz exists only as far terrain, flattened by 9 to 13 m, with no buildings. | open |
| L-09 | STR-14 (lowered from medium) | pipeline | 10.1% of the sidewalk graph (3,560 edges) lies inside footprints. No runtime code reads `sidewalks.json` yet. | open |
| L-10 | STR-18 | pipeline | Boulevards are drawn narrower than their corridors; alley and residential kerbs run into buildings. | open |
| L-11 | STR-19 | pipeline | 9 ribbon seams open by more than 2 cm (max 0.27 m at t-5_5/t-5_6); 4 junction caps are unmatched across seams. | open |
| L-12 | STR-20 | pipeline | Treasure Island and YBI are unreachable by road (wave 8). There are 26 components, 7 one-way sinks, and one-way edges that dead-end at the county line. | open |
| L-13 | FC-VIS-12 | pipeline + render | About 1 ha of sim land is drawn as water (Mission Creek shoreline, t0_4). The 10 m staircase is in W-35. | open |
| L-14 | HOUSES-15 | pipeline + render | 48% of 1,641,534 corners split a window; 21,321 window rows are sliced by the roofline; 29,524 ground-floor windows are clipped at the 0.8 m mask. | open |
| L-15 | HOUSES-16 | pipeline | 485 low-rise houses carry a box centred on the roof, rising 3 to 12 m. | open (not recounted at head, where the condo rule added 64 tower records) |

PC-07, FC-VIS-13, FC-VIS-14, HOUSES-14, PC-08, visual-M7 and houses-M4 are merged into W-22, W-05, W-27, W-38, W-33, W-02 and W-27.

# What passed

These checks held, so the coverage is visible.

**Buildings (7dbb362).**
- Of 177,023 DataSF footprints, 175,595 are present.
  - The drops are all explained: 774 with LiDAR under 2 m and no storeys, 768 under 4 m² after simplification, and 3 invalid.
  - 0 were dropped outside the boundary, merged, or lost otherwise.
  - All 41 districts have buildings, and no whole block is lost by the pipeline.
- Parity: every collider record has mesh triangles and every mesh range has a record. There are no invisible walls or ghost meshes among 177,857 records.
- Grounding: every wall bottom is at or below the lowest ground under it, except the 2 records at the south edge (L-03). House walls reach the rendered ground: 2 of 4,734 hillside buildings show a gap, the largest 0.19 m.

**Terrain (7dbb362).**
- Every built tile has a complete heightfield, and the JSON equals the binary pack.
- Seams: 1,093 tile pairs and 511 four-tile corners with 0 height or water mismatches. GLB border vertices are identical.
- Summits: the sim is within 0.03 to 0.92 m of the DEM at all 25 named summits; for example, Mount Davidson 283.82 m against a published 282.9 m.
- Famous grades: Filbert 31.9%, 22nd St 31.8% and Jones 29.1%, against published 31.5, 31.5 and 29%. The car climbs all three from a standstill.
- No sea is drawn as land.

**Streets (7dbb362).**
- 9,459 of 9,464 ribbon caps meet across seams.
- Every mainland district reaches at least 95.3% of its nodes from the spawn.
- `boundary.json` covers the whole 73 km outline once.

**Play (7dbb362).**
- Seams crossed: 298 on 126 km of closed-loop routes. The largest seam step under the car is 0.087 m.
- The car never went below the terrain, passed through a visible building, or hit a ghost collider.
- A walker climbs Filbert at 1.29 m/s and the Lyon St steps at 1.2 m/s.
- Browser runs match Node to 0.0 m.

**Visual (7dbb362).**
- All 26 required places were shot with 0 tile failures.
- There are no holes in the ground.
- A full-speed 30 s streaming drive showed no pop-in hole.
- Night lights render.

**Head 54ee728 (critic, lead).**
- The world edge holds: 0 of 6,064 ram tests crossed a real wall.
- The car's pitch and roll match the sim.
- The far skyline renders day and night.
- The pack equals the JSON on all 583 tiles, and 219,693 border samples agree.
- Three 60 s `step()` runs with 330 agents hash identically.
- Browser and Node are identical on the new defects.
- All 8 multiplayer spawn slots are clear.
- Robotaxis no longer use freeways.
- Sunset/Parkside is 100% drivable at posted speed.

# Coverage

## Districts x dimensions

- **Data checks:** the buildings, terrain and streets data checks are citywide, over all 583 tiles and all 41 districts.
- **Audit columns:** the visual, house and play columns name what was looked at or driven in each district at 7dbb362.
- **Head columns:** measured on head by the critic.
  - Street runs: c2, every edge in every allowed direction.
  - Stair walks: c3.
  - Ring seam: c4, directed border samples whose step exceeds 3 m.
  - Parks: c5, Rec and Park land tinted green.

| District | Data checks (buildings, terrain, streets: citywide) | Visual places (7dbb362) | House and landmark shots (7dbb362) | Play routes (7dbb362) | Head: street runs reaching the end | Head: edges blocked every way | Head: stair walks blocked | Head: ring seam samples > 3 m | Head: park land green |
|---|---|---|---|---|---|---|---|---|---|
| Bayview Hunters Point | yes | Bayview, I-280 | - | - | 99.3% of 2145 | 6 | - | 1196 (max 13.0 m) | 0/34 ha |
| Bernal Heights | yes | Bernal Hill | Peralta slope | Crescent Ave, Richland trench | 99.1% of 1036 | 3 | 0/10 | 592 (max 16.0 m) | 0/22 ha |
| Castro/Upper Market | yes | Market at Castro (day, night) | hill through roof | Market to Castro | 98.1% of 669 | 6 | 7/30 | 255 (max 9.8 m) | 0/15 ha |
| Chinatown | yes | - | Dragon Gate | - | 90.9% of 330 | 18 | 5/6 | 16 (max 4.0 m) | 0/1 ha |
| Excelsior | yes | Excelsior, south edge | - | south edge (walk, drive) | 99.3% of 992 | 3 | 0/3 | 348 (max 14.2 m) | 0/25 ha |
| Financial District/South Beach | yes | Bay Bridge touchdown, I-80 | Montgomery, Ferry Bldg, Transamerica, Salesforce, Bay Bridge | Ferry Bldg start, 1st St | 93.9% of 677 | 19 | 0/15 | 84 (max 6.0 m) | 0/7 ha |
| Glen Park | yes | - | - | - | 95.5% of 400 | 10 | 3/12 | 625 (max 12.7 m) | 0/8 ha |
| Golden Gate Park | yes | GGP | Conservatory, windmill | JFK Dr | 99.6% of 281 | 0 | - | 613 (max 11.6 m) | 371/371 ha |
| Haight Ashbury | yes | Haight, Buena Vista | - | - | 99.7% of 375 | 0 | 0/2 | 143 (max 8.3 m) | 48/66 ha |
| Hayes Valley | yes | Central Freeway | - | - | 99.7% of 374 | 0 | - | 49 (max 7.4 m) | 0/7 ha |
| Inner Richmond | yes | - | 8th Ave | - | 100.0% of 382 | 0 | - | 20 (max 5.7 m) | 0/6 ha |
| Inner Sunset | yes | - | - | 19th Ave | 99.6% of 746 | 2 | 11/33 | 1078 (max 18.3 m) | 0/8 ha |
| Japantown | yes | - | - | - | 97.6% of 85 | 2 | 1/2 | 13 (max 4.1 m) | 0/2 ha |
| Lakeshore | yes | Lake Merced | - | Great Hwy | 98.6% of 416 | 4 | - | 1109 (max 21.4 m) | 0/303 ha |
| Lincoln Park | yes | Lands End | Sutro Baths | - | 100.0% of 48 | 0 | - | 306 (max 13.6 m) | 46/46 ha |
| Lone Mountain/USF | yes | - | - | - | 99.8% of 422 | 1 | 7/14 | 75 (max 9.8 m) | 0/3 ha |
| Marina | yes | Fillmore drop | Avila stucco, Palace of Fine Arts | Fillmore | 98.9% of 759 | 3 | 0/1 | 69 (max 10.5 m) | 1/29 ha |
| McLaren Park | yes | - | - | - | 100.0% of 75 | 0 | - | 281 (max 7.5 m) | 132/135 ha |
| Mission | yes | US-101 | Liberty St row, Mission St, Mission Dolores | - | 97.6% of 1497 | 19 | - | 79 (max 6.7 m) | 0/11 ha |
| Mission Bay | yes | 3rd St bridge | ballpark | 3rd St | 98.4% of 436 | 3 | - | 12 (max 4.2 m) | 0/9 ha |
| Nob Hill | yes | California St | Grace Cathedral | California St | 93.0% of 341 | 11 | 1/6 | 115 (max 6.5 m) | 0/1 ha |
| Noe Valley | yes | 22nd St (day, night) | - | 22nd St from Church | 97.9% of 672 | 6 | 0/18 | 380 (max 15.4 m) | 0/6 ha |
| North Beach | yes | Telegraph Hill, Coit (day, night) | Coit | Houston St | 91.7% of 533 | 21 | 1/20 | 266 (max 16.1 m) | 0/4 ha |
| Oceanview/Merced/Ingleside | yes | south edge | - | - | 100.0% of 648 | 0 | 0/12 | 265 (max 7.2 m) | 0/7 ha |
| Outer Mission | yes | - | - | - | 99.8% of 829 | 0 | 6/17 | 231 (max 8.3 m) | 0/12 ha |
| Outer Richmond | yes | Richmond, Ocean Beach | - | Great Hwy | 99.8% of 906 | 1 | 0/2 | 359 (max 12.3 m) | 0/12 ha |
| Pacific Heights | yes | Fillmore drop | block | Fillmore | 99.8% of 495 | 1 | 3/12 | 212 (max 7.5 m) | 0/11 ha |
| Portola | yes | - | - | - | 99.8% of 603 | 0 | - | 328 (max 9.1 m) | 0/2 ha |
| Potrero Hill | yes | Vermont St, I-280 Dogpatch | - | Vermont St | 98.1% of 674 | 5 | 0/2 | 398 (max 15.8 m) | 0/9 ha |
| Presidio | yes | Presidio forest, Crissy Field | Golden Gate, Fort Point | Mason St, Lyon St steps | 98.3% of 774 | 9 | 0/1 | 926 (max 19.6 m) | 5/5 ha |
| Presidio Heights | yes | - | - | - | 97.7% of 305 | 4 | - | 31 (max 4.3 m) | 0/1 ha |
| Russian Hill | yes | Filbert at Hyde, Lombard | Filbert slope, aerial, Lombard | Filbert up, Lombard down | 94.8% of 543 | 14 | 6/12 | 258 (max 8.3 m) | 0/4 ha |
| Seacliff | yes | - | - | - | 98.4% of 126 | 1 | - | 84 (max 5.0 m) | - |
| South of Market | yes | I-80 | - | Market St, Howard St | 98.9% of 536 | 4 | 0/4 | 6 (max 4.0 m) | 0/2 ha |
| Sunset/Parkside | yes | 30th Ave grid, Ocean Beach | 30th Ave row, aerial | Great Hwy, 19th Ave | 100.0% of 2224 | 0 | 3/16 | 399 (max 10.6 m) | 0/67 ha |
| Tenderloin | yes | - | City Hall | - | 92.9% of 280 | 10 | 2/7 | 14 (max 5.4 m) | 0/5 ha |
| Treasure Island | yes | - | - | - | 84.7% of 567 | 38 | - | 467 (max 16.6 m) | 0/26 ha |
| Twin Peaks | yes | Twin Peaks summit | Sutro Tower | Twin Peaks Blvd to summit | 97.5% of 325 | 5 | 7/34 | 752 (max 17.1 m) | 0/24 ha |
| Visitacion Valley | yes | south edge | - | - | 98.7% of 453 | 2 | - | 157 (max 6.3 m) | 0/3 ha |
| West of Twin Peaks | yes | - | - | - | 99.6% of 2160 | 3 | 13/47 | 1356 (max 20.6 m) | 0/59 ha |
| Western Addition | yes | Alamo Square | Painted Ladies | - | 98.0% of 398 | 3 | - | 19 (max 4.6 m) | 0/8 ha |

Districts with no in-game screenshot or route at 7dbb362 (data checks and the head drive, walk and seam sweeps only): Glen Park, Japantown, Lone Mountain/USF, McLaren Park, Outer Mission, Portola, Presidio Heights, Seacliff, Treasure Island, West of Twin Peaks.

## Checks x builds

| Check | 7dbb362 audit | Verified (different method) | Head 54ee728 |
|---|---|---|---|
| Building completeness vs source and vs the 2025 roll | buildings | verify-buildings (looser 25 m test) | data diff: 0 footprints changed |
| Grounding, buried roofs, floating walls | buildings, houses, visual | verify-buildings (interior raster), verify-houses | re-run h1 B, C1, C6 |
| Heights vs published | buildings, houses | verify-buildings | h1 B (landmarks), h2 (64 new towers) |
| Collider/mesh parity | buildings, play | - | data identical |
| Terrain coverage, seams, summits, grades | terrain, visual, play | verify-terrain (1 m DEM) | critic c6 (pack = JSON, borders) |
| Render vs sim ground and road | terrain, streets, visual, play | four verifiers (raycast, raster, area) | critic scene E (Filbert) |
| Tunnels, freeways, bridges, piers | streets, terrain, buildings | verify-terrain/streets/buildings drives | critic c2 fwy and surface, h1 C5, q-c2 |
| Lakes and ground cover | terrain, streets, visual | verify-terrain, verify-streets (flood fill) | h1 C4, critic c5 and scene P |
| Network continuity, every street driven | streets (graph), play (routes) | verify-play (configuration space) | critic c2: all 15,282 edges, 26,792 runs |
| On foot: grades, stairs, buried walls | play, houses | verify-houses, verify-play | critic c3 (all 170 pedestrian edges), h1 C6 |
| World edge and shore | terrain, streets, visual, play | all four verifiers | critic c1 (152 km of walls) |
| Far LOD and the streaming ring | terrain (data) | verify-terrain | critic c4 (data and browser) |
| Determinism | play (browser vs Node) | verify-play | critic c6 |
| Night | visual, houses | - | critic scene T |
| Houses feature checklist (15 items) | houses | verify-houses | code unchanged |

# Gaps not closed

- **Districts.** 10 districts were never visited in game or on a route at 7dbb362: Glen Park, Japantown, Lone Mountain/USF, McLaren Park, Outer Mission, Portola, Presidio Heights, Seacliff, Treasure Island and West of Twin Peaks. They are covered only by the citywide data checks and the head drive, walk and seam sweeps. The gate's screenshot tour adds the hill districts among them.
- **Walker on cliffs.** `stepFoot` has no maximum grade, so a walker can climb Lands End or a freeway trench wall. Not measured.
- **Pier sheds on foot.** The walls make every pier building unreachable on foot. Not quantified per pier.
- **The streaming ring.** No full tour at the default radius across all districts: 3 borders and 3 Twin Peaks views only. SwiftShader frames at radius 1500 took more than 30 s.
- **The static web build.** The packs from `pnpm build` were not built or checked, because building writes into the checkout.
- **Traffic near players only.** Continuity when a player drives fast into a new area was not tested.
- **The MacArthur tunnel** profile figures were not reproduced (STR-04).
- **Unflattened lakes.** Mountain Lake, Lily Pond and Lloyd Lake are not flattened in the DEM, so they need outline data before they can be tested.
- **No head re-shoots** of the house and landmark street views; the code and footprints are unchanged.

# Appendix A: refuted and corrected claims

No finding was refuted outright. These sub-claims were refuted or could not be reproduced:

1. **BLD-04, "Park Tower missing".** Refuted. 250 Howard is record 201006.0002719, drawn at 173.5 m from assessor storeys; it is published at 167.6 m to the roof and 184.4 m architectural. The auditor's record 0000372 is a 1928 8-storey building.
2. **BLD-04 and BLD-03, "The Avery at 37.78726,-122.39626".** That point is 33 Tehama. Both buildings are missing; The Avery is at 37.787902,-122.394360.
3. **BLD-03, Oceanview block 7148.** Weak evidence: only 4 points are more than 25 m from a footprint, and 38 of 70 lie inside one.
4. **BLD-01, Kearny St c7751000 blocked.** Refuted. The car scrapes along 201006.0003408 and reaches the end, on head too.
5. **TER-03, "the car drives into the bay and gets stuck".** Refuted.
   - Pier 50 Vly stops on a building that overlaps its centreline (W-01), and Al Scoma Way's stall is a side contact.
   - Pier 45 Vly and Unnamed 42 complete.
   - Severity lowered from blocker to high.
6. **STR-04, MacArthur tunnel figures** (ribbon 51 to 92 m between portals at 85 m). Not reproduced: vertex sampling gives 37.7 to 78.8 m.
7. **FC-VIS-01, the Ocean Beach strip and YBI "cliffs".** Refuted: the drops are 0.5 m and 1.9 m.
8. **HOUSES-13, "rows merged into one footprint".** Refuted as framed. The examples are single terraced condo complexes (60, 65 and 88 units).

**Severity changes:**
- **Lowered:** STR-02, blocker to high (the car never falls through); TER-03, blocker to high; PC-03, high to medium (passable off the centreline); STR-14, medium to low; PC-07, medium to low by its verifier (kept at high in W-22 by majority).
- **Raised:** BLD-06, high to blocker; FC-VIS-10, medium to high; TER-11, medium to high.

**Number corrections:**
- BLD-13: the worst case is 509 m², not 938.
- BLD-02: the Broadway route crosses 31 footprints, not 2.
- TER-05: the headline 6.4% counted millimetre floats; visible sink is 1.6 to 2.9%.
- FC-VIS-02: the shares are lower by area (5.6% over 0.3 m).
- PC-02: 235 edges, not 239.
- PC-04: 20 trenches and 9 humps over 3 m, not 41 and 13, and Richland is about 15 m deep.
- HOUSES-05: 61 to 63%, not "every" house.

# Appendix B: scripts and outputs

- **Audits:**
  - `buildings/01-completeness.mjs` to `16-street-front-level.mjs`
  - `terrain/` (and verify-terrain `v*.ts`)
  - `streets/`
  - `visual/` (plus `visual/contact-sheet.png`)
  - `houses/01-inventory.ts` to `25-plan-walker-view.ts`
  - `play/`
- **Verifications:** `verify-buildings/v01` to `v13`, `verify-terrain/v0` to `v13`, `verify-streets/v-*.mjs`, `verify-visual/`, `verify-houses/v01` to `v16`, and `verify-play/r3/pc01.mjs` to `pc07cell.mjs`, `ramlaunch.mjs`, `launchdbg.mjs`, `richland2.mjs` and `browser.mjs`.
- **Critic (head):** `critic/c1-walls-*.mjs`, `c1-launch-replay.mjs`, `c2-drive-all.mjs`, `c2-analyze.mjs`, `c3-walk-ped.mjs`, `c3-clearance.mjs`, `c4-far-ring.mjs`, `c4-far-hulls.mjs`, `c4-prep.mjs`, `c4-browser.mjs`, `c5-parks.mjs` and `c6-determinism.mjs`. The shared loader is `critic/lib.mjs`.
- **Lead (head):**
  - `synth/h0-data-diff.mjs`: tile data diff 7dbb362 to head.
  - `synth/h1-head-sim.mjs`: records, teleport, overlap launch, ram launch, Lake Merced, Richland, walker, freeway traffic.
  - `synth/h2-towers.mjs`: the 64 added towers.
  - `synth/q-c2.mjs`: queries of the critic's drives by edge.
  - `synth/coverage.mjs`
  - `synth/shots-map.mjs`: screenshot index per finding, in `shots-map.json`.

  Logs and JSON sit beside each script.

# Fix plan by owner, in priority order

This plan covers every open blocker, high and medium defect. Tracks are as in `CLAUDE.md`.

## Sim (Sim-World)

1. **W-06, W-23, W-51,** and the car half of **W-05.**
   - `stepCar` never takes vertical speed from a collision or wall push.
   - The per-tick push is capped at speed·DT + 0.5 m.
   - A body behind a wall is pushed back to the side it came from.
2. **W-07.** Cut wall gaps for gradeSeparated edges whose ends are both on land (I-280 at Mission Creek and Islais Creek).
3. **W-21.** Kerb rails along every gap road where its ground is water.
4. **W-05** (walker) and **W-01** (sim half). A building blocks a body only within [underside, topY], and a walker skips a building whose roof is below its feet.
5. **W-22.** `groundHeight` uses the mesh's triangle split. Bump `SIM_VERSION` and say so.
6. **W-02, W-03, W-11, W-12, W-13, W-14** (sim half). `surfaceHeight(x, z, yHint)` reads tunnels, decks and road profiles as the pipeline emits them, and lakes become water.
7. **W-52.** Walker vertical state: an additive contract change.

## Pipeline

1. **W-01, W-39, W-43.** A carriageway and path clearance pass.
   - Undersides for spanning structures (Transit Center, Moscone): this needs an `underY` collider field, a contract change.
   - Drop redeveloped 2010 footprints.
   - Re-register centrelines.
   - Hand-author Lombard.
2. **W-05, W-28.** Terraced footprints: no roof under the ground and no single roof over more than 4 m of relief.
3. **W-02.** A tunnel flag, and bore ribbons with ceilings (the `tunnels` schema).
4. **W-03, W-12, W-14, W-09, W-10, W-31, W-32, W-07** (deck part). The road-profile and deck layer:
   - Freeway decks, creek bridges and overpasses.
   - The 2 m road profile.
   - Ribbons draped from the shared surface.
   - Junction polygons.
5. **W-04.** A newer-buildings pass, plus overrides for Mission Rock, Transbay and Chase Center.
6. **W-16.** Drop the Fort Point and 1st St phantom towers.
7. **W-11, W-18, W-34.** Ground classes (water with its level, grass, forest, sand) and a foliage node.
8. **W-13, W-35.** Pier decks and seawall faces.
9. **W-17, W-40, W-41.** The far layer: shared border samples, skirts, the full outside ring, and hulls clipped to footprints.
10. **W-15, W-29.** Storey heights and the street-level anchor (house kit K0 and K2 data).
11. **W-30.** Simple rings.
12. **W-33.** Stairs as pedestrian `stairs` edges.
13. **W-36.** Topology-preserving simplification.
14. **W-37, W-38, W-46 to W-50** (data). Wall classes and anchor lists (house kit K1, K3 to K8).
15. **W-42.** Implement the Daly City strip decision.

## Render (Render-World)

1. **W-17, W-40** (render half). Skirts on near-ground borders and on the far terrain, so the sea never shows through the ring.
2. **W-18, W-11, W-34.** Colour by ground class; inland water planes at their level; foliage instancing. Drop the district tint, and never tint water.
3. **W-44.** Prop placement with road, footprint and water clearance.
4. **W-45.** Sidewalks for sf tiles.
5. **W-15, W-48** (shader), then **W-46, W-37, W-47, W-49, W-50, W-38.** House kit K2 and K4 first, then K1, K3, K5 to K9, in the order of `house-kit-spec.md`.

## Assets

1. **W-25.** A Sutro Tower proxy and far silhouette.
2. **W-24.** Golden Gate and Bay Bridge far silhouettes, with legal review of the GGB brief.
3. **W-27.** Interim shapes and models: Transamerica, City Hall dome, Coit, Palace of Fine Arts, Grace Cathedral; a Dragon Gate prop; the Sutro Baths ruins.
4. **W-49, W-50, W-38.** Bay-window, stoop and roof-prop prototypes (house kit K6, K7, K8).
5. **W-33.** Stair geometry or texture.

## Content

1. **W-37.** The Painted Ladies override list and the era and district palettes.
2. **W-27** and **L-04.** Places-table probes and landmark tags.
3. **W-42.** The design decision on the Daly City strip, with the design owner.

## Harness

1. Land `world-continuity-gate.md`:
   - The baseline file `tests/golden/world-qa-baseline.json`.
   - The per-PR and nightly jobs, with the ratchet.
   - The screenshot-tour script.
