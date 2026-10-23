// `pnpm tour`: the world-continuity gate's fixed screenshot tour (tests/e2e/world-tour.views.json)
// for a person to review: test-results/tour/*.png and index.html. Pictures and probe results
// only (TOUR_ONLY=1); the nightly run (tests/e2e/nightly.config.ts) asserts them.

import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { BASE_URL, SWIFTSHADER_ARGS, VIEWPORT, webServer } from "../../playwright.config.ts";

const ROOT = join(import.meta.dirname, "..", "..");
process.env.TOUR_ONLY = "1";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "world-tour.spec.ts",
  timeout: 7_200_000,
  retries: 0,
  workers: 1,
  outputDir: join(ROOT, "test-results", "playwright-tour"),
  reporter: [["list"]],
  use: { baseURL: BASE_URL, viewport: VIEWPORT, browserName: "chromium", launchOptions: { args: SWIFTSHADER_ARGS } },
  webServer,
});
