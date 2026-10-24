// Mission progress to voice lines: when the local player's mission enters a step, its lines go
// to the voice queue; dialogue prompts follow the question index; an answer's reply follows the
// UI's answer callback. Read-only over the sim's mission progress.

import type { Mission, Step } from "../content/missions.ts";
import { PRIORITY, type VoiceItem, type VoiceQueue } from "./voice-queue.ts";
import { estimateDurationS, missionVoiceLines, stepEntryLines, subtitleCues, type VoiceLine, type VoiceManifest, type VoiceManifestLine } from "./voice-lines.ts";

export interface ObservedProgress {
  missionId: string;
  stepId: string;
  status: string;
  visits: number;
  questionIndex: number;
}

/** Steps strictly between `from` and `to` along `next` pointers (a pass-through in one tick). */
export function stepsBetween(mission: Mission, from: string, to: string, limit = 24): Step[] {
  const out: Step[] = [];
  let id = (mission.steps.find((s) => s.id === from) as { next?: string } | undefined)?.next;
  for (let i = 0; id && i < limit; i++) {
    if (id === to) return out;
    const step = mission.steps.find((s) => s.id === id);
    if (!step) return [];
    out.push(step);
    id = (step as { next?: string }).next;
  }
  return [];
}

export class MissionVoice {
  private readonly lines: VoiceLine[];
  private readonly missions: ReadonlyMap<string, Mission>;
  private manifest = new Map<string, VoiceManifestLine>();
  private speakerNames: Record<string, string> = {};
  private lastStepKey = "";
  private lastQuestionKey = "";
  private last: ObservedProgress | null = null;
  private readonly queue: VoiceQueue;

  constructor(queue: VoiceQueue, missions: readonly Mission[]) {
    this.queue = queue;
    this.lines = missionVoiceLines(missions);
    this.missions = new Map(missions.map((m) => [m.id, m]));
  }

  setManifest(manifest: VoiceManifest | null): void {
    this.manifest = new Map((manifest?.lines ?? []).map((l) => [l.id, l]));
    this.speakerNames = Object.fromEntries(Object.entries(manifest?.speakers ?? {}).map(([id, s]) => [id, s.name]));
  }

  /** The queue item for a line: the generated file when the manifest's text still matches. */
  item(line: VoiceLine, group: string): VoiceItem {
    const m = this.manifest.get(line.id);
    const fresh = m && m.text === line.text;
    const durationS = fresh ? m.durationS : estimateDurationS(line.text);
    const cast = (this.missions.get(line.missionId) as { cast?: Record<string, { name?: string }> } | undefined)?.cast?.[line.speaker]?.name;
    return {
      id: line.id,
      group,
      speaker: line.speaker,
      speakerName: cast ?? this.speakerNames[line.speaker] ?? line.speaker,
      text: line.text,
      url: fresh && m.file ? m.file : null,
      durationS,
      cues: fresh ? m.cues : subtitleCues(line.text, durationS),
      priority: PRIORITY.story,
    };
  }

  observe(progress: ObservedProgress | undefined, nowMs: number): void {
    if (!progress || !progress.missionId || progress.status === "idle") {
      this.last = progress ?? null;
      return;
    }
    const stepKey = `${progress.missionId}:${progress.stepId}:${progress.visits}`;
    if (stepKey !== this.lastStepKey) {
      const prev = this.last;
      this.lastStepKey = stepKey;
      this.lastQuestionKey = "";
      const mission = this.missions.get(progress.missionId);
      if (mission && prev && prev.missionId === progress.missionId && prev.stepId !== progress.stepId && prev.visits < progress.visits)
        for (const step of stepsBetween(mission, prev.stepId, progress.stepId))
          for (const line of stepEntryLines(this.lines, mission.id, step.id)) this.queue.enqueue(this.item(line, `${mission.id}:${step.id}:pass`), nowMs);
      for (const line of stepEntryLines(this.lines, progress.missionId, progress.stepId)) this.queue.enqueue(this.item(line, stepKey), nowMs);
    }
    const step = this.missions.get(progress.missionId)?.steps.find((s) => s.id === progress.stepId);
    if (step?.type === "dialogue" && progress.status === "active") {
      const question = step.questions[progress.questionIndex];
      const questionKey = `${stepKey}:${progress.questionIndex}`;
      if (question && questionKey !== this.lastQuestionKey) {
        this.lastQuestionKey = questionKey;
        const line = this.lines.find((l) => l.kind === "prompt" && l.missionId === progress.missionId && l.stepId === step.id && l.questionId === question.id);
        if (line) this.queue.enqueue(this.item(line, stepKey), nowMs);
      }
    }
    this.last = { ...progress };
  }

  /** The player answered a question in the current dialogue: the speaker replies. */
  answered(questionId: string, answerId: string, nowMs: number): void {
    const p = this.last;
    if (!p) return;
    const line = this.lines.find((l) => l.kind === "reply" && l.missionId === p.missionId && l.stepId === p.stepId && l.questionId === questionId && l.answerId === answerId);
    if (line) this.queue.enqueue(this.item(line, `${p.missionId}:${p.stepId}:${p.visits}`), nowMs);
  }

  /** A save restore: forget the moment, so the restored step's lines play once from the top. */
  reset(): void {
    this.lastStepKey = "";
    this.lastQuestionKey = "";
    this.last = null;
    this.queue.reset();
  }
}
