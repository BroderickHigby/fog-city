// Bot Hunt data: at least 24 tells and 6 archetypes, false tells, executable behaviours, a real
// difficulty curve, local tells for the district bounty sets, and the rules that keep tells about
// behaviour rather than looks, and about robots rather than people.
import { describe, expect, it } from "vitest";
import {
  BEHAVIOUR_SIDE, BOT_TELLS, botAtLevel, botWithLocalTell, bountyPay, checkBotTells, hardestSubtlety, localTells, type BotTellsFile,
} from "../../src/content/botTells.ts";
import { fileExists } from "../helpers.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const d = BOT_TELLS;
const tell = (id: string) => d.tells.find((t) => t.id === id)!;
const arch = (x: BotTellsFile, id: string) => x.archetypes.find((a) => a.id === id)!;
const bad = d.tells.filter((t) => t.side === "bad");
const falseTells = d.tells.filter((t) => t.falseTell);

describe("content/bot-tells.json", () => {
  it("passes every cross-reference and difficulty-curve rule", () => {
    expect(checkBotTells()).toEqual([]);
  });

  it("has at least 24 bad tells across all five subtlety levels, plus good tells and false tells", () => {
    expect(bad.length).toBeGreaterThanOrEqual(24);
    expect(new Set(bad.map((t) => t.subtlety))).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(d.tells.filter((t) => t.side === "good" && !t.falseTell).length).toBeGreaterThanOrEqual(12);
    expect(falseTells.length).toBeGreaterThanOrEqual(8);
    for (const t of d.tells) {
      const side = BEHAVIOUR_SIDE[t.behaviour.kind];
      expect(side === "either" || side === t.side, t.id).toBe(true);
    }
  });

  it("has every tell in docs/design.md's tells table, at the subtlety it gives", () => {
    const table: Array<[string, number]> = [
      ["scuffedSticker", 1], ["rateSidewalk", 1], ["tailFootman", 1], ["tryCarDoors", 2], ["readPlates", 2], ["trackPlayer", 2],
      ["waitThroughWalk", 2], ["walkAgainstFlow", 2], ["skipRainCape", 2], ["emptyBag", 3], ["avoidWater", 3], ["humJingle", 3],
      ["alwaysFull", 4], ["threeStepLoop", 4], ["avoidFog", 4], ["takesStairs", 5],
    ];
    for (const [id, s] of table) expect(tell(id).subtlety, id).toBe(s);
    expect(tell("skipRainCape").when).toBe("rain");
    expect(tell("avoidFog").when).toBe("fog");
    expect(tell("humJingle").channel).toBe("audio");
    expect(tell("alwaysFull").channel).toBe("status");
  });

  it("has the false tells design.md names: low battery at a crosswalk, a GPS-lost loop in fog, the robot dance, a pigeon apology, a ping glance", () => {
    expect(tell("lowBatteryStall").mimics).toContain("waitThroughWalk");
    expect(tell("gpsLostLoop").mimics).toContain("circleBlock");
    expect(tell("gpsLostLoop").when).toBe("fog");
    expect(tell("doesTheRobot").falseTell).toBe(true);
    expect(tell("apologisesToPigeon").falseTell).toBe(true);
    expect(tell("pingGlance").mimics).toContain("trackPlayer");
    for (const f of falseTells) expect(f.mimics!.length, f.id).toBeGreaterThan(0);
  });

  it("most common bad tells are mimicked by a false tell or opposed by a good one", () => {
    const covered = new Set([...falseTells.flatMap((t) => t.mimics!), ...d.tells.flatMap((t) => t.opposes ?? [])]);
    const common = bad.filter((t) => !t.districts && t.subtlety >= 2);
    const uncovered = common.filter((t) => !covered.has(t.id)).map((t) => t.id);
    expect(uncovered.length, uncovered.join(", ")).toBeLessThanOrEqual(Math.floor(common.length / 2));
  });

  it("has at least 6 bad archetypes and a good archetype for every model", () => {
    const badA = d.archetypes.filter((a) => a.kind === "bad");
    expect(badA.length).toBeGreaterThanOrEqual(6);
    for (const m of Object.keys(d.models)) expect(d.archetypes.some((a) => a.kind === "good" && a.model === m), m).toBe(true);
    for (const a of d.archetypes) expect(a.designNote.length).toBeGreaterThan(100);
  });

  it("models are the GLBs the renderer draws, named after cleared names", () => {
    for (const [id, m] of Object.entries(d.models)) {
      expect(m.glb).toBe(`${id}.glb`);
      expect(fileExists(`public/models/${m.glb}`), m.glb).toBe(true);
    }
    expect(d.models["errand-robot"].name).toBe("Footman");
    expect(d.models["sidewalk-bot"].name).toBe("Trundle");
    expect(d.models.robotaxi.name).toBe("Meander");
    expect(d.models.robotaxi.rustRate).toBe(0.7);
  });

  it("the emptyBag and fullBag ids stay stable: the errand robot's bag_contents node is driven by them", () => {
    expect(tell("emptyBag").behaviour.kind).toBe("emptyBag");
    expect(tell("fullBag").behaviour.kind).toBe("fullBag");
  });

  it("scoring is water and rust: melting pays, rusting a good robot or wetting a person costs more", () => {
    expect(d.scoring.meltBad).toBeGreaterThan(0);
    expect(d.scoring.meltArmoured).toBeGreaterThan(d.scoring.meltBad);
    expect(d.scoring.rustGood).toBeLessThan(0);
    expect(Math.abs(d.scoring.wetPerson)).toBeGreaterThan(d.scoring.meltBad);
    expect(JSON.stringify(d)).not.toMatch(/patch launcher|reboot/i);
  });

  it("no tell is a colour code, and no bad tell singles out a child or an animal", () => {
    for (const t of d.tells) {
      expect(`${t.label} ${t.description}`).not.toMatch(/\b(red|green|blue|yellow|orange|purple|pink|colou?r)\b/i);
      expect(Object.keys(t.behaviour).join(" ")).not.toMatch(/colou?r|hue|tint/i);
    }
    for (const t of bad) expect(`${t.label} ${t.description}`, t.id).not.toMatch(/\b(child|children|kids?|dogs?|cats?|pigeons?|animals?)\b/i);
    for (const t of d.tells) if (t.behaviour.kind === "askPassersBy") expect(t.behaviour.audience).toBe("adults");
  });

  it("local tells: at least one for every step 1-3 district, each fitting a bad archetype's model", () => {
    const districts = new Set(localTells().flatMap((t) => t.districts!));
    for (const id of ["downtown", "fidi", "embarcadero", "north-beach", "fishermans-wharf", "marina", "dogpatch", "soma", "mission-bay", "rincon-hill", "bay-bridge-approach"]) {
      expect(districts.has(id), id).toBe(true);
    }
    for (const t of localTells()) {
      expect(d.archetypes.some((a) => a.kind === "bad" && t.models.includes(a.model)), t.id).toBe(true);
    }
  });
});

describe("difficulty curve", () => {
  it("bad robots always show 2-3 bad tells, and get subtler with level", () => {
    const mean = (p: ReturnType<typeof botAtLevel>) => p.tells.reduce((s, t) => s + t.subtlety, 0) / p.tells.length;
    for (const a of d.archetypes.filter((x) => x.kind === "bad")) {
      let prev = 0;
      for (const level of [1, 2, 3, 4, 5]) {
        const p = botAtLevel(a.id, level);
        expect(p.tells.length, `${a.id}@${level}`).toBeGreaterThanOrEqual(2);
        expect(p.tells.length, `${a.id}@${level}`).toBeLessThanOrEqual(3);
        expect(p.tells.every((t) => t.side === "bad")).toBe(true);
        expect(p.camouflage.every((t) => t.side === "good" && !t.falseTell)).toBe(true);
        expect(mean(p), `${a.id}@${level}`).toBeGreaterThanOrEqual(prev - 0.5);
        prev = mean(p);
      }
      expect(mean(botAtLevel(a.id, 5)), a.id).toBeGreaterThan(mean(botAtLevel(a.id, 1)));
    }
  });

  it("clamps levels and rejects unknown archetypes", () => {
    expect(botAtLevel("snatcher", 0).level).toBe(1);
    expect(botAtLevel("snatcher", 9).level).toBe(5);
    expect(() => botAtLevel("nope", 1)).toThrow();
  });

  it("a local tell replaces the most obvious shown tell, and must fit the model", () => {
    const p = botWithLocalTell("snatcher", 1, "queueJump");
    expect(p.tells.map((t) => t.id)).toContain("queueJump");
    expect(p.tells.length).toBe(3);
    expect(() => botWithLocalTell("harvester", 1, "queueJump")).toThrow(/never shown by a sidewalk-bot/);
    expect(() => botWithLocalTell("snatcher", 1, "emptyBag")).toThrow(/not a local tell/);
  });

  it("bounty pay scales with the hardest tell: subtlety 5 pays 2x, caught in the act 1.5x more", () => {
    const p5 = botAtLevel("snatcher", 5);
    expect(hardestSubtlety(p5)).toBe(5);
    expect(bountyPay(150, p5)).toBe(300);
    expect(bountyPay(150, p5, true)).toBe(450);
    const p1 = { ...p5, tells: [tell("scuffedSticker"), tell("rateSidewalk")] };
    expect(bountyPay(150, p1)).toBe(150);
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
  it("a bad tell that involves a child or an animal", () => {
    expect(broken((x) => (x.tells[0]!.description = "Follows the dogs on their walk around the block."))).toContain("child or an animal");
  });
  it("a bad tell on a good robot", () => {
    expect(broken((x) => arch(x, "errandFootman").tells.push("emptyBag"))).toContain("is bad, archetype is good");
  });
  it("a tell the archetype's model never shows", () => {
    expect(broken((x) => arch(x, "harvester").tells.push("takesStairs"))).toContain("never shown by a sidewalk-bot");
  });
  it("a curve that gets easier", () => {
    expect(broken((x) => (arch(x, "snatcher").difficulty[4]!.showTells = ["tailFootman", "rateSidewalk"]))).toContain("gets more obvious");
  });
  it("a bad robot showing one tell", () => {
    expect(broken((x) => (arch(x, "snatcher").difficulty[0]!.showTells = ["tailFootman"]))).toContain("shows 2-3 tells");
  });
  it("a level whose tells are all conditional", () => {
    expect(broken((x) => (arch(x, "harvester").difficulty[4]!.showTells = ["avoidFog"]))).toContain("conditional");
  });
  it("camouflage that contradicts a shown tell", () => {
    expect(broken((x) => arch(x, "snatcher").difficulty[2]!.camouflage.push("fullBag"))).toContain("contradicts shown tell emptyBag");
  });
  it("a bad robot with a body no good robot has", () => {
    expect(broken((x) => (x.archetypes = x.archetypes.filter((a) => a.id !== "meanderTaxi")))).toContain("no good twin");
  });
  it("a false tell that mimics nothing real", () => {
    expect(broken((x) => (x.tells.find((t) => t.id === "pingGlance")!.mimics = ["notATell"]))).toContain("mimics unknown tell notATell");
  });
  it("a face light that flashes faster than 3 times a second", () => {
    expect(
      broken((x) => {
        x.tells.find((y) => y.id === "faceLightFlicker")!.behaviour = { kind: "faceLightFlicker", periodS: 0.25, holdS: 0.1 };
      }),
    ).toContain("more than 3 times a second");
  });
  it("a tell no archetype uses, and an unknown lineSet", () => {
    const msg = broken((x) => {
      x.tells.push({ id: "orphan", side: "bad", subtlety: 3, channel: "speech", models: ["errand-robot"], label: "Orphan", description: "Does a thing nobody ever does.", behaviour: { kind: "loopLine", lineSet: "missing", intervalS: 5 } });
    });
    expect(msg).toContain("tell orphan: not used");
    expect(msg).toContain("unknown lineSet missing");
  });
});
