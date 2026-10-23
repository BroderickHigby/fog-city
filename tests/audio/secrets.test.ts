// No ElevenLabs secret reaches the source, the public assets or the static build: the key is
// read only by the build-time script (scripts/audio/generate-voices.ts) from the environment.
// Failures name the file only, never the matched text.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROOT } from "../helpers.ts";
import { buildWeb } from "../../scripts/build-web.ts";

/** ElevenLabs API keys: "sk_" then a long hex/alphanumeric run. */
const KEY_PATTERN = /sk_[A-Za-z0-9]{32,}/;
const HEADER = /xi-api-key/i;
const API_HOST = /api\.elevenlabs\.io/i;
/** The only files allowed to name the header and host: the generator, and this test. */
const ALLOWED = new Set(["scripts/audio/generate-voices.ts", "tests/audio/secrets.test.ts"]);
const TEXT = /\.(ts|js|mjs|json|html|md|txt|css|map|py|sh|svg|csv|xml)$/i;

function walk(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(ROOT, p).split("\\").join("/");
    if (skip(rel)) continue;
    if (e.isDirectory()) out.push(...walk(p, skip));
    else out.push(p);
  }
  return out;
}

/** The files among `files` that contain a pattern; for binaries, the latin1 view is scanned. */
function scan(files: readonly string[], base: string, patterns: readonly RegExp[]): string[] {
  const live = process.env.ELEVENLABS_API_KEY;
  const hits: string[] = [];
  for (const f of files) {
    if (statSync(f).size > 32_000_000) continue;
    const text = readFileSync(f).toString(TEXT.test(f) ? "utf8" : "latin1");
    const rel = relative(base, f).split("\\").join("/");
    for (const p of patterns) if (p.test(text)) hits.push(`${rel} matches ${p.source}`);
    if (live && live.length >= 16 && text.includes(live)) hits.push(`${rel} contains the live ELEVENLABS_API_KEY`);
  }
  return hits;
}

const skipDirs = (rel: string): boolean => /(^|\/)(node_modules|\.git|dist|test-results|playwright-report|\.cache|\.renders)$/.test(rel) || rel.startsWith("pipeline/.cache");

describe("ElevenLabs secrets", () => {
  it("no key-shaped string or the live key anywhere in the checkout's sources and assets", () => {
    const files = ["src", "public", "scripts", "assets", "content", "tests", "docs", "pipeline", "schemas", "server"].flatMap((d) => walk(join(ROOT, d), skipDirs));
    files.push(...["index.html", "vite.config.ts", "package.json", "CLAUDE.md", "README.md"].map((f) => join(ROOT, f)).filter(existsSync));
    expect(files.length).toBeGreaterThan(100);
    expect(scan(files.filter((f) => !f.endsWith("tests/audio/secrets.test.ts")), ROOT, [KEY_PATTERN])).toEqual([]);
  });

  it("the header and the API host appear only in the build-time generator", () => {
    const files = ["src", "public", "scripts", "assets", "content", "index.html"].flatMap((d) => (d.includes(".") ? [join(ROOT, d)] : walk(join(ROOT, d), skipDirs)));
    const hits = scan(files, ROOT, [HEADER, API_HOST]).filter((h) => !ALLOWED.has(h.split(" ")[0]!));
    expect(hits).toEqual([]);
    // And the generator reads the key from the environment, never from a file it writes.
    const generator = readFileSync(join(ROOT, "scripts/audio/generate-voices.ts"), "utf8");
    expect(generator).toContain("process.env.ELEVENLABS_API_KEY");
    expect(generator).not.toMatch(/console\.(log|error|warn)\([^)]*apiKey\(\)/);
  });

  describe("the static build", () => {
    let dir = "";
    afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

    it("ships the audio and carries no key, header or API host", async () => {
      dir = mkdtempSync(join(tmpdir(), "fogcity-audio-build-"));
      // A minimal world, so the real bundle and the real public/audio build in seconds.
      const pub = join(dir, "public");
      mkdirSync(join(pub, "tiles", "w"), { recursive: true });
      mkdirSync(join(pub, "models"), { recursive: true });
      writeFileSync(join(pub, "tiles", "w", "manifest.json"), JSON.stringify({ worldColliders: "world.colliders.bin", tiles: [] }));
      writeFileSync(join(pub, "tiles", "w", "world.colliders.bin"), new Uint8Array(16));
      cpSync(join(ROOT, "public", "audio"), join(pub, "audio"), { recursive: true });
      const out = join(dir, "dist");
      await buildWeb({ out, worlds: ["w"], level: 1, skipVite: false, publicDir: pub, sourcemap: true });
      const built = walk(out);
      const rel = built.map((f) => relative(out, f).split("\\").join("/"));
      // The audio the page fetches by URL is there, as plain files.
      for (const f of ["audio/spray.ogg", "audio/manifest.json", "audio/music/manifest.json", "audio/music/drive.ogg", "audio/music/drive.mp3", "audio/voice/manifest.json"]) expect(rel, f).toContain(f);
      expect(rel.some((f) => /^assets\/.*\.js$/.test(f))).toBe(true);
      expect(readFileSync(join(out, "third-party-notices.txt"), "utf8")).toMatch(/Music: CC0 1\.0/);
      expect(scan(built, out, [KEY_PATTERN, HEADER, API_HOST])).toEqual([]);
      // A second build into the same directory is allowed (audio/ is a build's own output).
      await buildWeb({ out, worlds: ["w"], level: 1, skipVite: true, publicDir: pub });
    }, 180_000);
  });
});
