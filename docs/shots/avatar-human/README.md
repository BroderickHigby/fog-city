# Generic human avatar in the running game

Captured on `lane/render/wave2` from the canonical SF world. These are actual Chromium game frames.

- `front.png`: Microsoft Rocketbox's generic adult, with textured face, hair, striped polo, shorts and sneakers.
- `third-person.png`: normal chase camera beside the player car at the Ferry Building.

Reproduce with `tests/e2e/avatar.spec.ts`. It exits the car with F, waits for the skinned model, takes both views, then verifies that first-person hides the body and cameras preserve the simulation hash.

Source and MIT licence: `assets/imports/rocketbox/`. Feet follow the visible road surface without changing simulation position. These captures use software rendering and are not native-GPU frame-rate evidence.
