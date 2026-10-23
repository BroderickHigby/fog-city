// The Ferry/Market vertical slice (docs/visual/README.md): fixed 1920x1080 captures for
// before/after comparisons, with each view's render figures. Not part of `pnpm e2e`.
//   pnpm exec playwright test --config tests/render/visual-slice.config.ts
//   SLICE_OUT=docs/shots/visual-stream/<step> SLICE_VIEWS=ferry-plaza-golden,crosswalk-noon ...
// Under SwiftShader the frame times it records are software figures, never a GPU result.

import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { BASE_URL, SWIFTSHADER_ARGS, webServer } from "../../playwright.config.ts";

const ROOT = join(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "visual-slice.capture.ts",
  timeout: 3_600_000,
  retries: 0,
  workers: 1,
  outputDir: join(ROOT, "test-results", "playwright-slice"),
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1920, height: 1080 },
    browserName: "chromium",
    launchOptions: { args: process.env.SLICE_GPU ? [] : SWIFTSHADER_ARGS },
  },
  webServer,
});
