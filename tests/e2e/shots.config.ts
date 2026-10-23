// `pnpm shots`: screenshots from fixed camera positions for humans and reviewers, written to
// test-results/shots/*.png with an index.html contact sheet. Not part of `pnpm e2e`.
//   pnpm shots                       every world present (dev, dev-city, sf)
//   pnpm shots --grep sf             one world
//   SHOT="sf -669 677 45 -2 3" pnpm shots --grep custom
//                                    one ad-hoc view: world x z yawDeg pitchDeg [metres above ground]

import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { BASE_URL, SWIFTSHADER_ARGS, webServer } from "../../playwright.config.ts";

const ROOT = join(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "shots.capture.ts",
  timeout: 300_000,
  retries: 0,
  workers: 1,
  outputDir: join(ROOT, "test-results", "playwright-shots"),
  globalSetup: join(import.meta.dirname, "shots.setup.ts"),
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
    browserName: "chromium",
    launchOptions: { args: SWIFTSHADER_ARGS },
  },
  webServer,
});
