import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only. Browser tests are tests/e2e/*.spec.ts (Playwright).
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Vitest's 5 s default is too tight for the whole-world sim tests: on 2026-10-20, at load 8
    // on 4 cores, tests/sim/fuzz.test.ts (4000 ticks) took 4.7 s and tests/sim/sf-agents.test.ts
    // 4.6 s, and a CI runner can be twice as slow. 20 s gives them room without letting a hung
    // test sit for a minute. A test that needs more sets its own: it(name, fn, 60_000).
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
