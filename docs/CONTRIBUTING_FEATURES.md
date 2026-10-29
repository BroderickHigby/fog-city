# Adding game features

Start by reading `CLAUDE.md`, `AGENTS.local.md` when present, and `docs/design.md`.
Fetch the active base and record its SHA. Keep source assets and import tooling
under `assets/imports/`; only optimized runtime outputs belong in `public/`.
Never replace authored humans, reset the city, silently import held OSM data,
waive clearance tests, or raise performance budgets to make a feature pass.

## Vehicles

Add a family to `src/render/vehicle-models.json` and its typed registry in
`src/render/vehicle-models.ts`. Record model path, dimensions, four centered wheel
hubs/radii, paint slots, audio profile and LOD. The current civilian families fit
inside the existing traffic hull; visual variety must not create invisible
vehicle corners. A larger physical vehicle needs canonical sim dimensions,
spawn/clearance checks and a versioned migration, not a scaled visual alone.

Use `assets/imports/vehicle-families/prepare.ts` as the import example. Retain the
exact publisher URL, archive/member SHA-256, author and redistribution licence.
Normalize metres, +Y up and front -Z; rotate around hub-centered wheel nodes.
Separate paint from windows, lights, tyres and trim. Register batched and close
rendering through `src/render/agent-layer.ts`; preserve takeover and occupied
vehicle identity. Validate bounds, wheel contact, material separation, different
silhouettes, batching/LOD, dry safe spawning and the public build's byte budget.

## Landmarks

Register placement in `content/landmarks.json`: real coordinate, heading, scale,
model URL, source records and a reachable nearby viewing destination. Map labels
live in `src/ui/landmarks.ts`. Existing original architecture is documented in
`assets/blender/README.md`; recovered project assets and immutable hashes are in
`assets/imports/fog-city-landmarks/`.

`landmarkRenderReplacements` creates render-only near/far fallbacks for existing
records. Hiding a solid building must never hide its collision or a neighbour.
An architectural collision change belongs in `src/io/landmark-world.ts`, shared
by browser/server/replay, with exact source records and strict open-arch/support
negative tests. Model downloads must not decide physics. Verify a missing model,
foundation/height, street silhouette, near/far consistency and an actual route.
A bridge silhouette is not proof of a drivable supported deck.

## Modes

Keep rules pure and deterministic under `src/sim/modes/`; isolate session/world
adaptation under `src/modes/`. Taxi is the example: validated legal SF curb/path
catalog, accepted physical vehicle and protected passenger, fixed ticks, ordered
commands and once-only fare IDs. Do not accept a UI-supplied position, completion
flag or reward. Renderer, DOM, network, wall clocks and unseeded randomness stay
outside the simulation.

Retain a detached full campaign on entry, step only the isolated instance, then
apply its stable aggregate settlement once before saving the restored campaign.
Checkpoint both timelines and pending commands through graphics restart/reload.
Keep success, timeout, blocked-route, cancellation, retry, stale-command and exit
recovery paths. A state shape/behavior change needs the next unused SIM version,
canonical migration and untouched historical replay fixtures. Test the real
normal-control route, including protected-body clearance and save restoration.

## Phone apps and controls

Use `src/ui/phone-shell.ts` for handset chrome and `src/ui/mount.ts` for existing
app mounting. Add the app's type, implemented-app registration, projection and
callback together. State comes from the simulation/controller; a screen never
writes a fabricated completion. Unavailable apps must remain visibly unavailable.
Keep game input blocked during modals, native keyboard/Tab behavior, accessible
names, 44px actions, focus restoration and map pan/zoom/waypoints. Retain mounted
settings controls between ticks so a live update cannot erase slider focus.

Graphics preferences belong in `src/render/gfx-preference.ts`, separate from
renderer ownership. Valid URL choice overrides stored choice; selection removes
stale quality overrides. Save the full timeline before restarting the renderer.
Report Auto adaptation and safety fallbacks without erasing a manual selection.

## Sounds and narration

Driving audio is the procedural synth (`src/audio/vehicle-synth.ts`, driven by
`src/audio/vehicle-sound.ts` and its gearbox), routed through the effects bus.
Preserve user-gesture unlock, independent volume/mute, pause, visibility,
car/profile changes and resource cleanup. Signal analysis does not replace
listening to idle, acceleration, coasting, braking, stops and vehicle changes.

Opening narration uses `src/audio/opening.ts` and the existing priority queue,
voice bus, subtitles and ducking. The original stock-voice generation adapter and
rights are under `assets/imports/supertonic-3/`; only its short MP3s and manifest
ship. Keep the machine-generated disclosure, skip/replay, measured durations,
text fallback for locked/missing/slow audio and no impersonation. Mission text
changes also require rebuilding the separate mission manifest; its text entries
must never be reported as recorded audio when their files are absent.

## Validation and delivery

Run meaningful focused tests first. Serialize expensive city simulations, asset
conversions, full builds and browser QA; default to one browser/worker. Use the
same source, route, resolution and capacity for before/after resource measures.
Keep JS heap, backing allocations, GPU counters and physical resident memory
separate. Inspect the final packed artifact through actual controls and capture
negative cases as well as success. Broad local verification and independent
Standards/Spec review follow integration. Preserve any unresolved holds, reuse
the consolidated draft PR, and follow the owner's current hosted-CI exclusion.
