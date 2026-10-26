# Navigation and vehicle damage panels — 2026-10-26

The owner requested a compass and map, then reported floating rectangular panels
ahead of cars. The current SF map already had geographic data, routing and map
controls; its entry point was a small minimap or the phone menu. The legacy compass
was deliberately hidden in the newer HUD.

The HUD now has a visible compass beside the minimap, with an eight-direction
heading, degrees and a rotating needle. Both the Map button and M open the map
directly, with a larger canvas and the existing pan, zoom, center and waypoint
controls. Phone apps remain reachable from the map header. Keyboard, gamepad and
short landscape touch layouts are covered by browser regressions. The map keeps
the existing bounded raster cache and uses the already loaded SF geography.

The gray panels were reproduced as `impact-scuffs`; the authored car doors remain
attached. Damage used current simulation coordinates while car rendering used
interpolated/grounded frames and fitted models. A controlled render-only fixture
produced a 2 m separation without changing the simulation. Damage now borrows the
actual displayed vehicle matrix and rest bounds after the scene frame updates.
This includes fit scale, heading, pitch, roll and ground support, and omits effects
for hidden or absent vehicles. Small damage patches remain on the body. Car art,
simulation, traffic, saves and SIM_VERSION 19 are unchanged.

The real game had a broad `#game canvas` rule that overrode the map's responsive
size. It now targets only the renderer's direct-child canvas. The browser fixture
loads the actual game-shell stylesheet and uses the actual host ID, so map sizing
is tested in the same CSS scope as the game.

Native WebGPU validation shows the full SF map at 372 × 372 pixels in a 960 × 600
viewport, fully on screen. Compass/minimap, M open/close, zoom/recenter and focus
restoration passed. The same render-only pose-offset fixture kept all three damage
patches within the displayed body bounds; there were no browser errors or simulation
hash changes. The UI fixture includes Vite's raw-import typing for the shell source.

Local validation: typecheck; 159 tests across 22 unit-test files; 10 browser tests
covering navigation, map/gamepad focus, modal input blocking and save persistence.
The full repository verification and hosted CI were not run, per the owner's
local-first scope. The inherited sustained-performance/allocation and 1 GB
capacity hold remains open.
