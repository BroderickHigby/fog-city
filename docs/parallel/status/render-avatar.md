# Human avatar correction — 23 October 2026

The owner explicitly requested replacing the Lego-like player with a human. This focused rendering change starts from canonical `integrate/wave2` (`c36a550`) on `lane/render/wave2`; it does not resume or merge a frozen showcase branch and does not change the simulation.

The canonical player renderer never loaded the existing authored `public/models/player.glb`. It used the crowd's primitive torso/cylinder placeholder for every player. The existing human asset has 7,896 triangles, a 20-bone skeleton, facial features, hands, clothes, idle/walk/run clips and authored morphs. Its generation/source terms are already documented in `assets/blender/README.md`; this change introduces no third-party asset or licence.

Changes:

- Mount the skinned human on all normal graphics settings, through the same loose/packed asset provider as the world. Keep a visible fallback during loading or failure.
- Give each player its own skeleton and animation mixer, preserve other players' jacket colours, and dispose departed bodies without disposing shared geometry.
- Preserve first-person hiding and car-entry behaviour; expose `walkersFromFile` for browser verification.
- Align only the rendered feet and contact shadow to nearby visible ground/road triangles. SF's road ribbons sit 0.15 m above simulation ground and previously buried the shoes. Keep jump/roof/bridge simulation coordinates intact.

Verification and screenshots are recorded below after the final candidate runs. This is a human-avatar correction, not a claim that the rest of the world meets the requested modern visual standard.

Validation checkpoint:

- TypeScript passed. Full unit sweep: 3,011 passed and one existing opt-in skip; the sole failure was the test-guide coverage check for the newly added `avatar.spec.ts`. Added its guide entry and reran the complete 24-test harness file successfully, covering all 3,012 unit cases after that documentation correction.
- Eleven new focused cases cover real-asset skinning/grounded feet, independent skeletons, first-person hiding, loading failure and late disposal, actual floor interpolation, tile lifecycle, bridge/roof separation and malformed-coordinate rejection.
- Initial live controls run: three browser cases passed (SF human avatar, walking/vehicle entry and blocked vehicle exit).
- Updated floor-aligned avatar and packaged build: seven browser cases passed, including human loading through the packed sub-path provider, no raw binary requests, streaming, split packs and missing-part failure.
- Front and chase-view evidence is committed under `docs/shots/avatar-human/`. The avatar remains an authored stylized human, not a photoreal scan. No asset geometry, texture or licensing changes were needed.

Final review and validation:

- Preserved the existing limit of 16 visible on-foot players for the skinned path. A 24-player test checks the cap and verifies that hiding the local first-person body frees a slot for the next remote avatar.
- Full Chromium suite before that budget guard: **38 passed in 20.6 minutes**, including complete Hot Desk/purchase/Spill progression and matching replay hash. Ten Firefox/WebKit cases were explicitly skipped because those engines are unavailable.
- After the budget guard: **TypeScript and all 130 unit files passed: 3,013 tests, one existing opt-in skip**. The only further runtime delta was the drawing-budget guard; final avatar, controls and packaged-build browser checks are recorded below.
- The guard does not change input, physics, saves, missions or collision state. The old placeholder and the skinned model now share the same visible-player limit.
- Final post-guard browser verification: **all nine avatar/control/static-build tests passed**. The packaged build loads the human model at its sub-path, and car entry, first-person hiding, streaming and missing-pack handling pass on the final source.
- Shareable evidence: `docs/shots/avatar-human/front.png` and `third-person.png`. Built host bundle: `test-results/fog-city-human-avatar.zip` (ignored build artifact). The live Claude artifact is not republished by this environment; this branch and bundle are the tested handoff.
