// Global setup for `pnpm shots`: start from an empty test-results/shots/ so the contact sheet
// never shows a picture left over from an older run.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export default function setup(): void {
  const dir = join(import.meta.dirname, "..", "..", "test-results", "shots");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
