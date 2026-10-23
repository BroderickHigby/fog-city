// Shared BotBounty templates: ~120, valid placeholders, phone-card fit, and single-robot
// templates for protected areas.
import { describe, expect, it } from "vitest";
import { BOUNTY_TEMPLATES, bountyTexts, checkBountyTemplates, pickBountyTemplate, renderBounty } from "../../src/content/bounties.ts";
import { contentHash } from "../../src/content/barks.ts";

describe("content/bounties.json", () => {
  const t = BOUNTY_TEMPLATES.templates;
  it("has about 120 shared templates, with single-robot ones for protected areas", () => {
    expect(t.length).toBeGreaterThanOrEqual(120);
    expect(t.filter((x) => x.crew === "single").length).toBeGreaterThanOrEqual(15);
    expect(checkBountyTemplates()).toEqual([]);
  });

  it("pays $150 standard and $400 armoured, crews of 2-4 within 60 m (design.md)", () => {
    expect(BOUNTY_TEMPLATES.pay).toMatchObject({ standard: 150, armoured: 400 });
    expect(BOUNTY_TEMPLATES.crewSize).toEqual({ min: 2, max: 4, withinM: 60 });
  });

  it("renders a posting with every placeholder filled", () => {
    const r = renderBounty(t[0]!, { model: "Footman", place: "Washington Square", tell: "Steps around puddles", pay: "$150" });
    expect(`${r.headline} ${r.lastSeen} ${r.hint}`).not.toMatch(/[{}]/);
    expect(r.hint).toContain("steps around puddles");
  });

  it("a protected area only ever draws a single-robot template", () => {
    for (let i = 0; i < 500; i++) expect(pickBountyTemplate(`b-${i}`, true).crew).toBe("single");
    const kinds = new Set(Array.from({ length: 500 }, (_, i) => pickBountyTemplate(`b-${i}`, false).crew));
    expect(kinds).toEqual(new Set(["crew", "single"]));
  });

  it("the provenance hash matches the text", () => {
    expect(BOUNTY_TEMPLATES.provenance.contentHash).toBe(contentHash(bountyTexts()));
  });

  it("checkBountyTemplates catches an unknown placeholder and a posting that cannot fit", () => {
    const bad = JSON.parse(JSON.stringify(BOUNTY_TEMPLATES));
    bad.templates[0].hint = "Look for {colour}: {tell}.";
    bad.templates[1].lastSeen = `${"Very long words ".repeat(8)}{place}.`;
    const errs = checkBountyTemplates(bad).join("\n");
    expect(errs).toContain("unknown placeholder {colour}");
    expect(errs).toContain("fontFit");
  });
});
