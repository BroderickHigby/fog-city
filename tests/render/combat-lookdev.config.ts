// Combat look-dev (docs/visual/README.md): a strip of one robot per combat stage (clean, rusting,
// half rusted, seized, slumping, heap), each framed close, for the owner's sign-off. Not part of
// `pnpm e2e`.
//   LOOKDEV_OUT=docs/shots/visual-stream/<step> pnpm exec playwright test --config tests/render/combat-lookdev.config.ts

import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { BASE_URL, SWIFTSHADER_ARGS, webServer } from "../../playwright.config.ts";

const ROOT = join(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "combat-lookdev.capture.ts",
  timeout: 3_600_000,
  retries: 0,
  workers: 1,
  outputDir: join(ROOT, "test-results", "playwright-lookdev"),
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
    browserName: "chromium",
    launchOptions: { args: SWIFTSHADER_ARGS },
  },
  webServer,
});
