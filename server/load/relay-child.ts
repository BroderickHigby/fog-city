// The relay under load (forked by load-test.ts): the SF world, the real tick loop, limits raised so
// one loopback address can open every test client. Tells the parent its port over IPC.
import { resolve } from "node:path";
import { createRelay } from "../net/server.ts";
import { worldLoader } from "../net/world.ts";
import { verifiedArenas } from "../net/arenas.ts";

const bundle = await worldLoader(resolve("public"))("sf");
const relay = createRelay({
  worlds: new Map([["sf", bundle]]), arenas: new Map([["sf", verifiedArenas(bundle.world).map((a) => a.spawn)]]),
  limits: { maxRooms: 256, maxMatches: 256, maxConnections: 2048, maxConnectionsPerIp: 2048, maxRoomsPerIp: 256, maxMessagesPerIpPerSecond: 1_000_000 },
});
const port = await relay.listen(0);
process.send?.({ port, fingerprint: bundle.fingerprint });
process.on("disconnect", () => { void relay.close().then(() => process.exit(0)); });
