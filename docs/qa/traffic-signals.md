# SF traffic signals

The SF signal inventory now controls both vehicle permission and the visible heads.
It is a procedural game schedule, not a live SFMTA timing feed.

- `src/io/world-load.ts` loads the manifest's `signals` layer for browser and relay.
  Its inventory contributes to `worldFingerprint`.
- `src/sim/traffic-signals.ts` derives incoming approaches from the drivable road
  graph. Opposing, near-parallel approaches share a group; skew streets receive
  separate groups. Groups run 27 seconds green, 3 seconds amber and 2 seconds
  all-red before the next group.
- The v20 agent controller uses that same phase. Red and amber stop new entries;
  vehicles already across the line clear the junction. Unused entry reservations
  expire when their phase closes. A legitimate signal wait is not a traffic jam.
- Existing all-way-stop rules remain at unsignalized junctions. The player's
  manual driving controls are unchanged.

The source furniture retains its original 4,113 placements. Heads use 30 cm
lenses, black housings, sun visors and yellow backplates. Shared instancing adds
one backplate batch per active cell, without point lights. The legacy `group`
field in the furniture file no longer determines phases at controlled nodes.

`src/render/signal-placement.ts` fills missing controlled approaches once at
load. On the current SF data it adds 104 heads across 43 previously headless
signalized locations, with no unplaceable approaches. New posts are checked
against road ribbons, building footprints and other poles; the original
placements stay intact.

`SIM_VERSION` is 20. Existing saves are upgraded by restamping their version;
player and extension fields are preserved. Historical v19-and-earlier replays
keep their original traffic rules.

Validation covers shared phases, red/amber braking, green release, occupied
junction clearance, expired reservations, close consecutive signals, long red
waits, visible head timing, placement, and the existing replay/upgrade tests.
Native browser QA uses separate disposable state fixtures and the actual
simulation tick. Hosted CI is skipped at the owner's request. The inherited
sustained-performance/allocation and 1 GB capacity hold remains open.
