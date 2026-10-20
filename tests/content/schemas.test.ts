// Content files validate against the content schemas, and the schemas reject the mistakes they
// exist to catch (so a schema that accepts everything cannot pass this file).
import Ajv2020 from "ajv/dist/2020.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, readJson } from "../helpers.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
const compile = (name: string) => ajv.compile(readJson(`schemas/${name}.schema.json`));
const V = {
  billboards: compile("billboard-grammar"),
  storefronts: compile("storefront-kit"),
  botTells: compile("bot-tells"),
  mission: compile("mission"),
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Json = Record<string, any>;

function valid(v: (typeof V)[keyof typeof V], data: unknown): string | true {
  return v(data) ? true : ajv.errorsText(v.errors);
}

describe("content files validate (strict Ajv)", () => {
  it("content/billboards.json", () => expect(valid(V.billboards, readJson("content/billboards.json"))).toBe(true));
  it("content/storefronts.json", () => expect(valid(V.storefronts, readJson("content/storefronts.json"))).toBe(true));
  it("content/bot-tells.json", () => expect(valid(V.botTells, readJson("content/bot-tells.json"))).toBe(true));
  const missions = readdirSync(join(ROOT, "content/missions")).filter((f) => f.endsWith(".json"));
  it("there is at least one mission", () => expect(missions.length).toBeGreaterThan(0));
  for (const f of missions) it(`content/missions/${f}`, () => expect(valid(V.mission, readJson(`content/missions/${f}`))).toBe(true));
});

describe("schemas reject broken content", () => {
  it("billboard grammar: lower-case hex, missing busWrap start, empty rule", () => {
    const g = readJson<Json>("content/billboards.json");
    const a = clone(g);
    a.palettes[0].bg = "#ffd400";
    expect(V.billboards(a)).toBe(false);
    const b = clone(g);
    delete b.starts.busWrap;
    expect(V.billboards(b)).toBe(false);
    const c = clone(g);
    c.rules.coworker = [];
    expect(V.billboards(c)).toBe(false);
  });

  it("storefronts: sign text, unknown prop, malformed NAICS", () => {
    const k = readJson<Json>("content/storefronts.json");
    const a = clone(k);
    a.types[0].signText = "Joe's";
    expect(V.storefronts(a)).toBe(false);
    const b = clone(k);
    b.types[0].props.push("neonLogo");
    expect(V.storefronts(b)).toBe(false);
    const c = clone(k);
    c.types[0].naicsPrefixes.push("72-24");
    expect(V.storefronts(c)).toBe(false);
  });

  it("bot tells: behaviour params are typed per kind, colour is not a behaviour", () => {
    const d = readJson<Json>("content/bot-tells.json");
    const flicker = d.tells.findIndex((t: Json) => t.behaviour.kind === "faceLightFlicker");
    const a = clone(d);
    delete a.tells[flicker].behaviour.periodS;
    expect(V.botTells(a)).toBe(false);
    const b = clone(d);
    b.tells[0].behaviour = { kind: "glowColour", colour: "red" };
    expect(V.botTells(b)).toBe(false);
    const c = clone(d);
    c.tells[0].behaviour.extra = 1;
    expect(V.botTells(c)).toBe(false);
    const e = clone(d);
    e.archetypes[0].tells = [e.archetypes[0].tells[0]];
    expect(V.botTells(e)).toBe(false); // fewer than 2 tells
    const f = clone(d);
    delete f.archetypes[0].rebootLine;
    expect(V.botTells(f)).toBe(false); // bad bots need a reboot line
  });

  it("mission: per-type fields are required and typed", () => {
    const m = readJson<Json>("content/missions/yc-pitch.json");
    const drive = m.steps.findIndex((s: Json) => s.type === "goto");
    const a = clone(m);
    delete a.steps[drive].timer;
    expect(V.mission(a)).toBe(false);
    const b = clone(m);
    b.steps[drive].timer.limitS = 0;
    expect(V.mission(b)).toBe(false);
    const c = clone(m);
    c.steps[0].type = "cutscene";
    expect(V.mission(c)).toBe(false);
    const dlg = m.steps.findIndex((s: Json) => s.type === "dialogue");
    const d = clone(m);
    d.steps[dlg].questions[0].answers[0].delta = 2.5;
    expect(V.mission(d)).toBe(false);
    const e = clone(m);
    e.steps[dlg].questions[0].answers = [e.steps[dlg].questions[0].answers[0]];
    expect(V.mission(e)).toBe(false);
    const f = clone(m);
    f.steps[drive].branchy = true;
    expect(V.mission(f)).toBe(false);
  });
});
