// src/sim must stay deterministic and portable: no engine-dependent maths, no clock,
// no ambient randomness, no rendering, DOM or network imports.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../helpers.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt|random)\b/, "use dmath.ts / rng.ts"],
  [/\*\*/, "exponent operator compiles to Math.pow; multiply instead"],
  [/Date\.now|new Date\(|performance\.now/, "the sim has no clock; use state.tick"],
  [/from ["'](three|@dimforge)/, "no rendering or physics engines in the sim"],
  [/\b(window|document|fetch|localStorage|XMLHttpRequest|WebSocket)\b/, "no DOM or network in the sim"],
];

describe("src/sim forbidden APIs", () => {
  for (const f of files(join(ROOT, "src/sim"))) {
    const rel = f.slice(ROOT.length + 1);
    it(rel, () => {
      const src = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [re, why] of FORBIDDEN) expect(re.test(src), `${rel}: ${re} (${why})`).toBe(false);
    });
  }
});
