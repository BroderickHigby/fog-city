// Run the Fog City relay: `pnpm relay` (PORT, HOST, ALLOWED_ORIGINS ...: see server/README.md).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRelay } from "./net/server.ts";
import { worldLoader, type WorldBundle } from "./net/world.ts";
import { verifiedArenas } from "./net/arenas.ts";
import { WORLDS, type WorldName } from "../src/net/protocol.ts";
import type { Spawn } from "../src/sim/contract.ts";

const int = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}–${max}`);
  return n;
};

export async function main(): Promise<void> {
  const port = int("PORT", 8787, 1, 65535);
  const host = process.env.HOST ?? "127.0.0.1";
  const names = (process.env.RELAY_WORLDS ?? "sf").split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of names) if (!WORLDS.includes(name as WorldName)) throw new Error(`RELAY_WORLDS: unknown world ${name}`);
  const load = worldLoader(resolve(process.env.PUBLIC_ROOT ?? "public"));
  const worlds = new Map<WorldName, WorldBundle>(), arenas = new Map<WorldName, Spawn[]>();
  for (const name of names as WorldName[]) {
    const bundle = await load(name);
    const usable = verifiedArenas(bundle.world);
    worlds.set(name, bundle); arenas.set(name, usable.map((a) => a.spawn));
    console.log(`world ${name}: fingerprint ${bundle.fingerprint}, ${usable.length} Bot Sweep arenas (${usable.map((a) => a.id).join(", ") || "none"})`);
  }
  const matchSeconds = int("RELAY_MATCH_SECONDS", 0, 0, 720);
  const relay = createRelay({
    worlds, arenas,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...(process.env.CLIENT_IP_HEADER ? { clientIpHeader: process.env.CLIENT_IP_HEADER } : {}),
    limits: {
      maxRooms: int("RELAY_MAX_ROOMS", 16, 1, 1000),
      maxConnections: int("RELAY_MAX_CONNECTIONS", 128, 1, 10000),
      maxConnectionsPerIp: int("RELAY_MAX_CONNECTIONS_PER_IP", 8, 1, 1000),
      maxRoomsPerIp: int("RELAY_MAX_ROOMS_PER_IP", 2, 1, 1000),
    },
    room: matchSeconds ? { matchTicks: matchSeconds * 60 } : {},
    log: (line) => console.log(line),
  });
  const bound = await relay.listen(port, host);
  console.log(`Fog City relay listening on ${host}:${bound} (ws path /relay, health /health)`);
  const stop = (): void => { void relay.close().then(() => process.exit(0)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Relay startup failed");
  process.exitCode = 1;
});
