import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRelay } from "./net/server.ts";
import { worldLoader } from "./net/world.ts";
import { createAiService, createAiHttpHandler } from "./ai/index.ts";

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1–65535");
  const ai=createAiService();
  const relay = createRelay({ loadWorld: worldLoader(resolve(process.env.PUBLIC_ROOT ?? "public")),
    handleHttp:createAiHttpHandler(ai),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean) });
  await relay.listen(port, process.env.HOST ?? "127.0.0.1");
  console.log(`Fog City relay listening on port ${port}`);
  const stop = (): void => { void relay.close().then(() => process.exit(0)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Relay startup failed");
  process.exitCode = 1;
});
