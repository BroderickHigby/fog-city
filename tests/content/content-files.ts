// Shared by the content tests: every JSON file under content/ that this track owns.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers.ts";

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? jsonFiles(p) : p.endsWith(".json") ? [p] : [];
  });
}

/** Repo-relative paths ("content/brands.json"), sorted; landmarks.json belongs to the assets track. */
export const CONTENT_FILES: readonly string[] = jsonFiles(join(ROOT, "content"))
  .map((f) => f.slice(ROOT.length + 1))
  .filter((f) => f !== "content/landmarks.json")
  .sort();

export function readContent(rel: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}
