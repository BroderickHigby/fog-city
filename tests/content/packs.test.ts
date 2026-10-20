// District content packs: one per active district, 40 robot barks and 40 people lines each, a
// bounty set with the district's local tell, and ad copy that fits its slots.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOT_TELLS, localTells } from "../../src/content/botTells.ts";
import { PACKS, checkPack } from "../../src/content/packs.ts";
import { DISTRICTS } from "../../src/content/places.ts";
import { ROOT } from "../helpers.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("district packs", () => {
  it("every pack file is registered in src/content/packs.ts", () => {
    const files = readdirSync(join(ROOT, "content/packs")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    expect(Object.keys(PACKS).sort()).toEqual(files);
  });

  it("every active district has a pack", () => {
    for (const d of DISTRICTS.filter((x) => x.active)) expect(PACKS[d.id], d.id).toBeDefined();
  });

  for (const [id, p] of Object.entries(PACKS)) {
    it(`${id}: passes every pack rule`, () => {
      expect(p.district).toBe(id);
      expect(checkPack(p)).toEqual([]);
    });
  }

  it("each district's local tell is used by its own bounty set", () => {
    for (const t of localTells()) {
      for (const d of t.districts!) {
        const p = PACKS[d];
        if (!p) continue;
        expect(p.bounties.some((b) => b.localTell === t.id), `${t.id} in ${d}`).toBe(true);
      }
    }
  });

  it("SoMa ships its billboards and bus wraps, Moat Labs among them", () => {
    const soma = PACKS["soma"]!;
    expect(soma.ads.filter((a) => a.surface === "billboard").length).toBeGreaterThanOrEqual(20);
    expect(soma.ads.filter((a) => a.surface === "busWrap").length).toBeGreaterThanOrEqual(15);
    expect(soma.ads.some((a) => /Moat Labs/.test(`${a.headline} ${a.subline}`))).toBe(true);
  });

  it("people lines name local streets or landmarks (at least a quarter of them)", () => {
    const local: Record<string, RegExp> = {
      downtown: /Union Square|Powell|Geary|Stockton|Post St|turntable|cable car/i,
      fidi: /Front St|Montgomery|Sansome|Battery|California|Pine|lobby|tower|floor|elevator|office|badge|plaza/i,
      embarcadero: /ferry|clock tower|promenade|market|bay|bridge|Pier/i,
      "north-beach": /Columbus|Washington Square|square|Stockton|Grant|Broadway|Union St|church/i,
      "fishermans-wharf": /Jefferson|wharf|sea lion|cable car|chowder|turnaround|bay|island/i,
      marina: /Marina|Green|Chestnut|Lombard|palace|boats/i,
      dogpatch: /Pier 70|3rd St|22nd|Twenty-second|light rail|shipyard|bench|Ramen|warehouse|studio|cranes/i,
      soma: /convention|Folsom|Howard|gardens|lanyard|Moat Labs|keynote|SoMa/i,
      "mission-bay": /bridge|creek|ballpark|game|hospital|lab|light rail|cove/i,
      "rincon-hill": /hill|tower|bridge|Harrison|Folsom|lobby|on-ramp/i,
      "bay-bridge-approach": /bridge|depot|on-ramp|anchorage|Bryant|robotaxi|harbour/i,
    };
    for (const [id, p] of Object.entries(PACKS)) {
      const re = local[id]!;
      const n = p.peopleLines.filter((l) => re.test(l.text)).length;
      expect(n, id).toBeGreaterThanOrEqual(10);
    }
  });

  it("checkPack catches a missing local tell, a bounty outside its district and an ad that cannot fit", () => {
    const p = clone(PACKS["marina"]!);
    for (const b of p.bounties) delete b.localTell;
    expect(checkPack(p).join("\n")).toContain("at least one template with the local tell");
    const q = clone(PACKS["marina"]!);
    q.bounties[0]!.lastSeen = { label: "Somewhere else", lat: 37.7605, lon: -122.3866 };
    expect(checkPack(q).join("\n")).toContain("lies outside The Marina");
    const r = clone(PACKS["marina"]!);
    r.ads[0]!.headline = "A headline far too long for any billboard on this street";
    expect(checkPack(r).join("\n")).toContain("fontFit");
    const s = clone(PACKS["marina"]!);
    s.bounties[0]!.localTell = "queueJump";
    expect(checkPack(s).join("\n")).toContain("not local to marina");
    expect(BOT_TELLS.tells.find((t) => t.id === "queueJump")!.districts).toEqual(["embarcadero"]);
  });
});
