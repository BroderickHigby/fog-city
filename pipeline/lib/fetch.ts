// Cached, polite HTTP for the pipeline.
//
// Every response body is stored under pipeline/.cache/http/<sha256(url)>.<ext> with a
// sidecar .url file naming the request. A cached URL is never fetched again unless
// --refresh is given, so a rebuild from cache is offline and byte-identical.
// Requests are made one at a time (the build awaits each before the next, which keeps
// DataSF's "425 Too Early" throttling rare) and retried with exponential backoff.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FetchOptions {
  cacheDir: string;
  /** Refetch even if the URL is cached. */
  refresh?: boolean;
  /** Fail instead of touching the network when the URL is not cached. */
  offline?: boolean;
  log?: (msg: string) => void;
}

export class CacheMiss extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function cachePath(cacheDir: string, url: string, ext: string): string {
  const h = createHash("sha256").update(url).digest("hex").slice(0, 32);
  return join(cacheDir, "http", `${h}.${ext}`);
}

/** GET a URL through the cache. Returns the raw body. */
export async function cachedGet(url: string, ext: string, opts: FetchOptions): Promise<Buffer> {
  const file = cachePath(opts.cacheDir, url, ext);
  if (!opts.refresh && existsSync(file)) return readFileSync(file);
  if (opts.offline) throw new CacheMiss(`not cached (offline): ${url}`);
  mkdirSync(join(opts.cacheDir, "http"), { recursive: true });
  const body = await getWithRetry(url, opts.log);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
  writeFileSync(`${file}.url`, `${url}\n`);
  return body;
}

async function getWithRetry(url: string, log?: (msg: string) => void): Promise<Buffer> {
  const attempts = 6;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 180_000);
      try {
        const res = await fetch(url, {
          signal: ctl.signal,
          redirect: "follow",
          headers: { "user-agent": "fog-city-pipeline/1 (offline world builder)", accept: "*/*" },
        });
        if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) {
          const text = (await res.text()).slice(0, 400);
          throw Object.assign(new Error(`HTTP ${res.status} for ${url}: ${text}`), { fatal: true });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return buf;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
      lastErr = err;
      const wait = 1000 * 2 ** i + Math.floor(Math.random() * 500);
      log?.(`  retry ${i + 1}/${attempts - 1} in ${wait} ms: ${(err as Error).message}`);
      if (i < attempts - 1) await sleep(wait);
    }
  }
  throw new Error(`giving up on ${url}: ${(lastErr as Error)?.message}`);
}

/** Socrata (SODA 2.x) query. Values in `params` are SoQL clauses ($where, $select, $order...). */
export function socrataUrl(dataset: string, params: Record<string, string | number>): string {
  const q = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `https://data.sfgov.org/resource/${dataset}.json?${q}`;
}

/**
 * Fetch every row of a Socrata query, paging with $limit/$offset over a stable $order.
 * Each page is cached separately so an interrupted download resumes.
 */
export async function socrataAll<T>(
  dataset: string,
  query: { where: string; select?: string; order: string },
  opts: FetchOptions,
  pageSize = 5000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const params: Record<string, string | number> = { $where: query.where, $order: query.order, $limit: pageSize, $offset: offset };
    if (query.select) params.$select = query.select;
    const url = socrataUrl(dataset, params);
    const body = await cachedGet(url, "json", opts);
    let page: unknown;
    try {
      page = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error(`${dataset}: response is not JSON (offset ${offset}); delete ${cachePath(opts.cacheDir, url, "json")} and retry`);
    }
    if (!Array.isArray(page)) throw new Error(`${dataset}: unexpected response ${body.toString("utf8").slice(0, 300)}`);
    rows.push(...(page as T[]));
    if (page.length < pageSize) break;
  }
  return rows;
}
