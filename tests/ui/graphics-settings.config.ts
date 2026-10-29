import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 4192);
export default defineConfig({
  testDir: import.meta.dirname, testMatch: "graphics-settings.spec.ts", workers: 1, timeout: 30_000,
  outputDir: "../../test-results/ui-graphics-settings",
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: "chromium", channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : "chrome", viewport: { width: 390, height: 844 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ["--js-flags=--max-old-space-size=512"] } },
  webServer: { command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}/tests/ui/graphics-settings.fixture.html`, cwd: new URL("../..", import.meta.url).pathname, reuseExistingServer: false, timeout: 30_000 },
});
