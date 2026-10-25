// Quick chat: a fixed set of phrases chosen by index, so no free text ever reaches another player
// (docs/design.md: never free text in shared places) and there is nothing to moderate.
export const QUICK_CHAT = ["Nice melt!", "Over here!", "Need water!", "That one's bad!", "Thanks!", "Good game!"] as const;
export type QuickChatId = number;
/** At most one phrase per player every 1.5 s. */
export const QUICK_CHAT_INTERVAL_MS = 1500;
