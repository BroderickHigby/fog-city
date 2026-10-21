// The world-continuity gate's nightly browser checks (`pnpm world:nightly` runs them after the
// nightly Vitest sweeps): the screenshot tour with its checks, and the near/far ring at radius
// 60. One worker; the tour writes test-results/tour/ (docs/qa/world-continuity-gate.md).

import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { BASE_URL, SWIFTSHADER_ARGS, VIEWPORT, webServer } from "../../playwright.config.ts";

const ROOT = join(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: ["world-tour.spec.ts", "far-ring.spec.ts"],
  timeout: 7_200_000,
  retries: 0,
  workers: 1,
  outputDir: join(ROOT, "test-results", "playwright-nightly"),
  reporter: [["list"]],
  use: { baseURL: BASE_URL, viewport: VIEWPORT, browserName: "chromium", launchOptions: { args: SWIFTSHADER_ARGS }, trace: "retain-on-failure" },
  webServer,
});
