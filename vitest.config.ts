import { configDefaults, defineConfig } from "vitest/config";

// The world-continuity gate (docs/qa/world-continuity-gate.md) lives in tests/golden/world/:
//  - *.test.ts: the per-PR suites (project "world-pr"), part of every `pnpm test` and `pnpm verify`;
//  - *.nightly.ts: the nightly sweeps (project "world-nightly"), only with FOG_WORLD_NIGHTLY=1
//    (`pnpm world:nightly`), never in a plain `vitest run`.
const WORLD = "tests/golden/world/**";
const nightly = process.env.FOG_WORLD_NIGHTLY === "1";

export default defineConfig({
  test: {
    environment: "node",
    // Vitest's 5 s default is too tight for the whole-world sim tests: on 2026-10-20, at load 8
    // on 4 cores, tests/sim/fuzz.test.ts (4000 ticks) took 4.7 s and tests/sim/sf-agents.test.ts
    // 4.6 s, and a CI runner can be twice as slow. 20 s gives them room without letting a hung
    // test sit for a minute. A test that needs more sets its own: it(name, fn, 60_000). The
    // world gate's suites measure in beforeAll with their own (longer) hook timeouts.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Memory: the whole-city test files hold the 583-tile world in each worker. Peak RSS per
    // worker, one file at a time (2026-10-21): the world gate's determinism suite 1.67 GB (two
    // whole-city worlds, built one after the other), agent-budget 1.64, the gate's buildings and
    // houses suites about 1.4 (the collider JSON with metadata), pack 0.96, sf-agents 0.94, the
    // gate's glb and far suites 0.86 (every tile GLB decoded), sf-world 0.71, the other gate
    // suites 0.7, world-colliders 0.65, boundary 0.60, citywide 0.52, sf-glb 0.44, the rest under
    // 0.25; pnpm and the Vitest main process add 0.4. Three workers stay under about 5 GB however
    // the files coincide. Vitest's default
    // (cores - 1) would let a 16-core machine run 15 city worlds at once. Override for one run:
    // --maxWorkers=N (the nightly gate runs with one).
    maxWorkers: 2,
    // Vitest's own default reporters, plus the world gate's reminder summary: a world metric that
    // beats its baseline by 10% or less passes, and its "lower the baseline" reminder is printed at
    // the end of the run (and written to test-results/world-gate/reminders.txt).
    reporters: [...configDefaults.reporters, "./tests/helpers/world-gate/reporter.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Unit tests only. Browser tests are tests/e2e/*.spec.ts (Playwright).
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, WORLD],
        },
      },
      {
        extends: true,
        test: {
          name: "world-pr",
          include: [`${WORLD}/*.test.ts`],
        },
      },
      ...(nightly
        ? [
            {
              extends: true as const,
              test: {
                name: "world-nightly",
                include: [`${WORLD}/*.nightly.ts`],
              },
            },
          ]
        : []),
    ],
  },
});
