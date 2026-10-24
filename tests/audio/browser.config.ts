// pnpm exec playwright test --config tests/audio/browser.config.ts
// The audio browser test (real controls, subtitles, music, mixing, voice fallback) on its own
// dev server port. PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a preinstalled Chromium if the
// pinned Playwright browser is not installed.
import { defineConfig } from "@playwright/test";
import { SWIFTSHADER_ARGS } from "../../playwright.config.ts";

const PORT = Number(process.env.E2E_AUDIO_PORT ?? 4191);
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "audio.spec.ts",
  workers: 1,
  timeout: 420_000,
  outputDir: "../../test-results/audio",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    viewport: { width: 960, height: 540 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: [...SWIFTSHADER_ARGS, "--autoplay-policy=user-gesture-required"] },
  },
  webServer: { command: `pnpm exec vite --port ${PORT} --strictPort`, url: `http://127.0.0.1:${PORT}`, cwd: new URL("../..", import.meta.url).pathname, reuseExistingServer: false, timeout: 60_000 },
});
