// Raw inputs of the street-detail layers (pipeline/build-street-detail.ts): DataSF datasets
// downloaded through the cache (fetch.ts), each response pinned by SHA-256 in
// pipeline/street-detail-snapshot.json. A build whose download differs from the pinned
// snapshot fails unless --refresh is given (a deliberate PR that moves the snapshot date).
// Licences were read from each dataset's metadata (`/api/views/<id>.json`, `license`) on
// 2026-10-23: every one is ODC PDDL 1.0. Only the columns used are requested.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cachedGet, socrataUrl, type FetchOptions } from "./fetch.ts";

export interface DatasetSpec {
  key: string;
  id: string;
  title: string;
  publisher: string;
  where: string;
  select: string;
  order: string;
}

export const STREET_DETAIL_DATASETS: readonly DatasetSpec[] = [
  {
    key: "continental",
    id: "g9zy-srvv",
    title: "Continental Crosswalks",
    publisher: "SFMTA",
    where: "cnn IS NOT NULL",
    select: "cnn,continental",
    order: "cnn",
  },
  {
    key: "stopSigns",
    id: "4542-gpa3",
    title: "Stop Signs",
    publisher: "SFMTA",
    where: "cnn IS NOT NULL",
    select: "objectid,cnn,street,x_street,st_facing,direction",
    order: "objectid",
  },
  {
    key: "streetSigns",
    id: "m48z-6ji4",
    title: "Street Signs",
    publisher: "SFMTA",
    where:
      "status_code = 'IS' AND shape IS NOT NULL AND sign_category IN ('STREET NAME', 'ONE WAY(RA)', 'ONE WAY(LA)', 'STREET CLEANING', 'PARKING', 'PARKING:RPP', 'PARKING:NPRK ANY TIME', 'TOW (TANP ANY TIME)')",
    select: "objectid,sign_category,legend,sign_support,streetname,corner_side_facing,cnn,shape",
    order: "objectid",
  },
];

export const LICENCE = "ODC PDDL 1.0";

export interface SnapshotEntry {
  url: string;
  sha256: string;
  bytes: number;
}

export interface Snapshot {
  $comment: string;
  snapshotDate: string;
  entries: SnapshotEntry[];
}

const PAGE = 50000;

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * Every row of every dataset, in the order each query asks for, with the responses checked
 * against (or, with `refresh`, recorded into) the snapshot.
 */
export async function downloadStreetDetail(
  opts: FetchOptions & { snapshotFile: string; refresh?: boolean; today?: string },
): Promise<{ rows: Record<string, Array<Record<string, string>>>; snapshot: Snapshot; changed: boolean }> {
  const pinned: Snapshot | null = existsSync(opts.snapshotFile) ? (JSON.parse(readFileSync(opts.snapshotFile, "utf8")) as Snapshot) : null;
  const known = new Map((pinned?.entries ?? []).map((e) => [e.url, e]));
  const entries: SnapshotEntry[] = [];
  const rows: Record<string, Array<Record<string, string>>> = {};
  let changed = false;
  for (const d of STREET_DETAIL_DATASETS) {
    const out: Array<Record<string, string>> = [];
    for (let offset = 0; ; offset += PAGE) {
      const url = socrataUrl(d.id, { $where: d.where, $select: d.select, $order: d.order, $limit: PAGE, $offset: offset });
      const body = await cachedGet(url, "json", opts);
      const entry = { url, sha256: sha256(body), bytes: body.byteLength };
      const pin = known.get(url);
      if (pin && pin.sha256 !== entry.sha256 && !opts.refresh) {
        throw new Error(`${d.id} (${d.title}): response differs from the pinned snapshot (${pin.sha256.slice(0, 12)} -> ${entry.sha256.slice(0, 12)}); rebuild with --refresh to move the snapshot deliberately`);
      }
      if (!pin || pin.sha256 !== entry.sha256) changed = true;
      entries.push(entry);
      const page = JSON.parse(body.toString("utf8")) as unknown;
      if (!Array.isArray(page)) throw new Error(`${d.id}: unexpected response ${body.toString("utf8").slice(0, 200)}`);
      out.push(...(page as Array<Record<string, string>>));
      if (page.length < PAGE) break;
    }
    rows[d.key] = out;
  }
  if (pinned && pinned.entries.length !== entries.length) changed = true;
  const snapshot: Snapshot = {
    $comment:
      "SHA-256 and size of every DataSF response the street-detail layers are built from (pipeline/build-street-detail.ts). A rebuild whose download differs fails unless run with --refresh.",
    snapshotDate: changed || !pinned ? (opts.today ?? new Date().toISOString().slice(0, 10)) : pinned.snapshotDate,
    entries,
  };
  return { rows, snapshot, changed };
}

export function writeSnapshot(file: string, s: Snapshot): void {
  writeFileSync(file, `${JSON.stringify(s, null, 1)}\n`);
}

/** Attribution line for the datasets used. */
export function streetDetailAttribution(keys: readonly string[]): string {
  const used = STREET_DETAIL_DATASETS.filter((d) => keys.includes(d.key));
  return `${used.map((d) => `${d.title}: ${d.publisher} via DataSF (${d.id})`).join("; ")}, ${LICENCE}.`;
}
