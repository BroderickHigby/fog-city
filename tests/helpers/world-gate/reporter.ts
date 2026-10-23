// A Vitest reporter for the world gate's reminders. A metric that beats its baseline by 10% or
// less passes and only asks for the baseline to be lowered (ratchet.ts); Vitest's "minimal"
// reporter (its default under a coding agent) drops console output from passing tests, and the
// default one buries it among thousands of lines, so those reminders would go unseen and the slack
// would pile up. This reporter collects every "[world gate]" line the suites log,
// prints them together at the end of the run, and writes them to
// test-results/world-gate/reminders.txt.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserConsoleLog } from "vitest";
import type { Reporter } from "vitest/node";

// Loaded by vitest.config.ts in Vitest's main process: no imports from the test helpers (they pull
// in the sim), so these mirror ratchet.ts's ROOT and RECORD_DIR.
const ROOT = join(import.meta.dirname, "..", "..", "..");
const RECORD_DIR = "test-results/world-gate";
export const REMINDER_TAG = "[world gate]";
const FILE = join(ROOT, RECORD_DIR, "reminders.txt");

export default class WorldGateReporter implements Reporter {
  private lines: string[] = [];

  onTestRunStart(): void {
    this.lines = [];
    rmSync(FILE, { force: true });
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    for (const line of log.content.split("\n")) {
      const at = line.indexOf(REMINDER_TAG);
      if (at >= 0) this.lines.push(line.slice(at + REMINDER_TAG.length).trim());
    }
  }

  onTestRunEnd(): void {
    if (!this.lines.length) return;
    const lines = [...new Set(this.lines)].sort();
    mkdirSync(join(ROOT, RECORD_DIR), { recursive: true });
    writeFileSync(FILE, lines.join("\n") + "\n");
    const out = [``, `World gate: ${lines.length} reminder${lines.length > 1 ? "s" : ""} (passing, but the baseline has slack; \`pnpm world:baseline\` lowers it):`, ...lines.map((l) => `  - ${l}`), `  (also in ${RECORD_DIR}/reminders.txt)`, ``];
    process.stdout.write(out.join("\n") + "\n");
  }
}
