# Active gameplay pass — 2026-10-23

## Online references consulted

Primary documentation was fetched from the maintainers' public GitHub repositories. These are engineering references, not evidence that this prototype meets a commercial game's visual/performance budget.

- [Three.js: color management (r180)](https://github.com/mrdoob/three.js/blob/r180/manual/en/color-management.html): light calculations belong in linear space; display and color textures need the appropriate sRGB conversion. The existing Linear-sRGB/ACES/sRGB pipeline is preserved.
- [Three.js: optimizing many objects (r180)](https://github.com/mrdoob/three.js/blob/r180/manual/en/optimize-lots-of-objects.html): reduce draw-call overhead with shared/combined geometry. Existing instanced trees and streamed tiles remain; no per-leaf object population was introduced.
- [Khronos: KHR_materials_clearcoat](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_clearcoat/README.md): clear coat is a separate dielectric layer, appropriate for automotive paint. The high tier adds it to private material copies without changing collision meshes or shared prototypes.
- [MDN: Pointer Lock API](https://github.com/mdn/content/blob/main/files/en-us/web/api/pointer_lock_api/index.md): pointer capture needs a user engagement gesture and an escape route. Right-button aim requests lock, releases on pointer-up and tolerates denial with drag aiming.
- [MDN: Web Audio best practices](https://github.com/mdn/content/blob/main/files/en-us/web/api/web_audio_api/best_practices/index.md): create/resume audio from a user gesture, retain user control, and ramp gain instead of abrupt changes. Sound cues and narration unlock on interaction; radio has its own mute; envelopes bound cue volume.
- [MDN: local storage constraints](https://github.com/mdn/content/blob/main/files/en-us/web/api/window/localstorage/index.md): browser persistence may be unavailable by policy. This pass uses async IndexedDB instead of synchronous frame-loop writes, catches storage failures, and keeps playing.

## Concrete changes

Mouse/controller aiming is recorded as finite `aimYaw`/`aimPitch` inputs. The on-foot camera follows that aim with an over-the-shoulder offset, occlusion pull-in and a Watch zoom. Mild speed FOV is disabled by the OS reduced-motion preference. Assistance uses the UI lane's bounded function and a building-visibility filter. Target feedback does not reveal hidden firmware; scan results come from the combat state.

Mission-completion checkpoints contain only completed mission IDs, cash and allowlisted unlocks, plus simulation/content identity. A load starts fresh actors/physics at the normal spawn; active fights, heat and transient projectiles are never serialized. Storage errors are visible and nonfatal. This is local browser persistence, not cloud sync or the full three-slot save/profile roadmap.

The high tier has clear-coated car materials and a procedural marine-cloud layer. Original geometry and low-tier rendering stay intact. These are incremental upgrades; cars, building interiors, foliage and sky still need art direction and hardware profiling before any claim of contemporary AAA quality.

## PR intake

Included this pass: PR #7 shared event/resistance fields; #13–15 later combat (through #15's stack); #19 pause semantics (already in #15); #11 tested input/UI components; #20 private relay commands/aim and isolated mode foundation. The existing campaign UI and control keys are retained while the input controller and bounded aim helper are used in live play. Existing strengthened network recovery tests and terrain/dodge code were preserved when resolving older branches.

Reviewed but not activated: #9's agent integration also carries older car/foot/terrain changes, and #10/#16/#17/#18/#21 replace the campaign's state/content contracts. They need one coordinated migration to the canonical player/mission/agent composition, with fresh save/version and real-world route QA. Importing them over the working campaign would produce two owners for `ext.missions` or regress physical support. Their refs are retained locally for that next integration, rather than describing unregistered code as working gameplay.

Known release blockers remain the inherited world/ballpark gate and missing source-data access. No terrain thresholds were relaxed. No live deployment or paid voice-service call was made.
