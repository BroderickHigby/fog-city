# SF realism and generic avatar — 23 October 2026

The owner requested a generic human from an online asset library and a visual direction comparable to Slop New York, adapted to San Francisco. This rendering work starts from canonical `integrate/wave2` (`c36a550`) on `lane/render/wave2`. It does not modify simulation, physics, missions or save contracts.

## What changed

- The default on-foot player now uses Microsoft's MIT-licensed Rocketbox `Male_Adult_01`, converted with embedded textures and idle/walk/run clips. It has 7,440 triangles and 80 joints. The retired likeness-specific `player.glb` stays in source history but is excluded from the web build. Provenance, complete licence and reproducible import scripts: `assets/imports/rocketbox/`.
- Players get independent skeletons and animation mixers, visible loading/failure fallback, first-person hiding and the existing 16-player draw limit. Ground contact uses the visible road surface while preserving simulated height and jump/roof/bridge behaviour.
- Leaf-spray broadleaf and cypress trees replace named primitive street trees, with bark, branches, wind, shadows and bounded near/far instance budgets.
- Façades gain recessed window/frame shading, interior parallax and blinds, masonry detail and weathering. Roads and sidewalks gain finer material variation and joints, plus six licensed 1K Poly Haven asphalt/concrete maps with real metre-scale repetition and packed-build loading.
- Noon, golden-hour, twilight and night lighting share sky, sun, environment reflection and SF marine haze. Native GPUs default to soft shadows and HDR grading/bloom/FXAA. Software renderers keep a lighter default; `?gfx=high&shadows=1&tod=golden` explicitly enables the visual QA path. Devices without floating-point color targets use the direct rendering path to avoid clipped highlights.
- An original unbranded rounded fastback is now the default player car, keeping wheel, paint and light contracts. Reproducible model source and licences: `assets/imports/civilian-car/`.

Slop New York's source was inspected at `039a32796faf6ff914a07946b3d3d058d291e251`. Its grading and material techniques informed this implementation; no NYC map or city assets were copied. Attribution: `assets/imports/slop-new-york/`.

## Validation

- TypeScript passed. All 133 unit files passed: **3,034 tests**, with one existing opt-in skip.
- **39 unique Chromium cases passed**, using the full regression run plus focused reruns. Ten Firefox/WebKit checks were skipped because those engines are unavailable.
- The complete Hot Desk route, signup, first purchase, reward and Spill acknowledgement passed. Browser and Node reproduced the same final hash, `845bcfc6`, across **14,644 input frames** (tick 1 to 14,645), including all five recorded UI commands.
- Dedicated rendering checks verify actual avatar and scanned-surface decoding, bounded foliage, camera/lighting state isolation, model contracts, loading fallbacks and disposal. City tests cover traffic, skyline streaming, the southern seam and driving.
- The hosted build passed all six checks, including sub-path loading, split packs and missing-part refusal. Its **124 files / 119,705,388 bytes** fit the host limits; the largest file is 12,349,300 bytes. All eight new runtime assets match their source hashes. The retired likeness is absent; licence notices are included.
- `test-results/fog-city-sf-realism.zip` is the tested, CRC-checked bundle: **75,886,458 bytes**. It is an ignored build artifact.
- Real game screenshots are in `docs/shots/sf-realism/` and `docs/shots/avatar-human/`, including 1920 × 1080 noon and avatar views. The HD captures reported no browser errors.

The first campaign attempt was interrupted by a development hot reload. Focused reruns also exposed test timing assumptions: the visual check now drains the startup mission command before taking its paused hash, and the campaign explicitly settles with neutral input after closing the form. The stopped-speed, financial and replay assertions remain intact. The traffic request check now names the new civilian car. All affected cases passed on the final frozen source.

The supplied reference page is blocked by this environment's network policy. Its pinned source was available on GitHub, but the locally mirrored reference failed to draw on the software GPU. Exact visual parity and native-GPU frame rate are therefore unverified. The city remains procedural; these images show the actual runtime, not a render mockup.

This branch is a tested rendering handoff on the canonical base. The live Claude artifact cannot be republished from this environment; the branch and static ZIP are ready for the existing publishing workflow.
