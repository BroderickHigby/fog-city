// The memory soak (tests/render/memory-soak.spec.ts): drive the camera round the city's districts
// repeatedly and require GPU objects and the JS heap to hold steady once the first lap has warmed up.
// Not part of `pnpm e2e` (it takes many minutes under SwiftShader):
//   pnpm exec playwright test --config tests/render/soak.config.ts
//   SOAK_LAPS=3 SOAK_OUT=test-results/soak ...
// Chromium runs with --expose-gc so each sample follows a collection, and --enable-precise-memory-info.

import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { BASE_URL, SWIFTSHADER_ARGS, webServer } from "../../playwright.config.ts";

const ROOT = join(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: ["memory-soak.spec.ts", "context-loss.spec.ts"],
  timeout: 3_600_000,
  retries: 0,
  workers: 1,
  outputDir: join(ROOT, "test-results", "playwright-soak"),
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
    browserName: "chromium",
    launchOptions: { args: [...(process.env.SOAK_GPU ? [] : SWIFTSHADER_ARGS), "--js-flags=--expose-gc", "--enable-precise-memory-info"] },
  },
  webServer,
});
