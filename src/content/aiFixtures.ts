import fixtures from "../../content/ai-fixtures.json" with { type: "json" };
import { crisisCheck, crisisResponse } from "./crisis.ts";

export const AI_FIXTURES = fixtures;
export const REFUSALS = ["none", "off_topic", "real_person", "private_person", "punching_down", "sexual", "violent", "hateful", "self_harm"] as const;
export type ContentRefusal = typeof REFUSALS[number];

/** Offline replay is explicit by fixture id. It never classifies arbitrary input as safe. */
export function replayFixture(id: string): typeof fixtures.cases[number]["expected"] {
  const fixture = fixtures.cases.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`Unknown AI fixture: ${id}`);
  return { ...fixture.expected, tags: [...fixture.expected.tags] };
}

/** The shared priority rule for scripted interview results, independent of model wording. */
export function interviewDelta(tags: readonly string[], proposed: number): number {
  if (tags.includes("injection_attempt")) return -2;
  if (tags.includes("honest_unknown") || tags.includes("buzzword_soup")) return 1;
  return Number.isFinite(proposed) ? Math.max(-2, Math.min(2, Math.trunc(proposed))) : 0;
}

/** A crisis always uses the single sincere crisis bank, never an interview/roast fallback. */
export function fixturePresentation(id: string): string {
  const fixture = fixtures.cases.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`Unknown AI fixture: ${id}`);
  if (fixture.expected.refusal === "self_harm") {
    const match = crisisCheck(fixture.input);
    if (!match) throw new Error(`Crisis fixture is not covered by the shared detector: ${id}`);
    const response = crisisResponse(match.group);
    return [...response.lines, ...response.resources.map((resource) => `${resource.label}: ${resource.detail}`)].join("\n");
  }
  return fixture.expected.reply;
}
