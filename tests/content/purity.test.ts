// src/content is pure and portable: deterministic generators with their own PRNG, no clock,
// no ambient randomness, no DOM or network, and no dependency on the sim's state or engine.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../helpers.ts";

// [pattern, why, checkInsideStringLiterals]
const FORBIDDEN: Array<[RegExp, string, boolean]> = [
  [/Math\.random/, "use src/content/prng.ts", false],
  [/Date\.now|new Date\(|performance\.now/, "content generation has no clock", false],
  [/\b(window|document|fetch|localStorage|XMLHttpRequest|WebSocket)\b/, "no DOM or network", false],
  [/from ["'](three|@dimforge)/, "no rendering or physics engines", true],
  [/from ["'][./]*\/sim\//, "content must not depend on the sim (own PRNG, no SimState)", true],
  [/from ["']node:/, "src/content also runs in the browser", true],
];

describe("src/content forbidden APIs", () => {
  const dir = join(ROOT, "src/content");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    it(`src/content/${f}`, () => {
      const code = readFileSync(join(dir, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      // Same code with string literals blanked, so a union member like "window" is not a DOM access.
      const bare = code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
      for (const [re, why, inStrings] of FORBIDDEN) expect(re.test(inStrings ? code : bare), `${f}: ${re} (${why})`).toBe(false);
    });
  }
});
