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
    // Memory: the whole-city test files hold the 583-tile world in each worker. Peak RSS per
    // worker, one file at a time (2026-10-21): agent-budget 1.64 GB, pack 0.96, sf-agents 0.94,
    // sf-world 0.71, world-colliders 0.65, boundary 0.60, citywide 0.52, sf-glb 0.44, the rest
    // under 0.25; pnpm and the Vitest main process add 0.4. Three workers peak at 2.9 GB over the
    // whole suite (47 s; two: 2.5 GB, 59 s), 3.9 GB if the three biggest files ever coincide, so
    // the suite stays far under 8 GB on any machine. Vitest's default (cores - 1) would let a
    // 16-core machine run 15 city worlds at once. Override for one run: --maxWorkers=N.
    maxWorkers: 3,
  },
});
