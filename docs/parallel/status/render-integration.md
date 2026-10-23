# Render integration

## Now
`lane/render-integration/wave2` in `/workspace/fog-city-play` joins the published Ferry showcase renderer, shared combat/player systems, gameplay map and mounted UI. The original prototype is untouched.

## Done
- Merged renderer `f3c845a`, UI `de58606`, player `9c4cc8d`, gameplay data `1f41c22`; merge resolutions retain both storefronts and gameplay layers.
- Mounted immutable HUD/phone/vendor/mission panels with recorded ID-only commands and a shared keyboard.
- Added pooled water/cone/flower projectiles, existing audio samples, actual tank capacities and hold-to-refill controls.
- Added runtime-actor presentation adapter for accepted poses, visible bag/light tells and combat height changes.
- UI projection throttles to 10 Hz; GPS uses cached adjacency and a heap rather than repeatedly scanning all edges.
- Loads optional gameplay metadata and passes it into the shared world.

## Validation
Initial integration typecheck and 10 scoped UI tests passed before runtime-presentation additions. UI2 has 12 focused control/command tests passing. Actual SF canvas booted in Chromium and produced `test-results/sf-hud.png`. High-GFX software rendering saturated the browser during interaction; that bounded run was stopped to release the shared lock for core validation. The next functional run uses the default tier and smaller viewport on the same renderer branch.

## Next
Merge final `createGameSystems` composition, connect accepted runtime actors and transit/sidewalk metadata, mount progression-only save controls, then run actual SF movement/exit/phone/spray/refill and a mission loop. Capture final screenshots and console results.

## Draft PR
Base: `integrate/wave2`

Head: `lane/render-integration/wave2`

Title: `Game: mount progression HUD and controls in the SF renderer`

Body: Connect the published SF renderer to shared gameplay systems and immutable UI projections. Player actions become recorded ID-only commands; the HUD exposes missions, water, cash, navigation and nearby vendors. Adds bounded projectile/audio presentation while preserving the existing renderer assets. Final core composition and actual-play validation are in progress.
