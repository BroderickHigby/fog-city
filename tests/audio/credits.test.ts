// Credits: every entry is backed by the repository's own provenance (licence files, source
// manifests, data-source docs), the OpenStreetMap notice is the linked text its licence asks
// for, and the panel renders every group.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readJson } from "../helpers.ts";
import { CREDITS, mountCredits, type CreditEntry } from "../../src/ui/credits.ts";

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const all: CreditEntry[] = CREDITS.flatMap((g) => g.entries);
const find = (who: RegExp): CreditEntry => {
  const e = all.find((x) => who.test(x.who));
  expect(e, String(who)).toBeTruthy();
  return e!;
};

describe("credits", () => {
  it("carries the OpenStreetMap notice as linked text to the copyright page (ODbL)", () => {
    const osm = find(/OpenStreetMap/);
    expect(osm.who).toBe("© OpenStreetMap contributors");
    expect(osm.licence).toBe("ODbL");
    expect(osm.url).toBe("https://www.openstreetmap.org/copyright");
    expect(osm.linkWho).toBe(true);
  });

  it("credits DataSF and USGS as docs/data-sources.md records them", () => {
    const doc = read("docs/data-sources.md");
    expect(find(/DataSF/).licence).toBe("PDDL 1.0");
    expect(doc).toContain("City and County of San Francisco, DataSF");
    expect(doc).toMatch(/PDDL\) 1\.0/);
    expect(find(/USGS/).who).toContain("3D Elevation Program (3DEP)");
    expect(doc).toContain("USGS National Map 3D Elevation Program (3DEP)");
  });

  it("lists every music track with its author, licence and source page", () => {
    const tracks = readJson<{ tracks: Array<{ title: string; author: string; licence: string; page: string }> }>("assets/audio/music-sources.json").tracks;
    const music = CREDITS.find((g) => g.title === "Music")!.entries;
    expect(music).toHaveLength(tracks.length);
    for (const t of tracks) {
      const e = music.find((m) => m.url === t.page);
      expect(e, t.title).toBeTruthy();
      expect(e!.what).toContain(t.title);
      expect(e!.who).toBe(t.author);
      expect(e!.licence).toBe(t.licence);
    }
  });

  it("matches the model, icon and texture licences in their provenance files", () => {
    const rocketbox = find(/Rocketbox/);
    expect(rocketbox.licence).toBe("MIT");
    expect(read("assets/imports/rocketbox/LICENSE.md")).toMatch(/MIT License[\s\S]*Copyright \(c\) 2020 Microsoft/);
    expect(read("assets/imports/rocketbox/README.md")).toContain("Male_Adult_01");
    expect(find(/Lucide/).licence).toBe("ISC");
    expect(read("src/ui/control-icons.ts")).toMatch(/Lucide \(https:\/\/lucide\.dev\), ISC licence/);
    const slop = find(/Mr\.doob/);
    expect(slop.licence).toBe("MIT");
    expect(read("assets/imports/slop-new-york/LICENSE.md")).toMatch(/MIT/);
    // Every shipped surface scan, with its author and source page.
    const scans = readJson<{ textures: Record<string, { source: string; author: string; licence: string }> }>("public/textures/surfaces/sources.json").textures;
    for (const [name, s] of Object.entries(scans)) {
      const e = all.find((x) => x.url === s.source);
      expect(e, name).toBeTruthy();
      expect(e!.who).toContain(s.author);
      expect(s.licence).toMatch(/^CC0 1\.0/);
      expect(e!.licence).toBe("CC0 1.0");
    }
  });

  it("renders a collapsible section with every group and entry, links opening safely", () => {
    // A minimal document: enough for createElement / createTextNode / append.
    interface FakeNode { tag: string; text: string; children: FakeNode[]; attrs: Record<string, string>; [k: string]: unknown }
    const make = (tag: string): FakeNode => {
      const n: FakeNode = { tag, text: "", children: [], attrs: {} };
      Object.defineProperties(n, {
        append: { value: (...kids: Array<FakeNode | string>) => { for (const k of kids) n.children.push(typeof k === "string" ? { tag: "#text", text: k, children: [], attrs: {} } : k); } },
        remove: { value: () => {} },
        textContent: {
          set(v: string) { n.text = v; },
          get() { return n.text + n.children.map((c) => (c.textContent as string | undefined) ?? c.text).join(""); },
        },
      });
      return n;
    };
    const doc = { createElement: (tag: string) => make(tag), createTextNode: (text: string) => ({ tag: "#text", text, children: [], attrs: {}, textContent: text }) } as unknown as Document;
    const { element } = mountCredits(doc);
    const root = element as unknown as FakeNode;
    expect(root.tag).toBe("details");
    const text = root.textContent as string;
    for (const g of CREDITS) {
      expect(text).toContain(g.title);
      for (const e of g.entries) expect(text).toContain(e.who);
    }
    const links: FakeNode[] = [];
    const walk = (n: FakeNode): void => { if (n.tag === "a") links.push(n); n.children.forEach(walk); };
    walk(root);
    expect(links.length).toBe(all.filter((e) => e.url).length);
    for (const a of links) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
    expect(links.some((a) => a.href === "https://www.openstreetmap.org/copyright" && a.text === "© OpenStreetMap contributors")).toBe(true);
  });
});
