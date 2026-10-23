// What the sim may take from src/content/places.ts (Content's file). tests/sim/forbidden-apis.test.ts
// scans only src/sim, but the agents runtime draws each robot's firmware from places.ts
// badRobotRate, so an engine-dependent call there (it used Math.hypot until eb79039)
// would let one browser draw different firmware than another. src/sim may import only data and
// the functions listed here, and this checks each of them, and every places.ts helper it calls,
// for engine-dependent maths.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../helpers.ts";

const ALLOWED_DATA = ["ACTIVITIES", "BASELINE_BAD_RATE", "DISTRICTS", "INSTANCES", "MODES", "MOAT_SITES", "PROTECTED_AREAS", "SAFEHOUSE_RADIUS_M", "SITES"];
/** Each function src/sim may call, with every places.ts helper it calls. */
const ALLOWED_FUNCTIONS: Record<string, string[]> = {
  badRobotRate: ["protectedAreaAt", "pointInPolygon", "distanceM", "xz"],
  protectedAreaAt: ["pointInPolygon", "xz"],
  pointInPolygon: ["xz"],
};
const PORTABLE = /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt|random)\b|\*\*|Date\.now|new Date\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const code = (src: string): string => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
/** The source of one top-level function or arrow constant in places.ts. */
function sourceOf(src: string, name: string): string {
  const start = src.search(new RegExp(`^(export )?(function ${name}\\(|const ${name} =)`, "m"));
  if (start < 0) throw new Error(`no ${name} in places.ts`);
  const rest = src.slice(start);
  return rest.slice(0, (rest.startsWith("const") ? rest.indexOf(";\n") : rest.indexOf("\n}\n")) + 2);
}

describe("src/sim takes only portable code from src/content/places.ts", () => {
  const places = readFileSync(join(ROOT, "src/content/places.ts"), "utf8");

  for (const name of Object.keys(ALLOWED_FUNCTIONS)) {
    it(`${name} and what it calls use no engine-dependent maths`, () => {
      for (const part of [name, ...ALLOWED_FUNCTIONS[name]!]) expect(PORTABLE.test(code(sourceOf(places, part))), part).toBe(false);
    });
  }
  it("src/geo/project.ts, which the sim and places.ts both use, has no engine-dependent maths", () => {
    expect(PORTABLE.test(code(readFileSync(join(ROOT, "src/geo/project.ts"), "utf8")))).toBe(false);
  });

  it("no file in src/sim imports anything else from places.ts", () => {
    const allowed = new Set([...ALLOWED_DATA, ...Object.keys(ALLOWED_FUNCTIONS)]);
    const bad: string[] = [];
    let importers = 0;
    for (const f of files(join(ROOT, "src/sim"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*["'][./]*\/content\/places(\.ts)?["']/g)) {
        importers++;
        if (m[1]) continue;
        for (const raw of m[2]!.split(",")) {
          const item = raw.trim();
          const name = item.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!;
          if (name && !item.startsWith("type ") && !allowed.has(name)) bad.push(`${f.slice(ROOT.length + 1)}: ${name}`);
        }
      }
      if (/import\s*\*\s*as\s+\w+\s+from\s*["'][./]*\/content\/places/.test(src) || /import\(["'][./]*\/content\/places/.test(src)) bad.push(`${f.slice(ROOT.length + 1)}: namespace or dynamic import`);
    }
    expect(importers).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
