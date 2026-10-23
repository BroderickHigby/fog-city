# Latest showcase intake

Continues `feature/active-gameplay` on `feature/latest-showcase`. The directly fetched PR #3 head is `2f212f3` (trees, paint, 415 Mission and pyramid detail); PR #1 head is `1ddda61` (handoff/realism roadmap). These updates are integrated without replacing the campaign, recorded input, checkpoints, private relay or terrain/dodge implementations.

Adversarial review found two tree integration problems. The incoming code removed original trees even when the asynchronous replacement failed or exceeded its 90-tree detail capacity; it also duplicated boundary-straddling foliage. Original instances now remain until their specific replacements are drawn, and are restored outside the detailed set. A second issue appeared only in the 1920×1080 capture: the library's custom leaf wind shader replaces Three's projection code without applying `instanceMatrix`, leaving most trunks bare and stacking leaf geometry near the origin. Standard PBR materials now retain the source textures and alpha mask while using Three's normal instanced transform path.

The pinned MIT dependency `@dgreenheck/ez-tree` 1.1.0 was published January 15, 2026. Its licence ships in `public/models/ez-tree-license.txt`; source and usage are recorded in `assets/trees/README.md`.

Typecheck, 630 focused tests across 44 files, and the production build passed after intake. Following the visual shader fix, typecheck and seven relevant rendering tests passed again. The packed build is 181 files / 190.1 MB, below the 450-file / 240 MB limits. Its tree library increases JavaScript payload; real-GPU profiling and further asset optimization remain necessary.

The existing world/content release gate remains open. The handoff's ballpark preservation code fix is already present in `pipeline/lib/clearance.ts` and `pipeline/lib/build.ts`, with tests; the checked-in world still needs regeneration. Do not repeat that source fix or manually mark the missing geometry repaired. Canonical agent/player migration remains a separate integration task described in the active-gameplay report.

The final 1920×1080 capture shows correctly placed canopies with the clock tower visible. Heights are normalized to 10–12 m before per-instance variation; generated variants cannot exceed 14,000 triangles. Captured rendering still submits about 5.6 million triangles, so no performance improvement is claimed. The packed-build smoke loaded trees/characters and tested three lighting presets with zero browser or HTTP errors. See [the capture and metadata](../shots/latest-showcase/README.md).

Packaging review also found that the web packer omitted plain-text notices. It now ships model `*-license.txt` notices as directly readable files; the build regression checks the actual MIT notice. This affects packaging only, not the simulation or world geometry.

Final packaging/typecheck pass: 20 tests across the asset-loader/build and tree suites passed. The final static build contains 182 files / 190.1 MB, and `dist/models/ez-tree-license.txt` contains the full notice. The preceding full regression report remains red with 91 world/content failures; this asset-focused pass does not claim a fresh full-suite or release certification.
