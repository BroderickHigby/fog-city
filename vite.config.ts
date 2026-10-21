import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// virtual:fogcity-assets — what other tracks have produced so far, read at dev/build time:
//   models:    paths of public/models/**/*.glb, relative to public/ ("models/x.glb")
//   landmarks: content/landmarks.json parsed, or null when absent or unreadable
// The renderer requests only files listed here, so a model that does not exist yet costs
// no request and no console error. The dev server reloads the page when either changes.
function fogcityAssets(): Plugin {
  const id = "virtual:fogcity-assets";
  const resolved = "\0" + id;
  const root = resolve(import.meta.dirname);
  const modelsDir = join(root, "public", "models");
  const landmarksFile = join(root, "content", "landmarks.json");
  const listModels = (dir: string, rel: string): string[] => {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) out.push(...listModels(join(dir, e.name), r));
      else if (e.name.toLowerCase().endsWith(".glb")) out.push(r);
    }
    return out.sort();
  };
  const readLandmarks = (): unknown => {
    try {
      return existsSync(landmarksFile) ? (JSON.parse(readFileSync(landmarksFile, "utf8")) as unknown) : null;
    } catch {
      return null;
    }
  };
  return {
    name: "fogcity-assets",
    resolveId(source) {
      return source === id ? resolved : null;
    },
    load(source) {
      if (source !== resolved) return null;
      if (existsSync(landmarksFile)) this.addWatchFile(landmarksFile);
      const models = listModels(modelsDir, "models");
      return `export const models = ${JSON.stringify(models)};\nexport const landmarks = ${JSON.stringify(readLandmarks())};\n`;
    },
    configureServer(server) {
      const refresh = (file: string): void => {
        if (!file.startsWith(modelsDir) && file !== landmarksFile) return;
        const mod = server.moduleGraph.getModuleById(resolved);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.add([modelsDir, landmarksFile]);
      server.watcher.on("add", refresh);
      server.watcher.on("unlink", refresh);
      server.watcher.on("change", refresh);
    },
  };
}

// base "./": every URL in the built page is relative, so dist/ works from any sub-path.
// public/ is not copied into the build: scripts/build-web.ts (pnpm build) writes the world and
// the models into dist/ in the packed layout the page host accepts (src/io/assets.ts).
export default defineConfig({
  base: "./",
  plugins: [fogcityAssets()],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: { target: "es2023", sourcemap: true, copyPublicDir: false, chunkSizeWarningLimit: 2000 },
});
