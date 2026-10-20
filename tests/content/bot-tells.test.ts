// Bot Hunt data: enough tells and archetypes, executable behaviours, a real difficulty curve,
// and the rules that keep tells about behaviour rather than looks.
import { describe, expect, it } from "vitest";
import { BEHAVIOUR_SIDE, BOT_TELLS, botAtLevel, checkBotTells, type BotTellsFile } from "../../src/content/botTells.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const d = BOT_TELLS;
const tell = (id: string) => d.tells.find((t) => t.id === id)!;
const arch = (id: string) => d.archetypes.find((a) => a.id === id)!;

describe("content/bot-tells.json", () => {
  it("passes every cross-reference and difficulty-curve rule", () => {
    expect(checkBotTells()).toEqual([]);
  });

  it("has at least 14 bad and 10 good tells, each with subtlety 1-5 and a behaviour", () => {
    const bad = d.tells.filter((t) => t.side === "bad");
    const good = d.tells.filter((t) => t.side === "good");
    expect(bad.length).toBeGreaterThanOrEqual(14);
    expect(good.length).toBeGreaterThanOrEqual(10);
    for (const t of d.tells) {
      expect(t.subtlety).toBeGreaterThanOrEqual(1);
      expect(t.subtlety).toBeLessThanOrEqual(5);
      expect(BEHAVIOUR_SIDE[t.behaviour.kind], t.id).toBe(t.side);
    }
    // Both sides span the subtlety range, so every difficulty level has material.
    expect(new Set(bad.map((t) => t.subtlety)).size).toBe(5);
    expect(new Set(good.map((t) => t.subtlety)).size).toBeGreaterThanOrEqual(4);
  });

  it("includes the behaviours the brief names, with sim-ready parameters", () => {
    expect(tell("walkAgainstFlow").behaviour).toEqual({ kind: "walkAgainstFlow" });
    expect(tell("emptyBag").behaviour).toEqual({ kind: "emptyBag" });
    expect(tell("faceLightFlicker").behaviour).toMatchObject({ kind: "faceLightFlicker", periodS: expect.any(Number), holdS: expect.any(Number) });
    expect(tell("scanEachPerson").behaviour).toMatchObject({ kind: "scanEachPerson", pauseS: expect.any(Number) });
    expect(tell("loiterNearRobotaxi").behaviour).toMatchObject({ kind: "loiterNear", target: "robotaxi", radiusM: expect.any(Number) });
  });

  it("has at least 6 bad and 3 good archetypes, each with 2-4 tells and a design note", () => {
    const bad = d.archetypes.filter((a) => a.kind === "bad");
    const good = d.archetypes.filter((a) => a.kind === "good");
    expect(bad.length).toBeGreaterThanOrEqual(6);
    expect(good.length).toBeGreaterThanOrEqual(3);
    for (const a of d.archetypes) {
      expect(a.tells.length).toBeGreaterThanOrEqual(2);
      expect(a.tells.length).toBeLessThanOrEqual(4);
      expect(a.designNote.length).toBeGreaterThan(100);
    }
  });

  it("has the archetypes the brief asks for", () => {
    expect(arch("scraper").tells).toContain("photographFlash");
    expect(arch("slopPoster").tells).toContain("pastePoster");
    expect(arch("growthHacker").tells).toContain("pitchPedestrian");
    expect(arch("priceRelabeler").tells).toContain("relabelPrice");
    expect(arch("dataHarvester").tells).toContain("loiterNearRobotaxi");
    expect(arch("groceryHelper").tells).toContain("walkBeside");
    expect(arch("dogWalker").tells).toContain("pauseForDog");
    expect(arch("lineStander").tells).toContain("queueInLine");
    expect(tell("queueInLine").behaviour).toMatchObject({ target: "bakeryLine" });
  });

  it("every bad chassis is shared with a good bot: the body is never the tell", () => {
    const good = new Set(d.archetypes.filter((a) => a.kind === "good").map((a) => a.chassis));
    for (const a of d.archetypes.filter((x) => x.kind === "bad")) expect(good.has(a.chassis), a.id).toBe(true);
  });

  it("no tell is a colour code", () => {
    for (const t of d.tells) {
      expect(`${t.label} ${t.description}`).not.toMatch(/\b(red|green|blue|yellow|orange|purple|pink|colou?r)\b/i);
      expect(Object.keys(t.behaviour).join(" ")).not.toMatch(/colou?r|hue|tint/i);
    }
  });

  it("every lineSet a behaviour speaks from exists and is non-empty", () => {
    for (const t of d.tells) {
      const ls = (t.behaviour as { lineSet?: string }).lineSet;
      if (ls) expect(d.lineSets[ls]?.length, t.id).toBeGreaterThan(0);
    }
  });

  it("scoring makes patching a good bot or hitting a person a loss", () => {
    expect(d.scoring.patchBad).toBeGreaterThan(0);
    expect(d.scoring.patchGood).toBeLessThan(0);
    expect(d.scoring.hitPerson).toBeLessThan(0);
    expect(Math.abs(d.scoring.hitPerson)).toBeGreaterThan(d.scoring.patchBad);
  });
});

describe("difficulty curve", () => {
  it("bad bots always show at least one bad tell, and get subtler with level", () => {
    for (const a of d.archetypes.filter((x) => x.kind === "bad")) {
      let prevMean = 0;
      for (const level of [1, 2, 3, 4, 5]) {
        const p = botAtLevel(a.id, level);
        expect(p.tells.length, `${a.id}@${level}`).toBeGreaterThan(0);
        expect(p.tells.every((t) => t.side === "bad")).toBe(true);
        expect(p.camouflage.every((t) => t.side === "good")).toBe(true);
        const mean = p.tells.reduce((s, t) => s + t.subtlety, 0) / p.tells.length;
        expect(mean, `${a.id}@${level}`).toBeGreaterThanOrEqual(prevMean);
        prevMean = mean;
      }
      expect(botAtLevel(a.id, 5).camouflage.length).toBeGreaterThan(botAtLevel(a.id, 1).camouflage.length);
    }
  });

  it("good bots never show a bad tell or wear camouflage", () => {
    for (const a of d.archetypes.filter((x) => x.kind === "good")) {
      for (const level of [1, 2, 3, 4, 5]) {
        const p = botAtLevel(a.id, level);
        expect(p.tells.every((t) => t.side === "good")).toBe(true);
        expect(p.camouflage).toEqual([]);
      }
    }
  });

  it("level 1 is easier than level 5 across the whole cast", () => {
    const meanSubtlety = (lv: number) => {
      const all = d.archetypes.flatMap((a) => botAtLevel(a.id, lv).tells.map((t) => t.subtlety));
      return all.reduce((s, x) => s + x, 0) / all.length;
    };
    expect(meanSubtlety(1)).toBeLessThan(2.5);
    expect(meanSubtlety(5)).toBeGreaterThan(4);
  });

  it("botAtLevel clamps levels and rejects unknown archetypes", () => {
    expect(botAtLevel("scraper", 0).level).toBe(1);
    expect(botAtLevel("scraper", 9).level).toBe(5);
    expect(() => botAtLevel("nope", 1)).toThrow();
  });
});

describe("checkBotTells catches broken data", () => {
  const broken = (mutate: (x: BotTellsFile) => void): string => {
    const x = clone(d);
    mutate(x);
    return checkBotTells(x).join("\n");
  };

  it("a colour-coded tell", () => {
    expect(broken((x) => (x.tells[0]!.description = "Its eyes glow red when it is up to no good."))).toContain("colour");
  });
  it("a bad tell on a good bot", () => {
    expect(broken((x) => arch2(x, "dogWalker").tells.push("photographFlash"))).toContain("is bad, archetype is good");
  });
  it("a curve that gets easier", () => {
    expect(broken((x) => (arch2(x, "scraper").difficulty[4]!.showTells = ["photographFlash"]))).toContain("gets more obvious");
  });
  it("camouflage that contradicts a shown tell", () => {
    expect(broken((x) => arch2(x, "dataHarvester").difficulty[2]!.camouflage.push("fullBag"))).toContain("contradicts shown tell emptyBag");
  });
  it("a bad bot with a body no good bot has", () => {
    expect(broken((x) => (arch2(x, "dogWalker").chassis = "strider"))).toContain("no good twin");
  });
  it("a tell no archetype uses, and an unknown lineSet", () => {
    const msg = broken((x) => {
      x.tells.push({ id: "orphan", side: "bad", subtlety: 3, label: "Orphan", description: "Does a thing nobody ever does.", behaviour: { kind: "loopLine", lineSet: "missing", intervalS: 5 } });
    });
    expect(msg).toContain("tell orphan: not used");
    expect(msg).toContain("unknown lineSet missing");
  });
});

function arch2(x: BotTellsFile, id: string) {
  return x.archetypes.find((a) => a.id === id)!;
}
