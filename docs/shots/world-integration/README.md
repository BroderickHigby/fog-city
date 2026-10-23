# Unreleased structural-world candidate

These captures show the same Ferry Building view, world checkpoint `76c1bc0`, with the additive renderer. They were captured at 1280 × 800 in Chromium using SwiftShader software rendering. The displayed frame rate is not hardware performance evidence.

- [Before](ferry-before.png): baked land-cover instances bypassed the detailed foliage layer, exposing the unit cone/diamond prototypes.
- [After](ferry-after.png): renderer commit `efd7a36` admits and normalizes those instances into the existing detailed foliage tiers. Tree roots, crown widths/heights and the bounded LOD budgets are preserved.

This is an unreleased integration candidate. The generated world's strict QA gate remains separate and prevents treating these images as proof that the complete game or world is ready to publish. See [the integration report](../../parallel/status/world-render-integration.md).
