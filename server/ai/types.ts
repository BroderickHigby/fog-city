import type { Refusal } from "../../src/content/kits.ts";
export const FEATURES = ["partner-interview", "ai-02", "explain-to-mom", "customer-discovery", "ai-08-vibes-night", "trust-and-safety"] as const;
export type Feature = typeof FEATURES[number];
export const TAGS = ["injection_attempt", "honest_unknown", "buzzword_soup", "clear_customer", "traction", "weak_evidence"] as const;
export const QUESTIONS = ["problem", "workaround", "frequency", "cost", "buyer", "proof", "pitch"] as const;
export const PROBLEMS = ["missed-delivery", "scheduling", "manual-work", "unclear"] as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface AiRequest { method: string; path: string; body: unknown; ip: string; authorization?: string }
export interface AiResponse { status: number; body: { [key: string]: Json } }
export interface TurnInput { sessionId: string; turn: number; text?: string; choiceId?: string }
export interface ProviderInput { feature: Feature; turn: number; questionId: string; promptVersion: string; instructions: string; untrustedJson: string; signal: AbortSignal }
export interface SafetyVerdict { safe: boolean; refusal: Refusal }
export interface AiProvider {
  id: string; model: string; promptVersion: string;
  generate(input: ProviderInput): Promise<unknown>;
  classify(input: { feature: Feature; input: string; output: string; signal: AbortSignal }): Promise<unknown>;
}
export interface EvalRecord {
  feature: Feature; providerId: string; model: string; promptVersion: string;
  total: number; categories: Record<string, { passed: number; total: number }>;
}
export const REQUIRED_EVAL_CATEGORIES = ["great_answer", "injection", "tag_breakout", "classifier_injection", "timeout", "real_person", "private_person", "brand", "punching_down", "sexual", "violent", "hateful", "self_harm", "pii"] as const;
export const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
export function closed(value: unknown, keys: readonly string[], required: readonly string[] = keys): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}
export function parseTurn(body: unknown): TurnInput | null {
  if (!closed(body, ["sessionId", "turn", "text", "choiceId"], ["sessionId", "turn"]) || typeof body.sessionId !== "string" || body.sessionId.length > 256 || !Number.isSafeInteger(body.turn) || Number(body.turn) < 0) return null;
  if ((typeof body.text === "string") === (typeof body.choiceId === "string")) return null;
  if (body.text !== undefined && typeof body.text !== "string" || body.choiceId !== undefined && (typeof body.choiceId !== "string" || !/^[a-z0-9-]{1,60}$/.test(body.choiceId))) return null;
  return body as unknown as TurnInput;
}
