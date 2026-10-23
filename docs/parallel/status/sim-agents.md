# Lane 3 — Sim-Agents

## Now

Preparing wave-2 agent policies on `lane/sim-agents/wave2`, based on `integrate/wave1` at `2deafc912ea0971440b541e800158b258c548275`.

The existing playable prototype in `/workspace/fog-city` is preserved. This lane uses the separate `/workspace/fog-city-lane3` checkout and edits only its owned directories.

## Done

- Read the published lane handoff at `38065dd3c48970ab42c97d2bb0d104eee403ed7c`.
- Verified current remote refs: the wave-2 integration/interface branch is not yet published.
- Installed pinned dependencies with a frozen lockfile.

## Next

Build and test pure policies for robot knowledge/state transitions, sidewalk routing, reactions and animals, fidelity scheduling, van dispatch, and bus timetables. Publish a reviewable lane branch with explicit integration requirements.

## Blocked on

Lane 2's wave-2 interface PR, typed extension slots, event definitions, movement hooks and vehicle/body classifications. Runtime registration is intentionally pending that interface; no shared sim contract or top-level implementation will be changed by this lane.

## Requests for other lanes

- **Lane 2:** publish the wave-2 interface; wire agent intents before the final `stepDodge` pass; include vans, buses and animals in clearance/spawn/exit checks; provide clock, migration, event and no-touch contracts.
- **Lane 1:** publish sidewalk graph and Muni route/stop data; lane 3 supplies a deterministic procedural fallback.
- **Lane 4:** provide observed rust, wet, melt and forced-update interruption/completion events.
- **Lane 5:** provide validated, uniquely identified `threat.spawn` requests and arrival acknowledgements.
- **Lane R / Assets:** provide agent render adapters for walking, idle, wary/alert, flee, forced update, animal startle, van delivery and bus stops. Policy outputs will request movement; they will never move bodies after the clearance override.
- **Lane 8:** provide bark keys and behavior-tell content without changing deterministic policy decisions.

## For the owner

This branch does not merge into `main` or `integrate/wave1`, change the world-QA gate, or claim live wave-2 agent behavior before the shared interface and runtime wiring are available. The checked-in integration contract currently reports version 2, despite the handoff's anticipated version 4/5; lane 2 must allocate the actual next version.
