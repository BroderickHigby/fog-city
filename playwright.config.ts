import { defineConfig } from "@playwright/test";

// Parallel worktrees must not share a server: set E2E_PORT per checkout.
const PORT = Number(process.env.E2E_PORT ?? 4173);

// Software WebGL (SwiftShader) so the suite runs on machines with no GPU.
// It is slow: e2e tests assert behaviour, never frame rate.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  retries: 0,
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1100, height: 700 },
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
