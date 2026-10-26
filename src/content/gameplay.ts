import progression from "../../content/progression.json" with { type: "json" };
import streaks from "../../content/streaks.json" with { type: "json" };
import loadouts from "../../content/loadouts.json" with { type: "json" };
import activities from "../../content/activity-rules.json" with { type: "json" };
import dialogue from "../../content/dialogue-bank.json" with { type: "json" };
import phone from "../../content/phone-bank.json" with { type: "json" };
import world from "../../content/world-bank.json" with { type: "json" };
import modeRules from "../../content/mode-rules.json" with { type: "json" };

export const PROGRESSION = progression;
export const STREAKS = streaks;
export const LOADOUTS = loadouts;
export const ACTIVITY_RULES = activities;
export const ACTIVITY_DEFINITIONS = activities.definitions;
export const MODE_RULES = modeRules;

export interface WritingChoice { id: string; text: string; score: number; reply: string }
export interface WritingEntry {
  id: string;
  kind: string;
  wave: number;
  context: string;
  speaker?: string;
  text: string;
  choices?: WritingChoice[];
  tags?: string[];
  followUpId?: string;
}
export const WRITING: readonly WritingEntry[] = [...dialogue.entries, ...phone.entries, ...world.entries];
export const writingFor = (kind: string, context?: string): readonly WritingEntry[] =>
  WRITING.filter((entry) => entry.kind === kind && (context === undefined || entry.context === context));

/** Highest earned rank; malformed external XP cannot unlock progression. */
export function rankForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp < 0) return 1;
  return PROGRESSION.ranks.reduce((rank, row) => xp >= row.totalXp ? row.rank : rank, 1);
}

export function activityById(id: string): typeof ACTIVITY_DEFINITIONS[number] {
  const activity = ACTIVITY_DEFINITIONS.find((row) => row.id === id);
  if (!activity) throw new Error(`Unknown activity: ${id}`);
  return activity;
}
