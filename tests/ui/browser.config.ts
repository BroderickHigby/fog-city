import {defineConfig} from "@playwright/test";
export default defineConfig({
  testDir:import.meta.dirname,testMatch:"browser.spec.ts",workers:1,timeout:30000,outputDir:"../../test-results/ui",
  use:{baseURL:"http://127.0.0.1:4187",browserName:"chromium",viewport:{width:390,height:844},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}},
  webServer:{command:"pnpm exec vite --port 4187 --strictPort",url:"http://127.0.0.1:4187/tests/ui/fixture.html",cwd:new URL("../..",import.meta.url).pathname,reuseExistingServer:false,timeout:30000},
});
