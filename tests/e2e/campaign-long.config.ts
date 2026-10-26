import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "../../playwright.config.ts";

// Long real-SF playthroughs (tests/e2e/*.long.ts): whole wave-3 missions and side activities
// played through real controls and the page's own dialogs, each tens of minutes under
// SwiftShader. They run apart from the default suite so its CI time budget holds:
//
//   E2E_REQUIRE=sf,step-frames pnpm exec playwright test --config tests/e2e/campaign-long.config.ts --workers=1
const root = join(import.meta.dirname, "..", "..");
export default defineConfig({
  ...base,
  // Paths in the base config are relative to the repository root; this file lives in tests/e2e.
  testDir: import.meta.dirname,
  outputDir: join(root, "test-results", "playwright"),
  testMatch: "**/*.long.ts",
  // One playthrough can plan and feed tens of thousands of frames.
  timeout: 4 * 60 * 60_000,
  projects: (base.projects ?? []).filter(project => project.name === "chromium"),
});
