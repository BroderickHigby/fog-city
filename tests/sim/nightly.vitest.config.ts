import { defineConfig } from "vitest/config";

// The nightly sim suites (tests/sim/**/*.nightly.ts: the long clearance soak and no-touch fuzz,
// docs/testing.md). Run with `pnpm soak:nightly`; a plain `pnpm test` never includes them. One
// worker: the soak holds the whole city.
export default defineConfig({
  test: {
    include: ["tests/sim/**/*.nightly.ts"],
    environment: "node",
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    maxWorkers: 1,
  },
});
