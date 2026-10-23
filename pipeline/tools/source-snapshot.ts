// Record or verify the content hashes of every raw source response in the download cache.
//
//   node pipeline/tools/source-snapshot.ts --write [--cache <dir>]   hash the cache into pipeline/source-snapshot.json
//   node pipeline/tools/source-snapshot.ts [--cache <dir>]           verify a cache against it (exit 1 on any difference)
//
// The cache (pipeline/.cache/http, gitignored) holds one file per request URL plus a `.url`
// sidecar (pipeline/lib/fetch.ts). DataSF has no as-of queries and reloads its datasets daily, so
// a rebuild from a fresh download is only the pinned world if these bytes match. The manifest
// lists every URL with the SHA-256 and size of its body; `--check` of build-world.ts then proves
// the outputs. A deliberate refresh rewrites the manifest and bumps sources.snapshotDate in
// pipeline/areas.json in the same PR (docs/data-sources.md, "Snapshots").

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorldConfig } from "../lib/config.ts";

const ROOT = join(import.meta.dirname, "../..");
const MANIFEST = join(ROOT, "pipeline/source-snapshot.json");

interface Entry {
  url: string;
  sha256: string;
  bytes: number;
}
interface Snapshot {
  $comment: string;
  snapshotDate: string;
  files: number;
  bytes: number;
  entries: Entry[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hashCache(cacheDir: string): Entry[] {
  const dir = join(cacheDir, "http");
  if (!existsSync(dir)) throw new Error(`no download cache at ${dir}`);
  const out: Entry[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".url")).sort()) {
    const body = join(dir, f.slice(0, -".url".length));
    if (!existsSync(body)) continue;
    const url = readFileSync(join(dir, f), "utf8").trim();
    out.push({ url, sha256: createHash("sha256").update(readFileSync(body)).digest("hex"), bytes: statSync(body).size });
  }
  return out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

function main(): void {
  const cacheDir = arg("cache") ?? join(ROOT, "pipeline/.cache");
  const now = hashCache(cacheDir);
  if (process.argv.includes("--write")) {
    const snapshotDate = loadWorldConfig(ROOT, "sf").sources.snapshotDate ?? "unversioned";
    const snap: Snapshot = {
      $comment: "SHA-256 and size of every raw source response the sf world is built from (pipeline/tools/source-snapshot.ts). Verify a download cache with `node pipeline/tools/source-snapshot.ts --cache <dir>`.",
      snapshotDate,
      files: now.length,
      bytes: now.reduce((s, e) => s + e.bytes, 0),
      entries: now,
    };
    writeFileSync(MANIFEST, JSON.stringify(snap, null, 1) + "\n");
    console.log(`wrote ${MANIFEST}: ${snap.files} responses, ${snap.bytes} bytes, snapshot ${snapshotDate}`);
    return;
  }
  const pinned = JSON.parse(readFileSync(MANIFEST, "utf8")) as Snapshot;
  const have = new Map(now.map((e) => [e.url, e]));
  const missing: string[] = [];
  const differ: string[] = [];
  for (const e of pinned.entries) {
    const h = have.get(e.url);
    if (!h) missing.push(e.url);
    else if (h.sha256 !== e.sha256) differ.push(e.url);
  }
  const extra = now.filter((e) => !pinned.entries.some((p) => p.url === e.url)).length;
  console.log(`snapshot ${pinned.snapshotDate}: ${pinned.files} pinned, ${pinned.files - missing.length - differ.length} identical, ${differ.length} differ, ${missing.length} missing, ${extra} extra in cache`);
  for (const u of [...differ.map((u) => `differs: ${u}`), ...missing.map((u) => `missing: ${u}`)].slice(0, 20)) console.log(`  ${u}`);
  process.exit(missing.length || differ.length ? 1 : 0);
}

main();
