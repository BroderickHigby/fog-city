import {defineConfig} from "@playwright/test";
import {SWIFTSHADER_ARGS} from "../../playwright.config.ts";
export default defineConfig({
  testDir:import.meta.dirname,testMatch:"game.spec.ts",workers:1,timeout:180000,outputDir:"../../test-results/gameplay",
  use:{baseURL:"http://127.0.0.1:4189",browserName:"chromium",viewport:{width:960,height:540},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:SWIFTSHADER_ARGS}},
  webServer:{command:"pnpm exec vite --port 4189 --strictPort",url:"http://127.0.0.1:4189",cwd:new URL("../..",import.meta.url).pathname,reuseExistingServer:false,timeout:30000},
});
