/** Original route/plateau assertions, strict1024MiB capacity settings and extra metadata. Prepared only. */
import {defineConfig} from "@playwright/test";
import original from "../../../tests/render/soak.config.ts";
const target=process.env.FOG_MEMORY_TARGET_URL;
if(!target)throw new Error("Provide the explicitly approved immutable packed target URL in FOG_MEMORY_TARGET_URL");
if(!process.env.FOG_MEMORY_SOURCE_ID)throw new Error("Provide the exact immutable packed/source identity in FOG_MEMORY_SOURCE_ID");
const previous=original.use?.launchOptions,args=(previous?.args??[]).filter(arg=>!arg.startsWith("--js-flags="));
export default defineConfig({...original,testDir:import.meta.dirname,testMatch:"browser-memory-1gb.spec.ts",
 timeout:900_000,globalTimeout:900_000,webServer:undefined,
 reporter:[["list"],[new URL("./browser-partial-reporter.ts",import.meta.url).pathname]],
 outputDir:new URL("./browser-output",import.meta.url).pathname,
 use:{...original.use,baseURL:target,launchOptions:{...previous,...(process.env.FOG_MEMORY_CHROME_PATH?{executablePath:process.env.FOG_MEMORY_CHROME_PATH}:{}),args:[...args,"--js-flags=--expose-gc --max-old-space-size=1024","--enable-precise-memory-info"]}},
});
