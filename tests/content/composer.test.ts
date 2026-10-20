// The name composer and content/banned-pairs.json (docs/ai-layer.md, 3.2 and Validation):
// every composed two-part startup or player name, with and without its space, passes the content
// lint or is a banned pair; the list holds nothing stale; the composer never returns a banned pair.
//
// Regenerate the list after changing name-parts.json or the lint:
//   UPDATE_BANNED_PAIRS=1 npx vitest run tests/content/composer.test.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BANNED_PAIRS, COMPOSED_NAME_MAX, NAME_PARTS, POOLS_OF, checkNameParts, composeName, composeStartupName, isBannedPair, lintFailingPairs,
  nameLintReason, namePart, pairLintReason, playerNameFor, startupNameFor, type BannedPair, type NameKind,
} from "../../src/content/composer.ts";
import { ROOT } from "../helpers.ts";

const KINDS: readonly NameKind[] = ["startup", "player"];
const total = Object.values(NAME_PARTS.pools).reduce((n, p) => n + p.length, 0);

describe("name parts", () => {
  it("about 600 pre-cleared parts in four pools", () => {
    expect(total).toBeGreaterThanOrEqual(600);
    expect(NAME_PARTS.pools.startupHead.length).toBeGreaterThanOrEqual(150);
    expect(NAME_PARTS.pools.startupTail.length).toBeGreaterThanOrEqual(40);
    expect(NAME_PARTS.pools.playerAdjective.length).toBeGreaterThanOrEqual(150);
    expect(NAME_PARTS.pools.playerNoun.length).toBeGreaterThanOrEqual(150);
  });

  it("every part passes the name lint alone; ids and texts are unique; banned pairs name real parts", () => {
    expect(checkNameParts()).toEqual([]);
  });

  it("startup heads leave out words that are real tech, robotics or transport companies", () => {
    const heads = new Set(NAME_PARTS.pools.startupHead.map((p) => p.id));
    for (const w of ["otter", "toast", "miso", "pinecone", "willow", "heron", "gecko", "pickle", "gadget", "whisk", "latch", "ramen", "moat"]) {
      expect(heads.has(w), w).toBe(false);
    }
  });

  it("nameLintReason rejects what it must", () => {
    expect(nameLintReason("DaffodilDock")).toMatch(/offensive/);
    expect(nameLintReason("Glad Pelican")).toMatch(/brand/); // "gladpelican" contains "ADP"
    expect(nameLintReason("A".repeat(COMPOSED_NAME_MAX + 1))).toMatch(/length/);
    expect(nameLintReason("Kelp Labs")).toBeNull();
  });
});

// The property test, chunked by first part so no single test runs long.
const CHUNK = 24;
const chunks: Array<{ kind: NameKind; from: number; to: number }> = [];
for (const kind of KINDS) {
  const n = NAME_PARTS.pools[POOLS_OF[kind][0]].length;
  for (let from = 0; from < n; from += CHUNK) chunks.push({ kind, from, to: Math.min(n, from + CHUNK) });
}
const bannedBy = new Map(BANNED_PAIRS.pairs.map((p) => [`${p.kind}:${p.a}+${p.b}`, p]));

describe("every composed name passes the lint or is a banned pair", () => {
  for (const { kind, from, to } of chunks) {
    it(`${kind} names, first parts ${from}-${to - 1}`, () => {
      const [pa, pb] = POOLS_OF[kind];
      const missing: string[] = [];
      const stale: string[] = [];
      for (const a of NAME_PARTS.pools[pa].slice(from, to)) {
        for (const b of NAME_PARTS.pools[pb]) {
          const reason = pairLintReason(kind, a.id, b.id);
          const listed = bannedBy.get(`${kind}:${a.id}+${b.id}`);
          if (reason && !listed) missing.push(`${a.id}+${b.id}: ${reason}`);
          if (!reason && listed?.source === "lint") stale.push(`${a.id}+${b.id} is listed as a lint failure but passes now`);
        }
      }
      expect(missing, "add with UPDATE_BANNED_PAIRS=1").toEqual([]);
      expect(stale, "regenerate with UPDATE_BANNED_PAIRS=1").toEqual([]);
    });
  }

  it("hand-added pairs pass the lint (otherwise they would be lint rows) and are listed once", () => {
    const hand = BANNED_PAIRS.pairs.filter((p) => p.source === "hand");
    expect(hand.length).toBeGreaterThan(0);
    for (const h of hand) expect(pairLintReason(h.kind, h.a, h.b), `${h.a}+${h.b}`).toBeNull();
    expect(new Set(BANNED_PAIRS.pairs.map((p) => `${p.kind}:${p.a}+${p.b}`)).size).toBe(BANNED_PAIRS.pairs.length);
  });

  it.skipIf(!process.env.UPDATE_BANNED_PAIRS)(
    "UPDATE_BANNED_PAIRS: rewrite content/banned-pairs.json",
    () => {
      const pairs: BannedPair[] = [];
      for (const kind of KINDS) for (const f of lintFailingPairs(kind)) pairs.push({ kind, a: f.a, b: f.b, source: "lint", reason: f.reason });
      const keys = new Set(pairs.map((p) => `${p.kind}:${p.a}+${p.b}`));
      for (const h of BANNED_PAIRS.pairs) if (h.source === "hand" && !keys.has(`${h.kind}:${h.a}+${h.b}`)) pairs.push(h);
      pairs.sort((x, y) => (`${x.kind}${x.a}+${x.b}` < `${y.kind}${y.a}+${y.b}` ? -1 : 1));
      const doc = { version: 1, $comment: (BANNED_PAIRS as unknown as { $comment: string }).$comment, pairs };
      let s = JSON.stringify(doc, null, 2);
      s = s.replace(/\{\n\s+("kind"[^{}]*?)\n\s+\}/g, (_m, inner: string) => `{ ${inner.replace(/\n\s+/g, " ")} }`);
      writeFileSync(join(ROOT, "content/banned-pairs.json"), `${s}\n`);
    },
    120_000,
  );
});

describe("the composer never returns a banned pair", () => {
  it("every banned pair asked for directly gets the next-ranked acceptable name", () => {
    for (const p of BANNED_PAIRS.pairs) {
      const n = composeName(p.kind, [p.a], [p.b], "test");
      expect(isBannedPair(p.kind, n.parts[0], n.parts[1]), `${p.a}+${p.b} -> ${n.parts.join("+")}`).toBe(false);
      expect(pairLintReason(p.kind, n.parts[0], n.parts[1])).toBeNull();
      expect(n.parts).not.toEqual([p.a, p.b]);
      // It keeps the first part and takes the next-ranked second part.
      expect(n.parts[0]).toBe(p.a);
      expect(n.text.length).toBeLessThanOrEqual(COMPOSED_NAME_MAX);
    }
  });

  it("takes the next-ranked second part, in rank order", () => {
    const n = composeStartupName("daffodil", ["dock-c", "labs", "ai"]);
    expect(n.parts).toEqual(["daffodil", "labs"]);
    expect(n.text).toBe("Daffodil Labs");
    expect(composeStartupName("kelp", "stack-c").text).toBe("KelpStack");
    expect(composeStartupName("kelp", "labs").compact).toBe("KelpLabs");
  });

  it("unknown ids are skipped, and a name still comes back", () => {
    const n = composeStartupName("no-such-head", "no-such-tail", "k");
    expect(namePart("startupHead", n.parts[0])).toBeDefined();
    expect(namePart("startupTail", n.parts[1])).toBeDefined();
    expect(isBannedPair("startup", n.parts[0], n.parts[1])).toBe(false);
  });

  it("2,000 seeded names: never banned, always lint-clean, never too long", () => {
    for (let i = 0; i < 1000; i++) {
      for (const n of [playerNameFor(`player-${i}`), startupNameFor(`startup-${i}`)]) {
        expect(isBannedPair(n.kind, n.parts[0], n.parts[1])).toBe(false);
        expect(nameLintReason(n.text), n.text).toBeNull();
        expect(nameLintReason(n.compact), n.compact).toBeNull();
        expect(n.text.length).toBeLessThanOrEqual(COMPOSED_NAME_MAX);
      }
    }
  });
});

describe("determinism and variety", () => {
  it("the same seed gives the same name", () => {
    expect(playerNameFor("abc")).toEqual(playerNameFor("abc"));
    expect(startupNameFor(42)).toEqual(startupNameFor(42));
    expect(composeName("player", ["damp"], ["pelican"])).toEqual(composeName("player", ["damp"], ["pelican"]));
  });

  it("1,000 seeds give at least 950 different player names and 900 different startup names", () => {
    const p = new Set<string>();
    const s = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      p.add(playerNameFor(`seed-${i}`).text);
      s.add(startupNameFor(`seed-${i}`).text);
    }
    expect(p.size).toBeGreaterThanOrEqual(950);
    expect(s.size).toBeGreaterThanOrEqual(900);
  });
});
