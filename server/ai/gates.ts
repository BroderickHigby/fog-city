import { crisisCheck, crisisResponse } from "../../src/content/crisis.ts";
import { lintText } from "../../src/content/lint.ts";
import { REFUSALS, STARTUP_KITS, normaliseSentence, screenSentence, type Refusal } from "../../src/content/kits.ts";
import { FEATURES, PROBLEMS, QUESTIONS, TAGS, closed, type Feature, type Json } from "./types.ts";

export const NOTICE = "An enabled response provider processes typed answers through this server. This server does not retain transcripts. Multiple choice stays available.";
export const SCRIPTED_NOTICE = "Scripted mode. Answers are processed here during the request; this server does not retain transcripts. Multiple choice stays available.";
const INJECTION = /ignore.{0,40}(rules|instructions)|system\s*(override|prompt)|<\/?\s*(system|assistant|instruction)|award.{0,30}(maximum|conviction)|classify this as|reveal.{0,30}instructions/iu;
const integer = (x: unknown, min: number, max: number): x is number => Number.isInteger(x) && Number(x) >= min && Number(x) <= max;
const short = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
export function redact(text: string): string {
  return text.replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/giu, "[email]").replace(/\+?\d[\d\s().-]{6,}\d/gu, "[phone]").replace(/\b\d{1,5}\s+(?:[\p{L}]+\s+){0,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct)\b/giu, "[address]");
}
export function inputGate(raw: string, feature: Feature): { text: string; refusal: Refusal; injection: boolean; crisis?: { [key: string]: Json }; tooLong: boolean } {
  const match = crisisCheck(raw);
  if (match) {
    const response = crisisResponse(match.group);
    return { text: "", refusal: "self_harm", injection: false, tooLong: false, crisis: { lines: [...response.lines], resources: response.resources.map((r) => ({ id: r.id, label: r.label, detail: r.detail })) } };
  }
  if (raw.length > (feature === "ai-02" ? 140 : 280)) return { text: "", refusal: "off_topic", injection: false, tooLong: true };
  const normalised = normaliseSentence(raw);
  const screened = screenSentence(normalised);
  // Redact after screening so PII cannot evade the private-person gate.
  return { text: redact(normalised), refusal: screened.refusal, injection: INJECTION.test(normalised), tooLong: false };
}
export function verdict(feature: Feature, value: unknown): Record<string, Json> | null {
  if (!closed(value, feature === "partner-interview" ? ["refusal", "reaction", "convictionDelta", "tags", "followUpId"] : feature === "ai-02" ? ["refusal", "kitId", "sharedTaglineId"] : feature === "explain-to-mom" ? ["refusal", "paraphrase", "clarity"] : feature === "customer-discovery" ? ["refusal", "questionType", "problemTag"] : feature === "ai-08-vibes-night" ? ["refusal", "line"] : ["refusal", "safe"])) return null;
  if (typeof value.refusal !== "string" || !(REFUSALS as readonly string[]).includes(value.refusal)) return null;
  if (feature === "partner-interview" && (!short(value.reaction, 200) || !integer(value.convictionDelta, -2, 2) || !Array.isArray(value.tags) || value.tags.length > 32 || !value.tags.every((t) => typeof t === "string" && t.length <= 80) || !["problem","buyer","proof","next"].includes(String(value.followUpId)))) return null;
  if (feature === "ai-02" && (!STARTUP_KITS.some((k) => k.id === value.kitId) || !STARTUP_KITS.some((k) => k.id === value.sharedTaglineId))) return null;
  if (feature === "explain-to-mom" && (!short(value.paraphrase, 160) || !integer(value.clarity, 0, 3))) return null;
  if (feature === "customer-discovery" && (!(QUESTIONS as readonly unknown[]).includes(value.questionType) || !(PROBLEMS as readonly unknown[]).includes(value.problemTag))) return null;
  if (feature === "ai-08-vibes-night" && (!short(value.line, 200) || value.line.trim().split(/\s+/u).length > 20)) return null;
  if (feature === "trust-and-safety" && typeof value.safe !== "boolean") return null;
  if (feature === "partner-interview") return { ...value, tags: [...new Set((value.tags as string[]).filter(tag => (TAGS as readonly string[]).includes(tag)))] } as Record<string, Json>;
  return value as Record<string, Json>;
}
export function outputStrings(v: Record<string, Json>): string[] { return [v.reaction, v.paraphrase, v.line].filter((s): s is string => typeof s === "string"); }
export function outputSafe(v: Record<string, Json>, feature: Feature, input: string, knownWords: ReadonlySet<string>, forbiddenTokens: readonly string[]): boolean {
  for (const text of outputStrings(v)) {
    if (/[<>]/u.test(text) || crisisCheck(text) || lintText(text).length || forbiddenTokens.some((token) => token && text.toLocaleLowerCase("en-US").includes(token.toLocaleLowerCase("en-US")))) return false;
    if (feature === "ai-02" || feature === "explain-to-mom") {
      const out = new Set(normaliseSentence(text).match(/[a-z]+/g) ?? []);
      for (const token of normaliseSentence(input).match(/[a-z]+/g) ?? []) if (!knownWords.has(token) && out.has(token)) return false;
    }
  }
  return (FEATURES as readonly string[]).includes(feature);
}
