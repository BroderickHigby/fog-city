# World QA: status on head 54ee728

> **Evidence files.** The scripts, outputs and screenshots this document names (paths such as `critic/c2-drive-all.mjs`, `synth/h1-head-sim.mjs` or `houses/shots/h03-sunset-30th.png`) lived in the QA run's scratch space (`qa-world/`, outside the repository) and are not committed. The numbers quoted from them are the record; the gate (`world-continuity-gate.md`) re-measures them in the repository's own tests.

The six audits and their verifications measured build 7dbb362 (a read-only checkout of integrate/citywide). The completeness critic measured head 54ee728 (a read-only checkout of integrate/wave1). This file records, for every verified blocker, high and medium finding and every critic finding, whether it still holds on head.

There are 52 consolidated defects (W-01 to W-52). Each lists the audit IDs it merges. The full write-up of each defect is in `world-qa-report.md`.

## Result

| Severity | Defects | Fixed on head | Partly fixed | Open on head |
|---|---|---|---|---|
| Blocker | 8 | 1 (W-08 world edge) | 0 | 7 |
| High | 19 | 3 (W-19 car pitch and roll, W-20 far LOD drawn, W-26 Sutro slab) | 1 (W-18 ground cover) | 15 |
| Medium | 25 | 0 | 2 (W-35 drawn seawall, W-52 walker drops) | 23 |
| Total | 52 | 4 | 3 | 45 |

- **Fixed on head:** 4.
- **Open on head:** 48. This counts every defect that is not fully fixed, partly fixed ones included.

Head's runtime changes (walls, the far layer, the Sutro placeholder) introduce 2 new blockers (W-06, W-07) and 3 new high defects (W-17, W-21, W-25). They also make 2 medium defects visible that were latent in the data (W-40, W-41).

W-39 (stairways blocked on foot) was first measured at head, but the footprints that block the stairways are unchanged since 7dbb362.

Low findings are listed in the report with a status, but they are left out of these counts.

## What changed between 7dbb362 and head

There are 15 commits (`git log 7dbb362..54ee728`).

**Data.** Measured by `synth/h0-data-diff.mjs`, output in `h0-data-diff.json` and `h0-data-diff.log`.
- 97 files under `public/tiles/sf` changed: 42 colliders, 42 tile GLBs, 10 far GLBs, the manifest, `report.json` and `world.colliders.bin`.
- Each of the 42 changed colliders was compared value for value against `git show 7dbb362:<file>`.
  - Ground heights changed in 0 tiles and water flags in 0 tiles.
  - 0 footprints changed and 0 records were removed.
  - 64 `-tower` records were added and 67 records lowered.
- Commit 8eb43aa adds the canopy guard on condos, which brings back two-tier condo towers. Among them:
  - One Rincon Hill, 201006.0000534-tower, 182.2 m.
  - The Four Seasons residences, 201006.0000321-tower, 130.1 m.
  - 8 more towers between 43 and 86 m.
- Commit 74c473b turns the three Sutro records into 3 m placeholder plinths and keeps Mission Dolores' 39 m bell tower.
- `roads.json`, `boundary.json`, `districts.json` and `sidewalks.json` are byte-identical.

So every terrain, road, footprint, pier, lake, tunnel and freeway finding rests on unchanged data. Its measurements still apply unless runtime code changed how that data is used.

**Runtime code that changed** (read from the diffs):
- `src/sim/boundary.ts` is new: walls from `boundary.json`, with gaps cut for surface roads only.
- `src/sim/collide.ts` adds wall pushes for the car box and the walker circle. The building rule is unchanged: a car skips a building while `y >= topY`, and a walker collides with every footprint.
- `src/sim/world.ts` adds the pack-aligned `groundHeight`. It is still bilinear, and the sim still does not read water.
- `src/sim/roads.ts` takes freeways and their ramps out of the robotaxi and walker graph.
- `src/sim/foot.ts` adds wall checks on getting in and out of a car.
- `src/render/far-layer.ts` (new) draws the far layer; `parks.ts` (new) tints 4 park districts.
- `src/render/actors.ts` applies pitch and roll to the car.
- `src/render/water.ts` places the sea plane at manifest sea level.
- `src/render/tile-streamer.ts` adds one GLB retry.
- `src/render/scene.ts` sets a 20 km far plane.

These files are byte-identical to 7dbb362: `src/sim/car.ts`, `step.ts` and `contract.ts`; `src/render/tile-geometry.ts`, `materials.ts`, `roads.ts` and `props.ts`; `pipeline/lib/mesh.ts`, `far.ts`, `roads.ts`, `terrain.ts` and `glb.ts`.

## How each status was decided

| Basis | Meaning |
|---|---|
| **re-run** | A reproduction re-run on head under the heavy lock: `synth/h1-head-sim.mjs`, output in `h1-head-sim.json` and `h1-head-sim.log`. It loads the world as the game boots it (collider pack + `roads.json` + `boundary.json` walls, through `critic/lib.mjs`; 583 tiles, 3,865 wall segments; peak RSS 1.8 GB). |
| **critic** | Measured on head by the completeness critic (scripts under `critic/`), and re-queried for the named edges with `synth/q-c2.mjs`. |
| **data** | The input data is identical at head (h0), and the code that turns it into what the player sees or drives is unchanged. |
| **code** | Decided by reading the head code. |

## Consolidated defects and their status on head

| ID | Sev | Owner | Defect | Merges | Status on head | Basis and head evidence |
|---|---|---|---|---|---|---|
| W-01 | blocker | pipeline | Real streets walled by building footprints | BLD-01, PC-02, CR-04, buildings-M1, buildings-M4, play-M6 | **open** | critic + q-c2: 303 edges (40.5 km) blocked, 238 in every allowed direction. Stops at 1st St c105000 (1/58 m), Howard c7038000 (195/279 m), Kearny c7759000 and c7752000, Upper Market c8776102 and c8776203 (both against 201006.0021341), Battery c2757000, Elk c5152000, Houston c7026000, Crescent Ave c4495000/c4496000, Mason St (Presidio), Winston Dr, Walnut St, Clipper Cove Ave. Kearny c7751000 reaches the end (as verify-buildings found). |
| W-02 | blocker | pipeline + sim | Tunnels draped over the hills (Broadway impassable) | BLD-02, TER-01, STR-04, FC-VIS-07, streets-M3, visual-M7, buildings-M7 | **open** | q-c2: Broadway (Robert C Levy Tunl) c3186101 stops at 202/885 m on 201006.0012041 and c3186201 at 91/883 m on 0002781. Stockton Tunl reaches the end both ways, airborne 0.85/0.98 s, landing 7.3 m/s. Toll Plaza Tunnel c19939000 stops at 4/98 m. |
| W-03 | blocker | pipeline + sim | Freeways on the bare ground: the car is stopped by buildings on the freeway, launches, drives through houses | BLD-06, TER-07, STR-03, FC-VIS-06, CR-11, streets-M5 | **open** (traffic part fixed) | critic c2 fwy: 6 runs stuck on buildings, 62 of 220 airborne 0.5 s or more, 35 hard landings. re-run C7: 0 of 110 gradeSeparated edges are open to robotaxis (streets-M5 fixed). |
| W-04 | blocker | pipeline | Post-2010 blocks and towers missing | BLD-03, BLD-04, FC-VIS-10, visual-M6, buildings-M8 | **open** | h0: 0 footprints added. re-run B: the tallest record within 30 m of The Avery's point is 72.6 m (Avery: 188 m), 33 Tehama 47.2 m (35 storeys), Fifteen Fifty's record 201006.0006304 14.6 m (116 m). 706 Mission's parcel point lies in no record; the 130 m tower within 30 m is the Four Seasons (2001). |
| W-05 | blocker | pipeline + sim | Buried hillside buildings: invisible underground walls, cars teleported out, hill through the roof | HOUSES-01, houses-M1, BLD-05, FC-VIS-13 | **open** | re-run B: ground over roof 10.66 m on 201006.0000980 (1,037 m² under ground), 5.46 m on 0000592, 4.64 m on 0000837. re-run C1 (full step()): one-tick teleport 23.49 m at 0000592 and 11.18 m at 0000116, as at 7dbb362. re-run C6: a walker at 0000592 is held 308 ticks outside the footprint, standing above roof level. |
| W-06 | blocker | sim | The water side of every shore wall launches cars 50 to 1,612 m into the sky | CR-02 | **open** (new at head) | critic: 8,137 of 8,958 water-side approaches launch. Replay up the 4th St gap: 126 m at t=200. Node and browser agree. |
| W-07 | blocker | sim + pipeline | I-280 ends in invisible sea walls at Mission Creek and Islais Creek | CR-01 | **open** (new at head) | critic + q-c2: I-280 NB c19300000 stops at 280/831 m, NB c19298000 at 613/1653 m, SB c19338000 at 561/697 m. Browser replay identical. |
| W-08 | blocker | sim | No world edge: cars and walkers leave the world, 181 to 201 m drop at the county line, open water is a solid floor | PC-01, TER-02, STR-01, FC-VIS-01, terrain-M1, visual-M2, buildings-M5 | **fixed** (residual: W-06, W-21) | critic: 0 of 6,064 ram tests from 758 dry starts every 100 m on all 152 km of walls crossed a real wall or left the built tiles. Escapes remain only through the 22 road gaps (W-21). |
| W-09 | high | pipeline | Car sinks into the drawn road (ribbon vs sim ground) | TER-05, PC-05, FC-VIS-02, buildings-M2, terrain-M3 | **open** | critic browser scene E on head: with pitch now applied, all four wheel bottoms sit 0.29 to 0.32 m under the drawn road on Filbert. data: `mesh.ts` and the terrain are unchanged. |
| W-10 | high | pipeline | Ground mesh pokes through road ribbons | STR-09, FC-VIS-03 | **open** | data: `mesh.ts`, terrain and roads are unchanged. |
| W-11 | high | pipeline + render + sim | Inland lakes are dry, drivable land; at head they are also painted lawn | TER-04, STR-07, FC-VIS-05, streets-M1, visual-M5, CR-06 (lakes) | **open** (worse) | re-run C4 (full step(), walls on): a car drives 625 m across South Lake Merced at y 5.25 to 5.27 m, 0 hits, 28.1 m/s, identical to 7dbb362. critic c5: Stow, Spreckels and Elk Glen surfaces are now tinted grass. |
| W-12 | high | pipeline + sim | Bridges over Mission Creek and Islais Creek dip to sea level | TER-06, STR-02 | **open** | data: the ground under 3rd St, 4th St and Illinois St is unchanged. q-c2: the edges are drivable at posted speed (3rd St c197201 airborne 0.17 s). At head these are wall gaps, so the dip now leads onto the water (W-21). |
| W-13 | high | pipeline + sim | Piers: sheds stand in the water, pier roads at y=0 | BLD-07, TER-03, STR-10, FC-VIS-09, streets-M4 | **open** | data: unchanged. q-c2: Pier 50 Vly c15358000 still stops on 201006.0000020 (398/429 m). At head the shore walls make the pier aprons unreachable except through the pier-road gaps (W-21). |
| W-14 | high | pipeline | Streets crossing freeways, rail cuts and creeks launch the car | PC-04, play-M7, TER-07 (overpass dips) | **open** | re-run C5: the Richland Ave profile is identical (73.6 to 58.7 to 71.0 m). At 16 m/s eastbound: 1.65 s airborne, 4.41 m up, landing 16.5 m/s. At 20 m/s westbound: 17.81 m up. |
| W-15 | high | pipeline + render | Houses drawn with 5 to 8 m storeys | HOUSES-05, BLD-12 | **open** | data + code: facade code is unchanged, and the storeys of the 67 changed records are unchanged except Mission Dolores (stories cleared). |
| W-16 | high | pipeline | Phantom LiDAR towers: 68 m on 1st St, 65 m block on Fort Point | buildings-M4, HOUSES-02 (Fort Point) | **open** | re-run B: 201006.0000060-tower topY 73.33 (68.1 m) on 1st St. 201006.0000856-tower topY 69.32 (64.6 m) on Fort Point. |
| W-17 | high | pipeline + render | Streaming-ring seam: near and far terrain step up to 21.5 m and the sea shows through | CR-05, TER-09 | **open** (new visible at head) | critic c4: p99 7.43 m, max 21.45 m. The far side is more than 1 m higher along 82.7 km. The live scene matches. |
| W-18 | high | pipeline + render | Ground cover: parks bare grey, no foliage, beaches and lakes painted lawn | STR-06, FC-VIS-04, houses-M3, CR-06 | **partly** | 54ee728 tints 4 park districts green. critic c5: 603 of 1,379 ha of park land is green (43.7%), and 240 of 253 properties are under 10% green. 0 foliage nodes. 32.6 ha of shore is painted grass. |
| W-19 | high | render | Car drawn level on hills | PC-06, visual-M1 | **fixed** | critic scene E: rotation.x 0.309 rad (17.7 degrees) on Filbert, matching the sim, with roll applied (order YXZ). |
| W-20 | high | render | Far LOD not drawn | TER-08, STR-17, FC-VIS-08 | **fixed** (new defects W-17, W-40, W-41) | critic scene T: the far skyline renders day and night; 41 tiles + 33 far cells, 0 failed; far plane 20 km; sea plane 42 km. |
| W-21 | high | sim + pipeline | Gaps cut in the sea wall for pier and bridge roads let cars and walkers out onto the Bay | CR-03 | **open** (new at head) | critic: 22 gaps for 11 roads. 26 of 36 turn runs got more than 20 m out. Through Pier 45 Vly a car got 1,213 m out on open water. |
| W-22 | high | sim | Render ground (triangles) and sim ground (bilinear) disagree off-road by up to 4.37 m | BLD-08, TER-11, STR-08, PC-07 | **open** | code: `groundHeight` is still bilinear (`world.ts` heightIn). data: the mesh triangulation is unchanged. |
| W-23 | high | sim | Ramming a building on a hill launches the car | play-M1 | **open** | re-run C3 (same seed and rule as verify-play): 176 of 360 rams launch (7dbb362: 169). Russian Hill 50, west of Twin Peaks 74, Bernal 52. Worst 27.1 m up (201006.0007825-tower, 37.80012,-122.42150). |
| W-24 | high | assets | Golden Gate Bridge and Bay Bridge absent; approaches end at the shore | STR-05, HOUSES-02 (bridges), visual-M3, terrain-M2 | **open** | code: `content/landmarks.json` has 2 entries (ferry-building, r-evolution). At head the I-80 and Hwy 101 approaches stop at uncut walls (critic c1 static, 4 freeway edges) instead of running onto the water. |
| W-25 | high | assets + pipeline | Sutro Tower absent: three 3 m plinths, no model | CR-07 | **open** (new at head) | re-run B: 201006.0009087, 0062170 and 0168289 stand 2.8 to 3.4 m above the ground, heightSource override. |
| W-26 | high | pipeline | Sutro Tower drawn as a solid 231 m slab | BLD-09, HOUSES-03 | **fixed** (replaced by W-25) | re-run B: the slab is gone (topY 486.54 → 258.06). |
| W-27 | high | assets + pipeline | Hero landmarks read as office boxes; Dragon Gate and Sutro Baths absent; Coit 20% short | HOUSES-04, buildings-M3, BLD-17 (Coit), houses-M4, FC-VIS-14 | **open** | re-run B: Coit 201006.0006230-tower is still 51.25 m (published 64 m). Mission Dolores now keeps its 39.25 m bell tower (74c473b), a partial shape fix. Nothing else changed. |
| W-28 | medium | pipeline | Large hillside buildings are one flat prism over up to 30 m of relief | BLD-10, HOUSES-13 | **open** | h0: 201006.0001291 and 0000739 now have a tower record, and their podium dropped 3 m. The downhill cliff wall (24 to 27 m) remains. |
| W-29 | medium | pipeline | First-storey line from the centroid's ground, not the street | BLD-11 | **open** | data + code |
| W-30 | medium | pipeline | Self-intersecting tower rings draw double roofs and slabs outside walls | BLD-13 | **open** | re-run B: 201006.0000174-tower is unchanged (topY 76.53). |
| W-31 | medium | pipeline | 10 m lattice bumps on cross-slope roads; no 2 m road-profile pass | TER-10 | **open** | data |
| W-32 | medium | pipeline | Junction ribbons overlap and z-fight | STR-11 | **open** | data + code |
| W-33 | medium | pipeline | Stairways dropped, or drawn as smooth ramps the car drives | STR-13, PC-08 | **open** | data: `roads.json` is identical |
| W-34 | medium | pipeline + render | Beaches are grey; at head some are painted lawn | STR-15 | **open** | critic c5: Baker Beach and the Crissy shore are tinted grass |
| W-35 | medium | pipeline + render | No seawall drawn; the shoreline is a 10 m staircase; the Embarcadero promenade ramps into the Bay | STR-16 | **partly** | The sim walls now stop cars at the shore (critic). Nothing is drawn: data and mesh are unchanged. |
| W-36 | medium | pipeline | Cracks of 5 to 60 cm between row houses | HOUSES-06 | **open** | h0: footprints identical |
| W-37 | medium | pipeline + content | One facade class, washed-out palette, Painted Ladies like any row | HOUSES-12 | **open** | code |
| W-38 | medium | pipeline + assets | Every roof flat at the LiDAR ridge height: no gables, parapets, cornices or rooftop kit | houses-M2, HOUSES-14 | **open** | code |
| W-39 | medium | pipeline | 33 public stairways and paths blocked on foot by footprints | CR-08 | **open** (first measured at head) | critic c3 |
| W-40 | medium | pipeline | No far terrain beyond the south-edge tiles t-16_21, t-4_21, t-3_21 and t7_-5; the city edge floats over the sea | CR-09, play-M4, play-M5 | **open** | critic c4: 0% far coverage in the 4 tiles |
| W-41 | medium | pipeline | Far skyline pops when tiles stream in (hulls up to 122 m too tall; 690 records with no hull) | CR-10 | **open** (new visible at head) | critic c4-far-hulls |
| W-42 | medium | pipeline | 1,356 Daly City buildings on a strip south of the county line with no streets | visual-M4 | **open** | data. At head the strip lies inside the walls. |
| W-43 | medium | pipeline | Lombard: the centreline cuts into 201006.0021655 at the top approach | PC-03 | **open** | q-c2: c8449000 stops at 50/82 m on 0021655, and the crooked block c8448000 stops at 14/144 m on 0020610 for a road-following car. |
| W-44 | medium | render | Street trees and lamps stand in roadways and inside buildings | STR-12, FC-VIS-11 | **open** | code: `src/render/roads.ts` (streetTreeSpots, streetlightSpots) is unchanged |
| W-45 | medium | render | No sidewalks drawn anywhere in the sf world | streets-M2 | **open** | code: tile-streamer still builds fallback roads (with sidewalks) only when the GLB lacks a roads node |
| W-46 | medium | render + pipeline | Facades have no front: the same grid on fronts, party walls and rear walls | HOUSES-07 | **open** | code |
| W-47 | medium | render | Storefronts are not rendered | HOUSES-08 | **open** | code: `storefronts.json` is read only by `src/content`, never by the renderer |
| W-48 | medium | render | No garage doors on the Sunset, Richmond and Marina rows | HOUSES-09 | **open** | code |
| W-49 | medium | render + assets | No bay windows | HOUSES-10 | **open** | code |
| W-50 | medium | render + assets | No stoops or entry stairs; blank plinths up to a storey tall | HOUSES-11 | **open** | code |
| W-51 | medium | sim | A car placed overlapping a footprint launches 144 to 178 m (respawn, teleport, mission placement) | play-M2 | **open** | re-run C2: Congdon St moves 4.47 m in the first tick, vy 59.2 m/s, 178.0 m up. Market St at Octavia: 7.53 m, 144.1 m up. Octavia St: 30.9 m up. |
| W-52 | medium | sim | The walker has no vertical state: any drop is a one-tick teleport | play-M3 | **partly** | The 181 m county-line case is no longer reachable (walls). code: `stepFoot` still sets y = groundHeight with no fall and no grade limit. |

## Every source finding, mapped

**Verified blocker, high and medium findings** (final severity after verification):
- **Buildings:**
  - W-01: BLD-01 (blocker)
  - W-02: BLD-02 (blocker)
  - W-04: BLD-03 (blocker), BLD-04 (high; partly verified: the Park Tower part is refuted)
  - W-05: BLD-05 (high)
  - W-03: BLD-06 (blocker, raised from high)
  - W-13: BLD-07 (high, partly)
  - W-22: BLD-08 (high, partly)
  - W-26: BLD-09 (high)
  - W-28: BLD-10 (medium)
  - W-29: BLD-11 (medium)
  - W-15: BLD-12 (medium; merged at high)
  - W-30: BLD-13 (medium)
- **Terrain:**
  - W-02: TER-01 (blocker)
  - W-08: TER-02 (blocker)
  - W-13: TER-03 (high, partly; lowered from blocker)
  - W-11: TER-04 (high)
  - W-09: TER-05 (high)
  - W-12: TER-06 (high)
  - W-03: TER-07 (high)
  - W-20: TER-08 (high)
  - W-17: TER-09 (medium; merged at high)
  - W-31: TER-10 (medium)
  - W-22: TER-11 (high, partly; raised from medium)
- **Streets:**
  - W-08: STR-01 (blocker)
  - W-12: STR-02 (high, partly; lowered from blocker)
  - W-03: STR-03 (high)
  - W-02: STR-04 (high)
  - W-24: STR-05 (high)
  - W-18: STR-06 (high)
  - W-11: STR-07 (high)
  - W-22: STR-08 (high)
  - W-10: STR-09 (high)
  - W-13: STR-10 (high)
  - W-32: STR-11 (medium)
  - W-44: STR-12 (medium)
  - W-33: STR-13 (medium)
  - STR-14: lowered to low (L-09)
  - W-34: STR-15 (medium)
  - W-35: STR-16 (medium)
  - W-20: STR-17 (medium)
- **Visual:**
  - W-08: FC-VIS-01 (blocker)
  - W-09: FC-VIS-02 (high)
  - W-10: FC-VIS-03 (high)
  - W-18: FC-VIS-04 (high)
  - W-11: FC-VIS-05 (high)
  - W-03: FC-VIS-06 (high)
  - W-02: FC-VIS-07 (high)
  - W-20: FC-VIS-08 (high)
  - W-13: FC-VIS-09 (medium)
  - W-04: FC-VIS-10 (high, raised from medium)
  - W-44: FC-VIS-11 (medium)
- **Houses:**
  - W-05: HOUSES-01 (blocker)
  - W-24 + W-16: HOUSES-02 (high)
  - W-26: HOUSES-03 (high)
  - W-27: HOUSES-04 (high)
  - W-15: HOUSES-05 (high)
  - W-36: HOUSES-06 (medium)
  - W-46: HOUSES-07 (medium)
  - W-47: HOUSES-08 (medium)
  - W-48: HOUSES-09 (medium)
  - W-49: HOUSES-10 (medium)
  - W-50: HOUSES-11 (medium)
  - W-37: HOUSES-12 (medium)
  - W-28: HOUSES-13 (medium, partly)
- **Play:**
  - W-08: PC-01 (blocker)
  - W-01: PC-02 (blocker)
  - W-43: PC-03 (lowered to medium, partly)
  - W-14: PC-04 (high)
  - W-09: PC-05 (high)
  - W-19: PC-06 (high)
  - W-22: PC-07 (partly; lowered to low by its verifier, merged at high)

**Verifiers' missed items:**
- **Buildings:**
  - W-01: buildings-M1, buildings-M4 (also W-16)
  - W-09: buildings-M2
  - W-27: buildings-M3
  - W-08: buildings-M5
  - L-03: buildings-M6
  - W-02: buildings-M7
  - W-04: buildings-M8
- **Terrain:**
  - W-08: terrain-M1
  - W-24: terrain-M2
  - W-09: terrain-M3
  - terrain-M4 is a pass (summits within 1.5 m of the DEM)
- **Streets:**
  - W-11: streets-M1
  - W-45: streets-M2
  - W-02: streets-M3
  - W-13: streets-M4
  - W-03: streets-M5 (fixed part)
- **Visual:**
  - W-19: visual-M1
  - W-08: visual-M2
  - W-24: visual-M3
  - W-42: visual-M4
  - W-11: visual-M5
  - W-04: visual-M6
  - W-02: visual-M7
- **Houses:**
  - W-05: houses-M1
  - W-38: houses-M2
  - W-18: houses-M3
  - W-27: houses-M4
- **Play:**
  - W-23: play-M1
  - W-51: play-M2
  - W-52: play-M3
  - W-40: play-M4, play-M5
  - W-01: play-M6
  - W-14: play-M7

**Critic findings (all measured on head):**
- W-07: CR-01
- W-06: CR-02
- W-21: CR-03
- W-01: CR-04
- W-17: CR-05
- W-18: CR-06
- W-25: CR-07
- W-39: CR-08
- W-40: CR-09
- W-41: CR-10
- W-03: CR-11

No finding was refuted outright. Eight sub-claims were refuted or corrected; they are listed in the report's appendix.

## Improvements on head that no finding asked for

- 64 tall condo and steeple towers are back, through the canopy guard on condos (8eb43aa) and keepTower (74c473b):
  - One Rincon Hill, 182.2 m.
  - Four Seasons, 130.1 m.
  - Mission Dolores' bell tower, 39.0 m.

  The buildings audit had left One Rincon Hill "not resolved" in its notes.
- Terrain determinism at head (critic c6), all pass:
  - The pack equals the JSON on all 583 tiles.
  - 219,693 border samples agree.
  - Three 60 s step() runs with 330 agents hash identically.
- All 8 multiplayer spawn slots at the SF spawn are clear (critic c6).

## Not rechecked on head, and why

- **Browser views of the house and landmark shots** (W-15, W-27, W-36, W-37, W-38, W-46 to W-50). Not re-shot. The facade, material and geometry code, and the footprints, are byte-identical. Only 67 heights changed, none in the shot blocks.
- **Render-level ribbon and ground statistics** (W-09, W-10, W-22). Not re-sampled across the city. Their inputs (terrain, `roads.json`, `mesh.ts`) and the sim's `groundHeight` are unchanged. The critic re-measured W-09 in the browser on Filbert.
- **The far-terrain silhouettes at the far-layer bounds** (Marin cut at z = -4500, San Bruno Mountain missing; part of TER-09). `far.ts` is unchanged, and the far GLBs changed only in building records. They are covered by W-17 and W-40 but not re-measured.
- **Static web build packs** (`pnpm build`). Not built, because building writes into the read-only checkout (as the critic noted).

## What moved between 54ee728 and 544f67c

The gate measured the world again at 544f67c, the integration head after de02d2f (two-sided
walls, kerbed corridors for roads over water, no lift from pushes), c35f2d3 (the far terrain
stitched to the city's outer edge) and 7c4028a (traffic off every ramp that leads to a freeway).
Three statuses moved:

- **W-21 fixed.** Every road over water is now a walled corridor: 0 of 156 car runs turning
  30, 60 or 90 degrees off it at 10 and 25 m/s, and 0 sprinting walkers, leave it.
- **W-06 partly fixed.** The water side no longer throws cars hundreds of metres up (1,612 m at
  head), but 98 of 1,182 sampled approaches (every 50 m of shore, 2.5 and 6 m out, 5/15/30 m/s)
  still rise more than 1 m, up to 8.9 m, on the lattice's slope at the shore.
- **W-51 partly fixed.** A car placed over a footprint no longer launches (it rises at most
  0.34 m), but is still pushed out of it by up to 23.2 m in one tick.

W-23 stays open: the push unit test passes, but 211 of 360 seeded hill rams still leave the car
airborne for more than 0.3 s or lift it more than 0.5 m. Everything else measured as at head.

<!-- gate-status:start (generated from tests/golden/world-qa-baseline.json by scripts/golden/world-docs.ts) -->
## Status at 544f67c: the gate's baseline

The world-continuity gate (`world-continuity-gate.md`) measures every defect on the committed world. Each defect's status is kept in `tests/golden/world-qa-baseline.json` (the lane that fixes it flips it there); its metrics give the value at 544f67c and the target that becomes a hard assertion once it is marked fixed.

| Severity | Defects | Fixed | Partly | Open |
|---|---|---|---|---|
| blocker | 8 | 1 | 1 | 6 |
| high | 19 | 4 | 1 | 14 |
| medium | 25 | 0 | 3 | 22 |

| ID | Sev | Status | Defect | Metrics: baseline (target) |
|---|---|---|---|---|
| L-01 | low | **open** | 23 duplicate and 24 coplanar-roof footprint pairs z-fight. | `A.rings.coplanarRoofs` 24 (<= 0); `A.rings.duplicates` 23 (<= 0) |
| L-02 | low | **open** | Wall bottoms float 5 to 25 cm above the drawn ground on 38 buildings. | `N.glb.floatingWallBottoms` 2 (<= 0) |
| L-03 | low | **open** | Two buildings straddle the south edge and hang over the void: 201006.0017547 by 118.6 m (37.705434,-122.462201) and 0008708 by 16.4 m (37.705490,-122.416322). | `A.ground.wallBottomAboveGround` 2 (<= 0); `N.glb.floatingWallBottoms` 2 (<= 0) |
| W-01 | blocker | **open** | Real streets walled by building footprints | `C.clearance.carriagewayEdges` 384 (<= 0); `F.named.runsStopped` 31 (<= 0); `F.routes.stopped` 2 (<= 0); `F.sample.runsStopped` 11 (<= 0); `N.streets.districtMinReachedShare` 0.843 (>= 0.995); `N.streets.mainlandStartBlocked` 47 (<= 0); `N.streets.mainlandStuck` 385 (<= 0) |
| W-02 | blocker | **open** | Tunnels draped over the hills (Broadway impassable) | `C.tunnels.broadwayAbovePortalLineM` 49.68 (<= 1); `C.tunnels.insideFootprintsM` 578 (<= 0); `C.tunnels.unflagged` 7 (<= 0); `F.named.runsStopped` 31 (<= 0); `F.tunnels.failingRuns` 6 (<= 0) |
| W-03 | blocker | **open** | Freeways on the bare ground: the car is stopped by buildings on the freeway, launches, drives through houses | `C.freeway.insideFootprintsM` 435 (<= 0); `C.freeway.maxGradePct` 143.22 (<= 6); `C.freeway.separatedCrossingsShare` 0 (>= 1); `E.freeway.i280Stops` 2 (<= 0); `N.freeways.airborneRuns` 96 (<= 0); `N.freeways.hardLandings` 76 (<= 0); `N.freeways.stuckRuns` 17 (<= 0); `N.glb.freewayUnderGroundShare` 0.105 (<= 0) |
| W-04 | blocker | **open** | Post-2010 blocks and towers missing | `A.newer.cells3` 13 (<= 0); `A.newer.missionRockTall` 0 (>= 4); `A.newer.publishedHeightFails` 4 (<= 0); `A.newer.unmatched` 122 (<= 10) |
| W-05 | blocker | **open** | Buried hillside buildings: invisible underground walls, cars teleported out, hill through the roof | `A.ground.lowAboveGround` 83 (<= 0); `A.ground.roofUnderGround` 22 (<= 0); `F.buried.carMaxJumpM` 23.15 (<= 0.5); `F.buried.walkerLowWallStops` 29 (<= 0) |
| W-06 | blocker | **partly** | The water side of every shore wall launches cars 50 to 1,612 m into the sky | `E.launch.maxRiseM` 8.94 (<= 1); `E.launch.sampleLaunches` 98 (<= 0); `E.push.excessLiftMps` 0 (<= 0); `N.walls.launches` 668 (<= 0); `N.walls.maxRiseM` 22.04 (<= 1) |
| W-07 | blocker | **open** | I-280 ends in invisible sea walls at Mission Creek and Islais Creek | `E.freeway.i280Stops` 2 (<= 0); `E.freeway.landEdgesCrossingWalls` 3 (<= 0); `N.freeways.stuckRuns` 17 (<= 0) |
| W-08 | blocker | **fixed** | No world edge: cars and walkers leave the world, 181 to 201 m drop at the county line, open water is a solid floor | `E.walls.sampleEscapes` 0 (<= 0); `N.walls.escapes` 0 (<= 0) |
| W-09 | high | **open** | Car sinks into the drawn road (ribbon vs sim ground) | `C.profile.edgesWithoutProfile` 1 (<= 0); `G.carPose.wheelGapM` 3.9 (<= 0.1); `N.glb.roadSunkShare` 0.039 (<= 0); `N.glb.roadSurfaceMaxM` 3.84 (<= 0.05); `N.glb.roadSurfaceP99M` 0.497 (<= 0.05) |
| W-10 | high | **open** | Ground mesh pokes through road ribbons | `N.glb.freewayUnderGroundShare` 0.105 (<= 0); `N.glb.groundThroughRoadsShare` 0.02 (<= 0) |
| W-11 | high | **open** | Inland lakes are dry, drivable land; at head they are also painted lawn | `B.lakes.dryHa` 78.3 (<= 0); `B.lakes.minWaterShare` 0 (>= 0.9); `D.lakes.drawnGrassHa` 5.06 (<= 0); `F.lake.mercedDrivenM` 620 (<= 10); `G.tour.lakesNotWater` 3 (<= 0) |
| W-12 | high | **open** | Bridges over Mission Creek and Islais Creek dip to sea level | `C.bridges.dippingDecks` 4 (<= 0); `F.bridges.failingRuns` 16 (<= 0); `F.named.runsStopped` 31 (<= 0) |
| W-13 | high | **open** | Piers: sheds stand in the water, pier roads at y=0 | `C.piers.buildingsOnWater` 103 (<= 0); `C.piers.streetsAtSeaLevel` 4 (<= 0) |
| W-14 | high | **open** | Streets crossing freeways, rail cuts and creeks launch the car | `C.freeway.separatedCrossingsShare` 0 (>= 1); `F.crossings.airborneRuns` 66 (<= 0); `F.crossings.richlandAirS` 2.33 (<= 0.2); `F.named.runsStopped` 31 (<= 0); `F.routes.maxAirborneS` 0.83 (<= 0.8); `F.routes.stopped` 2 (<= 0); `N.streets.airborneRuns` 84 (<= 0) |
| W-15 | high | **open** | Houses drawn with 5 to 8 m storeys | `A.facade.storeys5m` 0.611 (<= 0.02) |
| W-16 | high | **open** | Phantom LiDAR towers: 68 m on 1st St, 65 m block on Fort Point | `A.phantom.fortPointHeight` 64.61 (<= 25); `A.phantom.tallOnStreet` 11 (<= 0) |
| W-17 | high | **open** | Streaming-ring seam: near and far terrain step up to 21.5 m and the sea shows through | `G.farRing.seaThroughProbes` 72 (<= 0); `N.far.farAboveNearKm` 83.26 (<= 0); `N.far.ringStepMaxM` 21.57 (<= 2); `N.far.ringStepP99M` 7.44 (<= 1); `N.far.sanBrunoSummitErrorM` 402 (<= 10) |
| W-18 | high | **partly** | Ground cover: parks bare grey, no foliage, beaches and lakes painted lawn | `D.foliage.parkTilesShare` 0 (>= 1); `D.parks.greenShare` 0.437 (>= 0.9); `D.parks.propertiesUnder10pct` 240 (<= 0); `D.shore.drawnGrassHa` 31.07 (<= 0); `G.tour.parksNotGreen` 4 (<= 0); `G.tour.parksWithoutFoliage` 4 (<= 0) |
| W-19 | high | **fixed** | Car drawn level on hills | `G.carPose.pitchErrorDeg` 0 (<= 1) |
| W-20 | high | **fixed** | Far LOD not drawn | `G.far.cellsDrawnFromTwinPeaks` 13 (>= 4) |
| W-21 | high | **fixed** | Gaps cut in the sea wall for pier and bridge roads let cars and walkers out onto the Bay | `E.gaps.carRunsOffCorridor` 0 (<= 0); `E.gaps.maxOutOnWaterM` 0 (<= 1); `E.gaps.walkerRunsOffCorridor` 0 (<= 0) |
| W-22 | high | **open** | Render ground (triangles) and sim ground (bilinear) disagree off-road by up to 4.37 m | `B.groundParity.max` 1.175 (<= 0.02); `B.groundParity.p99` 0.261 (<= 0.02); `F.routes.belowSurfaceM` 0.173 (<= 0.1) |
| W-23 | high | **open** | Ramming a building on a hill launches the car | `E.push.excessLiftMps` 0 (<= 0); `F.ram.launches` 211 (<= 0) |
| W-24 | high | **open** | Golden Gate Bridge and Bay Bridge absent; approaches end at the shore | `A.landmark.bridgesMissing` 2 (<= 0); `G.tour.landmarksMissing` 4 (<= 0) |
| W-25 | high | **open** | Sutro Tower absent: three 3 m plinths, no model | `A.landmark.sutroTowerTopM` 0 (>= 290); `G.tour.landmarksMissing` 4 (<= 0) |
| W-26 | high | **fixed** | Sutro Tower drawn as a solid 231 m slab | `A.landmark.sutroRecordHeight` 3.44 (<= 10) |
| W-27 | high | **open** | Hero landmarks read as office boxes; Dragon Gate and Sutro Baths absent; Coit 20% short | `A.landmark.coitHeightError` 0.199 (<= 0.05); `A.landmark.heroWithoutShape` 10 (<= 0); `G.tour.landmarksMissing` 4 (<= 0) |
| W-28 | medium | **open** | Large hillside buildings are one flat prism over up to 30 m of relief | `A.ground.relief10` 466 (<= 0) |
| W-29 | medium | **open** | First-storey line from the centroid's ground, not the street | `A.facade.firstStoreyOffStreet` 0.111 (<= 0.01) |
| W-30 | medium | **open** | Self-intersecting tower rings draw double roofs and slabs outside walls | `A.rings.nonSimple` 193 (<= 0) |
| W-31 | medium | **open** | 10 m lattice bumps on cross-slope roads; no 2 m road-profile pass | `B.grades.hillsideLatticeFails` 4 (<= 0); `C.profile.edgesWithoutProfile` 1 (<= 0) |
| W-32 | medium | **open** | Junction ribbons overlap and z-fight | `N.glb.doubleRibbonShare` 0.062 (<= 0.005) |
| W-33 | medium | **open** | Stairways dropped, or drawn as smooth ramps the car drives | `C.stairs.carDrivable` 4 (<= 0); `C.stairs.missing` 2 (<= 0); `C.stairs.notMarkedStairs` 4 (<= 0) |
| W-34 | medium | **open** | Beaches are grey; at head some are painted lawn | `D.beaches.sandShare` 0 (>= 0.9); `D.shore.drawnGrassHa` 31.07 (<= 0); `G.tour.beachesNotSand` 2 (<= 0) |
| W-35 | medium | **partly** | No seawall drawn; the shoreline is a 10 m staircase; the Embarcadero promenade ramps into the Bay | `H.seawall.embarcaderoRampShare` 0.94 (<= 0) |
| W-36 | medium | **open** | Cracks of 5 to 60 cm between row houses | `H.cracks.sampleBoxPairs` 291 (<= 0) |
| W-37 | medium | **open** | One facade class, washed-out palette, Painted Ladies like any row | `H.palette.pre1915SaturatedShare` 0 (>= 0.3) |
| W-38 | medium | **open** | Every roof flat at the LiDAR ridge height: no gables, parapets, cornices or rooftop kit | `H.roofs.shapedShare` 0 (>= 0.8) |
| W-39 | medium | **open** | 33 public stairways and paths blocked on foot by footprints | `C.clearance.pedestrianEdges` 62 (<= 0); `F.walk.routesFailing` 6 (<= 0); `N.paths.walksBlocked` 77 (<= 0) |
| W-40 | medium | **open** | No far terrain beyond the south-edge tiles t-16_21, t-4_21, t-3_21 and t7_-5; the city edge floats over the sea | `N.far.outerLandUncovered` 310 (<= 0); `N.far.sanBrunoSummitErrorM` 402 (<= 10); `N.far.uncoveredTilesMinShare` 0 (>= 0.95) |
| W-41 | medium | **open** | Far skyline pops when tiles stream in (hulls up to 122 m too tall; 690 records with no hull) | `N.far.lowHullsP99M` 8.3 (<= 5); `N.far.recordsWithoutHull` 690 (<= 0); `N.far.tallHullsOff3m` 44 (<= 0) |
| W-42 | medium | **open** | 1,356 Daly City buildings on a strip south of the county line with no streets | `E.net.buildingsWithoutStreet` 911 (<= 0) |
| W-43 | medium | **open** | Lombard: the centreline cuts into 201006.0021655 at the top approach | `C.clearance.lombardEdges` 2 (<= 0); `F.named.runsStopped` 31 (<= 0) |
| W-44 | medium | **open** | Street trees and lamps stand in roadways and inside buildings | `C.props.lampsOnRoad` 0.095 (<= 0); `C.props.treesInBuildings` 0.058 (<= 0); `C.props.treesOnRoad` 0.045 (<= 0) |
| W-45 | medium | **open** | No sidewalks drawn anywhere in the sf world | `C.sidewalks.tilesWithoutSidewalks` 547 (<= 0) |
| W-46 | medium | **open** | Facades have no front: the same grid on fronts, party walls and rear walls | `H.walls.frontClassedShare` 0 (>= 0.9) |
| W-47 | medium | **open** | Storefronts are not rendered | `H.storefronts.shopBandShare` 0.081 (>= 0.95) |
| W-48 | medium | **open** | No garage doors on the Sunset, Richmond and Marina rows | `H.garages.anchorShare` 0 (>= 0.9) |
| W-49 | medium | **open** | No bay windows | `H.bays.anchorShare` 0 (>= 0.9) |
| W-50 | medium | **open** | No stoops or entry stairs; blank plinths up to a storey tall | `H.stoops.blankBandOver2_5m` 834 (<= 0) |
| W-51 | medium | **partly** | A car placed overlapping a footprint launches 144 to 178 m (respawn, teleport, mission placement) | `E.push.excessLiftMps` 0 (<= 0); `F.placement.maxJumpM` 23.22 (<= 0.5); `F.placement.maxRiseM` 0.34 (<= 0.5); `N.streets.mainlandStartBlocked` 47 (<= 0) |
| W-52 | medium | **partly** | The walker has no vertical state: any drop is a one-tick teleport | `F.walker.verticalFails` 2 (<= 0) |
<!-- gate-status:end -->
