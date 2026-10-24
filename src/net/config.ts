// Where the relay is. The static client is built with RELAY_URL (vite.config.ts defines
// __FOGCITY_RELAY_URL__); without one, the game boots and plays single-player with no lobby.
// A ?relay= page parameter may point at a relay on this machine (local testing), never at a
// remote host: a link must not be able to send players' inputs somewhere else.

declare const __FOGCITY_RELAY_URL__: string | undefined;

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A ws:// or wss:// URL, or null when it is not one. Plain ws:// only to this machine. */
export function normalizeRelayUrl(raw: string | null | undefined, allowRemote: boolean): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    const local = LOCAL.has(url.hostname);
    if (!allowRemote && !local) return null;
    if (url.protocol === "ws:" && !local) return null;
    if (url.pathname === "/" || url.pathname === "") url.pathname = "/relay";
    return url.href;
  } catch { return null; }
}

/** The relay for this page: the ?relay= override (loopback only), else the build's RELAY_URL. */
export function relayUrl(search: string = typeof location === "undefined" ? "" : location.search): string | null {
  const local = normalizeRelayUrl(new URLSearchParams(search).get("relay"), false);
  if (local) return local;
  const built = typeof __FOGCITY_RELAY_URL__ === "string" ? __FOGCITY_RELAY_URL__ : "";
  return normalizeRelayUrl(built, true);
}
