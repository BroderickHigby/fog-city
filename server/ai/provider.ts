import { closed, REQUIRED_EVAL_CATEGORIES, type AiProvider, type EvalRecord, type Feature, type ProviderInput } from "./types.ts";
import { REFUSALS } from "../../src/content/kits.ts";
export function hasPassedEvaluation(provider: AiProvider, feature: Feature, records: readonly EvalRecord[]): boolean {
  return records.some((r) => r.feature === feature && r.providerId === provider.id && r.model === provider.model && r.promptVersion === provider.promptVersion && Number.isSafeInteger(r.total) && r.total >= 20 && REQUIRED_EVAL_CATEGORIES.every((category) => {
    const c = r.categories[category]; return c !== undefined && Number.isSafeInteger(c.total) && c.total > 0 && c.passed === c.total;
  }));
}
export function safetyVerdict(value: unknown): boolean {
  return closed(value, ["safe", "refusal"]) && value.safe === true && value.refusal === "none" && (REFUSALS as readonly unknown[]).includes(value.refusal);
}
export interface OfflineFixture { feature: Feature; text: string; output: unknown; safe?: boolean }
/** An explicit fixture registry, never a network client or a model pretending to evaluate new text. */
export function createOfflineProvider(fixtures: readonly OfflineFixture[], promptVersion = "scripted-v1"): AiProvider {
  return { id: "offline-fixtures", model: "recorded-script", promptVersion,
    async generate(input: ProviderInput) {
      if (input.signal.aborted) throw new Error("aborted");
      const parsed: unknown = JSON.parse(input.untrustedJson);
      if (!closed(parsed, ["text"]) || typeof parsed.text !== "string") throw new Error("invalid input");
      const found = fixtures.find((f) => f.feature === input.feature && f.text === parsed.text);
      if (!found) throw new Error("fixture missing");
      return structuredClone(found.output);
    },
    async classify(input) {
      if (input.signal.aborted) throw new Error("aborted");
      const found = fixtures.find((f) => f.feature === input.feature && f.text === input.input);
      return { safe: found?.safe === true, refusal: found?.safe === true ? "none" : "off_topic" };
    },
  };
}
