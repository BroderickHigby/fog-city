// The dodge stream's frame strips (docs/shots/dodge-stream/): a car driven at pedestrians on
// the real city at a few speeds, the dodging person filmed from the side, frame by frame.
// Not part of `pnpm e2e`.
//   DODGE_SHOTS=docs/shots/dodge-stream/after pnpm exec playwright test --config tests/e2e/dodge-stream.config.ts --workers=1
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { BASE_URL, SWIFTSHADER_ARGS, webServer } from "../../playwright.config.ts";

const ROOT = join(import.meta.dirname, "..", "..");
// A machine whose Chromium is not the one this Playwright expects names it (PW_CHROMIUM, or /opt/pw-browsers/chromium).
const CHROMIUM = process.env.PW_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "dodge-stream.capture.ts",
  timeout: 900_000,
  retries: 0,
  workers: 1,
  outputDir: join(ROOT, "test-results", "playwright-dodge"),
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1100, height: 700 },
    browserName: "chromium",
    launchOptions: { args: SWIFTSHADER_ARGS, ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) },
  },
  webServer,
});
