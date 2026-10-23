// Explicit candidate-world visual checks; kept out of the ordinary gameplay E2E suite.
import { defineConfig } from "@playwright/test";
import base from "../../playwright.config.ts";

export default defineConfig({
  ...base,
  testDir: import.meta.dirname,
  testMatch: "world-integration.browser.spec.ts",
  outputDir: new URL("../../test-results/world-integration", import.meta.url).pathname,
  projects: base.projects?.filter(project => project.name === "chromium"),
});
