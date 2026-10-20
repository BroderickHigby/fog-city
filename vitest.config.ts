import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only. Browser tests are tests/e2e/*.spec.ts (Playwright).
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Vitest's 5 s default is too tight for whole-world tests: tests/sim/sf-agents.test.ts takes
    // ~6 s alone on the real SF tiles and more on a loaded 2-4 core CI runner. A hung test still
    // fails, just later.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
