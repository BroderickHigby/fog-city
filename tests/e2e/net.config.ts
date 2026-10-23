import { defineConfig } from "@playwright/test";
import { SWIFTSHADER_ARGS } from "../../playwright.config.ts";

const port = Number(process.env.NET_E2E_PORT ?? 4195);
const relayPort = Number(process.env.NET_E2E_RELAY_PORT ?? 8795);
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "multiplayer.net.ts",
  timeout: 240_000,
  retries: 0,
  workers: 1,
  use: {
    browserName: "chromium", baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1000, height: 700 }, launchOptions: { args: SWIFTSHADER_ARGS },
    screenshot: "only-on-failure", trace: "retain-on-failure",
  },
  outputDir: "../../test-results/multiplayer",
  webServer: [
    { command: "corepack pnpm run server", url: `http://127.0.0.1:${relayPort}/health`, reuseExistingServer: false,
      env: { PORT: String(relayPort), HOST: "127.0.0.1" }, cwd: "../..", timeout: 30_000 },
    { command: `corepack pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false,
      env: { RELAY_URL: `ws://127.0.0.1:${relayPort}` }, cwd: "../..", timeout: 30_000 },
  ],
});
