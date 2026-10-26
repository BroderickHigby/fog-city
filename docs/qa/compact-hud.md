# Compact gameplay HUD

The default HUD shows cash and unlimited water in one status button. Robot
attention appears when nonzero; runway appears when low or briefly after damage.
The status dialog retains all five exact values with short explanations. Runway
is the startup's staying power, not a cash-burn countdown.

Map, phone, counter, controls and lighting use labelled SVG icon buttons. Narrow
screens keep map and phone beside a More actions button. All HUD controls retain
44 px hit targets and accessible names. Mission text is collapsed behind its
title; an active interaction still has an independent Continue button.

The small disclosure dialogs pause gameplay, release held input, trap focus and
restore it on close. They keep the city visible. Existing phone, map, vendor,
startup and controls flows remain available.

## Local validation

- TypeScript, 79 UI unit tests and 2 UI-copy content tests pass.
- Eleven disclosure browser tests and ten existing UI browser tests pass with one
  Chromium worker. Coverage includes keyboard/gamepad focus, blocked gameplay
  input, live status values, mission continuation, mobile actions, long content,
  low-runway/attention priority, and speed/joystick/navigation/touch-action overlap.
- At 1280 × 800, 390 × 844, 320 × 740 and an effective 200% desktop zoom viewport
  of 640 × 400, the default header is 44 px high and mission chip is 46 px high.
  No header, navigation or touch-control overlaps were observed. The previous
  long-mission fixture occupied 412–716 px vertically and overflowed the two
  smallest viewports; the complete text now scrolls inside its opened dialog.
  Additional 844 × 390 and 768 × 1024 touch cases verify the full control layout
  and that the minimap canvas remains inside its frame.
- A native Chrome/WebGPU night scene verified the built HTML, asset index and
  JavaScript. The status dialog displayed all five explained values, Escape
  restored focus, and no browser errors occurred. Simulation tick 0 and state
  hash `e64e6b7d` stayed unchanged throughout this paused UI check.
- The static build contains 192 files (174.9 MB). No game assets, simulation
  rules, dependencies or `SIM_VERSION` changed.

Heavy checks were serialized and the QA browser was closed afterward. Hosted CI
is skipped at the owner's request. This focused UI check does not clear the
inherited sustained-performance/allocation or 1 GB capacity hold.
