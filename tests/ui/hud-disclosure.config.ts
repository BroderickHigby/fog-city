import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "hud-disclosure.spec.ts",
  workers: 1,
  timeout: 25_000,
  outputDir: "../../test-results/ui-hud-disclosure",
  use: {
    baseURL: "http://127.0.0.1:4189",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : "chrome",
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: ["--js-flags=--max-old-space-size=512"],
    },
  },
  webServer: {
    command: "pnpm exec vite --port 4189 --strictPort",
    url: "http://127.0.0.1:4189/tests/ui/fixture.html",
    cwd: new URL("../..", import.meta.url).pathname,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
