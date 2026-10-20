// E2E_REQUIRE: the switch that turns "skipped: a prerequisite is absent" into a failure.
//
// Browser tests skip with a reason when something another track delivers is missing (the SF
// world, on-foot play, the render track's debug-handle extras...), so each track's branch is
// green on its own. After integration that same skip would hide a regression: tiles that left
// plain git, a renamed debug method. Set E2E_REQUIRE to the prerequisites that must be present
// and those tests fail instead of skipping:
//
//   E2E_REQUIRE=sf,dev-city,foot,render-debug,landmarks pnpm e2e
//   E2E_REQUIRE=all pnpm e2e
//
// CI reads it from the repository variable E2E_REQUIRE (.github/workflows/ci.yml).
// Pure: no Playwright, no DOM, so the unit tests can check it.

export const PREREQUISITES = {
  sf: "the SF world: public/tiles/sf/manifest.json",
  "dev-city": "the dev-city world: public/tiles/dev-city/manifest.json",
  foot: "on-foot play in the sim: PlayerState.foot (sim contract v2)",
  "render-debug": "the render track's debug-handle extras: renderInfo(), setNight(), setCameraMode(), flyTo(), tilesSettled()",
  landmarks: "content/landmarks.json with a Ferry Building entry, and its model file under public/",
  "landmark-ids": "window.__fogcity.landmarks(): each landmark's id, position and whether its model is in the scene",
  roads: "the game builds its sim world with the road graph its manifest names (so sim traffic runs in the game)",
  engines: "Firefox and WebKit installed, for the cross-engine determinism tests",
  "step-frames": "window.__fogcity.stepFrames(frames, events): multiplayer stepping of the running game",
} as const;

export type Prerequisite = keyof typeof PREREQUISITES;

const NAMES = Object.keys(PREREQUISITES) as Prerequisite[];

/**
 * Parse E2E_REQUIRE: comma- or space-separated prerequisite names, or "all". An unknown name
 * throws, so a typo cannot silently require nothing.
 */
export function parseRequire(text: string | undefined): ReadonlySet<Prerequisite> {
  const out = new Set<Prerequisite>();
  for (const raw of (text ?? "").split(/[\s,]+/)) {
    const name = raw.trim();
    if (!name) continue;
    if (name === "all") {
      for (const n of NAMES) out.add(n);
    } else if ((NAMES as string[]).includes(name)) {
      out.add(name as Prerequisite);
    } else {
      throw new Error(`E2E_REQUIRE: unknown prerequisite "${name}". Known: all, ${NAMES.join(", ")}`);
    }
  }
  return out;
}
