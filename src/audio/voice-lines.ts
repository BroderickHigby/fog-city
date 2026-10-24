// Mission voice lines: every spoken line in the mission content, with a stable id, its speaker
// and subtitle cues. Pure (no DOM, no Node): the page and scripts/audio/generate-voices.ts share
// it, so the manifest the script writes and the lines the page asks for always agree.
//
// Line ids: <missionId>.<stepId>.<kind><n> for step lines and dialogue intros ("hot-desk.start.line0",
// "demoed-correctly.pitch-vibes.intro1"), <missionId>.<stepId>.<questionId>.prompt for a question,
// and <missionId>.<stepId>.<questionId>.<answerId>.reply for the speaker's reply to an answer.

import type { Mission } from "../content/missions.ts";

/** "inner": the player's inner voice (inner-voice.ts), not tied to one mission step. */
export type VoiceLineKind = "line" | "intro" | "prompt" | "reply" | "inner";

export interface VoiceLine {
  id: string;
  missionId: string;
  stepId: string;
  kind: VoiceLineKind;
  speaker: string;
  text: string;
  questionId?: string;
  answerId?: string;
}

export interface SubtitleCue {
  /** Seconds from the start of the line. */
  startS: number;
  endS: number;
  text: string;
}

/** One speaker's casting: the voice the generator uses and why it was picked. */
export interface SpeakerVoice {
  /** Display name for subtitles ("Your cofounder"). */
  name: string;
  /** False for a silent speaker (the player): subtitles only, never generated. */
  voiced: boolean;
  voiceId: string | null;
  voiceName: string | null;
  why: string;
}

export interface VoiceSettings {
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  outputFormat: string;
}

export interface VoiceManifestLine extends VoiceLine {
  /** sha256 of voiceHashInput(): the generator's cache key. */
  hash: string;
  /** "audio/voice/<hash>.ogg" once generated, else null (subtitles only). */
  file: string | null;
  durationS: number;
  /** True when durationS is measured from the generated file, false when estimated. */
  measured: boolean;
  cues: SubtitleCue[];
}

export interface VoiceManifest {
  version: 1;
  /** "generated" once every voiced line has a file; "subtitles-only" while generation is held. */
  status: "generated" | "partial" | "subtitles-only";
  /** Why generation is held, when it is (for example the account tier's licence). */
  hold?: string;
  settings: VoiceSettings;
  speakers: Record<string, SpeakerVoice>;
  lines: VoiceManifestLine[];
}

export const VOICE_MANIFEST_PATH = "audio/voice/manifest.json";

/** Every line in mission order, step order, then line order. Ids are unique (tested). */
export function missionVoiceLines(missions: readonly Mission[]): VoiceLine[] {
  const out: VoiceLine[] = [];
  for (const mission of missions) {
    for (const step of mission.steps) {
      const base = { missionId: mission.id, stepId: step.id };
      if ("lines" in step && step.lines)
        step.lines.forEach((line, i) => out.push({ ...base, id: `${mission.id}.${step.id}.line${i}`, kind: "line", speaker: line.speaker, text: line.text }));
      if (step.type === "dialogue") {
        step.intro?.forEach((line, i) => out.push({ ...base, id: `${mission.id}.${step.id}.intro${i}`, kind: "intro", speaker: line.speaker, text: line.text }));
        for (const question of step.questions) {
          out.push({ ...base, id: `${mission.id}.${step.id}.${question.id}.prompt`, kind: "prompt", speaker: step.speaker, text: question.prompt, questionId: question.id });
          for (const answer of question.answers)
            out.push({ ...base, id: `${mission.id}.${step.id}.${question.id}.${answer.id}.reply`, kind: "reply", speaker: step.speaker, text: answer.reply, questionId: question.id, answerId: answer.id });
        }
      }
    }
  }
  return out;
}

/** Lines spoken when a step is entered: its lines, then a dialogue's intro. */
export function stepEntryLines(lines: readonly VoiceLine[], missionId: string, stepId: string): VoiceLine[] {
  return lines.filter((l) => l.missionId === missionId && l.stepId === stepId && (l.kind === "line" || l.kind === "intro"));
}

/** Words per second for an estimated read: a brisk, conversational pace. */
export const READ_WPS = 2.7;
/** Shortest and longest a line stays on screen when its length is estimated. */
export const MIN_LINE_S = 1.8;
export const MAX_LINE_S = 12;
/** A subtitle cue holds at most this many characters (two short lines on screen). */
export const MAX_CUE_CHARS = 90;

/** Estimated spoken length of a text, seconds (used until a generated file is measured). */
export function estimateDurationS(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const pauses = (text.match(/[.!?;:,]/g) ?? []).length * 0.12;
  return Math.round(Math.min(MAX_LINE_S, Math.max(MIN_LINE_S, words / READ_WPS + pauses + 0.3)) * 100) / 100;
}

/** Splits text into readable chunks: sentences, then clauses or words when a sentence is long. */
export function splitCueText(text: string, maxChars = MAX_CUE_CHARS): string[] {
  // A sentence ends at . ! or ? (and any closing quote) followed by a space: "1.0" stays whole.
  const sentences = text.trim().split(/(?<=[.!?]["')\]]*)\s+/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const sentence of sentences.length ? sentences : [text.trim()]) {
    if (sentence.length <= maxChars) {
      chunks.push(sentence);
      continue;
    }
    let current = "";
    for (const word of sentence.split(/\s+/)) {
      if (current && current.length + 1 + word.length > maxChars) {
        chunks.push(current);
        current = word;
      } else current = current ? `${current} ${word}` : word;
    }
    if (current) chunks.push(current);
  }
  // Merge short neighbours so a cue is never a flash of two words.
  const merged: string[] = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length + 1 + chunk.length <= maxChars && (last.length < 28 || chunk.length < 28)) merged[merged.length - 1] = `${last} ${chunk}`;
    else merged.push(chunk);
  }
  return merged.length ? merged : [""];
}

/** Cues over `durationS`, each timed in proportion to its share of the characters. */
export function subtitleCues(text: string, durationS = estimateDurationS(text)): SubtitleCue[] {
  const chunks = splitCueText(text);
  const total = chunks.reduce((s, c) => s + Math.max(1, c.length), 0);
  const cues: SubtitleCue[] = [];
  let t = 0;
  chunks.forEach((chunk, i) => {
    const end = i === chunks.length - 1 ? durationS : t + (durationS * Math.max(1, chunk.length)) / total;
    cues.push({ startS: Math.round(t * 100) / 100, endS: Math.round(end * 100) / 100, text: chunk });
    t = end;
  });
  return cues;
}

/** The canonical text the generator hashes: line text, the voice and every setting. */
export function voiceHashInput(text: string, voiceId: string, settings: VoiceSettings): string {
  return JSON.stringify({ text, voiceId, settings: { ...settings } });
}
