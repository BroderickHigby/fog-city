# Fog City priorities — 26 October 2026

Current verified main: [66b1e6f5](https://github.com/BroderickHigby/fog-city/commit/66b1e6f51fd1799612d6319980fca7f2241b17a9).
These are remaining implementation and acceptance tasks, not a claim that all
existing features are broken.

See `BUG_EXAMPLES.md` or `GALLERY.html` for the original owner screenshots,
captioned by issue. Preserve resolved fixes and use the images as regression
references; they are not fresh proof that every pictured bug is still present.

| Order | Task | Current gap / completion target |
|---|---|---|
| 1 | Consolidate the 16 old draft PRs | Audit intended scope against main; fix/port/recreate missing work; one final PR, no blind stack merges. |
| 2 | Stable, readable core gameplay | Re-test road/water spawns, traffic contacts, grounded people, missions and saves; address sustained memory/performance hold; make hostile robots unmistakable and complete the fight/reward loop. |
| 3 | More vehicles + believable audio | Twelve paint palettes exist but civilians share one body. Add different licensed vehicle families and recorded engine/road layers; remove the intrusive synthetic whine. |
| 4 | Timed taxi mode | Implement passenger pickup → timed SF trip → dropoff → fare/bonus → next trip, with retry and clear mode selection. |
| 5 | Phone + graphics settings | Replace the large modal with a convincing phone UI; add persistent Auto/Low/Standard/High settings. Current Settings shows audio/saves but no Graphics selector. |
| 6 | SF landmark coverage | Preserve Palace/Ferry; add dedicated Coit, Salesforce and Transamerica models, correct signage/logos, map destinations and the remaining major-landmark checklist. |
| 7 | Realistic robots + spoken story | Improve robot models without replacing humans or breaking LOD/rust/collapse; deliver actual narrated audio and subtitles. Current voice manifest has no audio files. |
| 8 | Feature-ready architecture + final QA | Extract clean controllers/registries as these features are built; document extension patterns, review independently, test the integrated artifact and deliver one verified PR to main. |

## Already present: preserve and verify, do not rebuild blindly

- SF city and directed road graph; targeted Slop New York rendering methods.
- Authored Rocketbox humans and supplied Mixamo animation pipeline.
- Twelve car palettes/art patterns, periodic civilian traffic and H robotaxi takeover.
- Vehicle-contact, avatar-foot, startup-road, foliage/pavement and building-detail fixes.
- Compass, lower-left map, Palace of Fine Arts and traffic signals.
- Compact icon HUD and optional stat/mission details, released in [PR106](https://github.com/BroderickHigby/fog-city/pull/106).

## Specific inherited blockers

- Plain Words: actual twenty-board completion still lacks proof; last recorded blocker was a collapsed spinner at board02.
- Coit activity: viewer/audio/full authored scope incomplete.
- Structural candidate: physical route/support failures; preserve strict tests.
- PR54: unresolved OSM/ODbL policy hold; independent non-OSM work can continue.
- Sustained performance/allocation and 1 GB capacity acceptance remain open.

See `HANDOFF_PROMPT.md` for implementation instructions and `PR_INVENTORY.md` /
`PR_INVENTORY.json` for the exact draft heads and source hold comments. Refresh
the snapshot before acting.
