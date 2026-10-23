// The sim's bad-robot rate (src/sim/agents/bad-rate.ts) and the guard on what the sim may take
// from src/content/places.ts. tests/sim/forbidden-apis.test.ts scans only src/sim, but places.ts
// is Content's file and measures distance with Math.hypot (engine-dependent in its last bit), so
// the sim must not call any places.ts function that does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MOAT_SITES, badRobotRate } from "../../../src/content/places.ts";
import { toLatLon, toLocal } from "../../../src/geo/project.ts";
import { badRobotRateAt } from "../../../src/sim/agents/bad-rate.ts";
import { ROOT } from "../../helpers.ts";

/** What src/sim may import from places.ts: data, and functions checked below to be portable. */
const ALLOWED_DATA = ["ACTIVITIES", "BASELINE_BAD_RATE", "DISTRICTS", "INSTANCES", "MODES", "MOAT_SITES", "PROTECTED_AREAS", "SAFEHOUSE_RADIUS_M", "SITES"];
/** Each allowed function with every places.ts helper it calls. */
const ALLOWED_FUNCTIONS: Record<string, string[]> = { protectedAreaAt: ["pointInPolygon", "xz"], pointInPolygon: ["xz"] };
const PORTABLE = /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt|random)\b|\*\*/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
/** The source of one top-level function or arrow constant in places.ts. */
function sourceOf(src: string, name: string): string {
  const start = src.search(new RegExp(`^(export )?(function ${name}\\(|const ${name} =)`, "m"));
  if (start < 0) throw new Error(`no ${name} in places.ts`);
  const rest = src.slice(start);
  const end = rest.startsWith("const") ? rest.indexOf(";\n") : rest.indexOf("\n}\n");
  return rest.slice(0, end + 2);
}

describe("the sim's bad-robot rate", () => {
  it("is content's badRobotRate, bit for bit wherever hypot and sqrt agree", () => {
    let exact = 0;
    let points = 0;
    const check = (x: number, z: number): void => {
      points++;
      const p = toLatLon(x, z);
      const ours = badRobotRateAt(x, z);
      const theirs = badRobotRate([p.lat, p.lon]);
      const q = toLocal(p.lat, p.lon);
      const agree = MOAT_SITES.every((s) => {
        const c = toLocal(s.lat, s.lon);
        const dx = q.x - c.x, dz = q.z - c.z;
        return Math.hypot(dx, dz) === Math.sqrt(dx * dx + dz * dz);
      });
      if (agree) {
        exact++;
        expect(ours, `${x},${z}`).toBe(theirs);
      } else expect(Math.abs(ours - theirs), `${x},${z}`).toBeLessThan(1e-12);
    };
    // Across the city, and densely around every Moat Labs site (inside and past its falloff).
    for (let x = -6000; x <= 3000; x += 250) for (let z = -2500; z <= 9000; z += 250) check(x, z);
    for (const s of MOAT_SITES) {
      const c = toLocal(s.lat, s.lon);
      for (let i = 0; i < 400; i++) {
        const r = (s.falloffM * 1.2 * i) / 400;
        check(c.x + r * Math.cos(i * 2.399), c.z + r * Math.sin(i * 2.399));
      }
    }
    // (V8's hypot differs from sqrt in the last bit for most of these points: the reason for the helper.)
    expect(points).toBeGreaterThan(2000);
    expect(exact).toBeGreaterThan(200);
  });

  it("varies with the Moat Labs sites as the design says", () => {
    const site = MOAT_SITES.find((s) => s.kind === "hq")!;
    const c = toLocal(site.lat, site.lon);
    expect(badRobotRateAt(c.x, c.z)).toBeGreaterThan(badRobotRateAt(c.x + site.falloffM * 2, c.z));
  });
});

describe("src/sim takes only portable code from src/content/places.ts", () => {
  const places = readFileSync(join(ROOT, "src/content/places.ts"), "utf8");
  const code = (src: string): string => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  for (const name of Object.keys(ALLOWED_FUNCTIONS)) {
    it(`${name} and what it calls use no engine-dependent maths`, () => {
      for (const part of [name, ...ALLOWED_FUNCTIONS[name]!]) expect(PORTABLE.test(code(sourceOf(places, part))), part).toBe(false);
    });
  }
  it("src/geo/project.ts, which the sim and places.ts both use, has no engine-dependent maths", () => {
    expect(PORTABLE.test(code(readFileSync(join(ROOT, "src/geo/project.ts"), "utf8")))).toBe(false);
  });

  it("no file in src/sim imports anything else from places.ts (badRobotRate, distanceM, ...)", () => {
    const allowed = new Set([...ALLOWED_DATA, ...Object.keys(ALLOWED_FUNCTIONS)]);
    const bad: string[] = [];
    let importers = 0;
    for (const f of files(join(ROOT, "src/sim"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*["'][./]*\/content\/places(\.ts)?["']/g)) {
        importers++;
        if (m[1]) continue;
        for (const raw of m[2]!.split(",")) {
          const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!;
          if (name && !raw.trim().startsWith("type ") && !allowed.has(name)) bad.push(`${f.slice(ROOT.length + 1)}: ${name}`);
        }
      }
      if (/import\s*\*\s*as\s+\w+\s+from\s*["'][./]*\/content\/places/.test(src) || /import\(["'][./]*\/content\/places/.test(src)) bad.push(`${f.slice(ROOT.length + 1)}: namespace or dynamic import`);
    }
    expect(importers).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
