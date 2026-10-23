# Human avatar in the running game

Captured on `lane/render/wave2` from the canonical wave-2 world with the normal renderer and existing authored human asset; these are real Chromium game frames, not concept art.

- `front.png`: fly camera facing the player; face, hair, bomber jacket, hands, jeans and sneakers visible.
- `third-person.png`: normal chase camera beside the car at the Ferry Building.

Reproduce with `tests/e2e/avatar.spec.ts`. It exits the car with the real F key, waits for `walkersFromFile === 1`, pauses the simulation, takes both views, then verifies first-person hides the local body and camera changes preserve the simulation hash.

The avatar is skinned and animated in normal play. Render-only floor alignment follows the actual loaded street triangles so the raised pavement no longer hides the shoes. Images use software rendering; they are not hardware frame-rate evidence. The surrounding world art remains the canonical integration baseline.
