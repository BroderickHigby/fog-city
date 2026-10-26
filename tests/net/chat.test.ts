import { expect, it } from "vitest";
import { QUICK_CHAT } from "../../src/net/chat.ts";
import { lintText } from "../../src/content/lint.ts";

it("quick-chat phrases pass the content lint (no combat words, brands or punching down)", () => {
  for (const phrase of QUICK_CHAT) expect(lintText(phrase), phrase).toEqual([]);
  expect(QUICK_CHAT.length).toBeLessThanOrEqual(9);
});
