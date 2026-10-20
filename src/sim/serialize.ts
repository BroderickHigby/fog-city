// Canonical serialisation: sorted keys, so equal states give equal strings on every
// engine. Used for snapshots, replays, netcode checksums and golden tests.

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`non-finite number in sim state: ${v}`);
  if (v === undefined) throw new Error("undefined in sim state");
  return v;
}

/** FNV-1a 32-bit hash of the canonical JSON, as 8 hex chars. */
export function hashState(value: unknown): string {
  const s = canonicalJson(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
