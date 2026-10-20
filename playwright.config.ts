import { defineConfig } from "@playwright/test";

// Software WebGL (SwiftShader) so the suite runs on machines with no GPU.
// It is slow: e2e tests assert behaviour, never frame rate.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  retries: 0,
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1100, height: 700 },
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "pnpm exec vite --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
