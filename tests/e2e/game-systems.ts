import { createGameSystems } from "../../src/sim/index.ts";

/** Live-game replays must use the same enabled wave as the page under test. */
export function e2eGameSystems() {
  const wave = Number(process.env.E2E_GAME_WAVE ?? 2);
  if (wave !== 2 && wave !== 3 && wave !== 4 && wave !== 5) throw new Error("E2E_GAME_WAVE must be 2, 3, 4 or 5");
  return createGameSystems({ wave });
}
