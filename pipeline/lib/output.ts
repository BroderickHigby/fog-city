// Deterministic, diff-friendly JSON: object keys in insertion order (the builders insert
// them in a fixed order), numbers already rounded by the builders, and selected arrays of
// records written one record per line so a data change shows up as a line change.

/** Serialise `obj`; arrays under `lineKeys` (top level only) get one element per line. */
export function jsonLines(obj: Record<string, unknown>, lineKeys: readonly string[]): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (lineKeys.includes(k) && Array.isArray(v)) {
      const body = v.map((e) => JSON.stringify(e)).join(",\n");
      parts.push(`${JSON.stringify(k)}: [${v.length ? `\n${body}\n` : ""}]`);
    } else {
      parts.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    }
  }
  return `{\n${parts.join(",\n")}\n}\n`;
}

export function jsonPretty(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
