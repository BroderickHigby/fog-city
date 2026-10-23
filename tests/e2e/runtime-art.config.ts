import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import base from "../../playwright.config.ts";

/** Optional native-resolution art review, independent of the functional browser suite. */
export default defineConfig({
  ...base, testDir: import.meta.dirname, testMatch: "runtime-art.capture.ts",
  outputDir: join(import.meta.dirname, "..", "..", "test-results", "runtime-art-playwright"),
  use: { ...base.use, viewport: { width: 1920, height: 1080 } },
  projects: base.projects?.filter(project => project.name === "chromium"),
});
