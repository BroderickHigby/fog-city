import { defineConfig } from "@playwright/test";

// Parallel worktrees must not share a server: set E2E_PORT per checkout (docs/testing.md).
export const PORT = Number(process.env.E2E_PORT ?? 4173);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

// Software WebGL (SwiftShader) so the suite runs on machines with no GPU.
// It is slow: e2e tests assert behaviour, never frame rate.
export const SWIFTSHADER_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export const VIEWPORT = { width: 1100, height: 700 };

/** One Vite dev server per run, on this checkout's port, never shared with another run. */
export const webServer = {
  command: `pnpm exec vite --port ${PORT} --strictPort`,
  url: BASE_URL,
  reuseExistingServer: false,
  timeout: 60_000,
  cwd: import.meta.dirname,
};

const CI = Boolean(process.env.CI);

// Projects:
//  - chromium: every e2e spec, with SwiftShader WebGL.
//  - firefox, webkit: only tests tagged @engines (the pure-sim cross-engine determinism
//    checks, which need no WebGL). They skip with a reason when that browser is not installed.
// `pnpm shots` uses tests/e2e/shots.config.ts and never runs as part of this suite.
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  retries: 0,
  forbidOnly: CI,
  // Per-test artefacts only. What the suite writes on purpose lives beside it in test-results/
  // (perf.json, shots/) and so survives the next run's clean-up of this directory.
  outputDir: "test-results/playwright",
  reporter: CI
    ? [["list"], ["github"], ["html", { outputFolder: "test-results/html-report", open: "never" }]]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    trace: { mode: "retain-on-failure", screenshots: false, snapshots: true },
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium", launchOptions: { args: SWIFTSHADER_ARGS } } },
    { name: "firefox", use: { browserName: "firefox" }, grep: /@engines/ },
    { name: "webkit", use: { browserName: "webkit" }, grep: /@engines/ },
  ],
  webServer,
});
