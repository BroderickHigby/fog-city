// Mission progress to voice lines, on the real mission content: step entry, pass-through steps,
// dialogue prompts and replies, retries, reloads, and the manifest's stale-text guard.
import { describe, expect, it } from "vitest";
import { MISSIONS } from "../../src/content/catalog.ts";
import { MissionVoice, stepsBetween, type ObservedProgress } from "../../src/audio/mission-voice.ts";
import { VoiceQueue, type VoicePlayer } from "../../src/audio/voice-queue.ts";
import { missionVoiceLines, type VoiceManifest } from "../../src/audio/voice-lines.ts";

const silent: VoicePlayer = { play: () => ({ stop() {} }) };

function setup(canPlay = false) {
  const heard: string[] = [];
  const queue = new VoiceQueue({ player: silent, canPlay: () => canPlay, staleMs: 1e9, maxQueued: 50, onEvent: (e) => { if (e.kind === "start") heard.push(e.id); } });
  const voice = new MissionVoice(queue, MISSIONS);
  let t = 0;
  /** Run every queued line to its end; returns every line started so far. */
  const drain = (): string[] => {
    for (let guard = 0; guard < 200 && (queue.snapshot().current || queue.snapshot().waiting.length); guard++) queue.update((t += 20_000));
    return heard;
  };
  return { queue, voice, drain };
}

const at = (missionId: string, stepId: string, visits: number, extra: Partial<ObservedProgress> = {}): ObservedProgress =>
  ({ missionId, stepId, status: "active", visits, questionIndex: 0, ...extra });

describe("mission voice lines", () => {
  const lines = missionVoiceLines(MISSIONS);

  it("covers every line in the mission content with a unique id", () => {
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
    let count = 0;
    for (const m of MISSIONS) for (const s of m.steps) {
      count += ("lines" in s && s.lines ? s.lines.length : 0);
      if (s.type === "dialogue") count += (s.intro?.length ?? 0) + s.questions.reduce((n, q) => n + 1 + q.answers.length, 0);
    }
    expect(lines.length).toBe(count);
    expect(lines.length).toBeGreaterThanOrEqual(100);
  });

  it("speaks a step's lines when the step is entered, once per visit", () => {
    const { voice, drain } = setup();
    voice.observe(at("hot-desk", "arrive", 1), 0);
    voice.observe(at("hot-desk", "arrive", 1), 10);
    expect(drain()).toEqual(["hot-desk.arrive.line0", "hot-desk.arrive.line1"]);
  });

  it("speaks the lines of steps passed through within one tick", () => {
    expect(stepsBetween(MISSIONS.find((m) => m.id === "hot-desk")!, "arrive", "watch").map((s) => s.id)).toEqual(["snatch"]);
    const { voice, drain } = setup();
    voice.observe(at("hot-desk", "arrive", 1), 0);
    voice.observe(at("hot-desk", "watch", 3), 1);
    expect(drain()).toEqual(["hot-desk.arrive.line0", "hot-desk.arrive.line1", "hot-desk.snatch.line0", "hot-desk.watch.line0"]);
  });

  it("asks each dialogue question in turn and replies to the answer given", () => {
    const { voice, drain } = setup();
    voice.observe(at("demoed-correctly", "pitch-philosopher", 5), 0);
    voice.answered("interviewfeature", "workflow", 1);
    voice.observe(at("demoed-correctly", "pitch-philosopher", 5, { questionIndex: 1 }), 2);
    expect(drain()).toEqual([
      "demoed-correctly.pitch-philosopher.interviewfeature.prompt",
      "demoed-correctly.pitch-philosopher.interviewfeature.workflow.reply",
      "demoed-correctly.pitch-philosopher.interviewproof.prompt",
    ]);
  });

  it("a retry visit speaks the step again; a reload resets and speaks the restored step once", () => {
    const { voice, drain } = setup();
    voice.observe(at("hot-desk", "late", 6, { status: "retry" }), 0);
    voice.observe(at("hot-desk", "late", 9, { status: "retry" }), 1);
    expect(drain()).toEqual(["hot-desk.late.line0", "hot-desk.late.line0"]);
    voice.reset();
    voice.observe(at("hot-desk", "late", 9, { status: "retry" }), 2);
    expect(drain()).toEqual(["hot-desk.late.line0", "hot-desk.late.line0", "hot-desk.late.line0"]);
  });

  it("the completion lines still play when the next mission starts at once", () => {
    const { voice, drain } = setup();
    voice.observe(at("hot-desk", "moved-in", 11, { status: "complete" }), 0);
    voice.observe(at("spill", MISSIONS.find((m) => m.id === "spill")!.start!, 1), 1);
    const heard = drain();
    expect(heard.slice(0, 2)).toEqual(["hot-desk.moved-in.line0", "hot-desk.moved-in.line1"]);
    expect(heard.slice(2).every((id) => id.startsWith("spill."))).toBe(true);
  });

  it("ignores an idle player", () => {
    const { voice, queue } = setup();
    voice.observe({ missionId: "", stepId: "", status: "idle", visits: 0, questionIndex: 0 }, 0);
    voice.observe(undefined, 0);
    expect(queue.snapshot().current).toBeNull();
  });

  it("uses a generated file only while the manifest's text matches the content", () => {
    const { voice } = setup();
    const line = lines.find((l) => l.id === "hot-desk.arrive.line0")!;
    const manifest = (text: string): VoiceManifest => ({
      version: 1, status: "partial", settings: { modelId: "m", stability: 0, similarityBoost: 0, style: 0, useSpeakerBoost: false, outputFormat: "mp3" },
      speakers: { cofounder: { name: "Cofounder", voiced: true, voiceId: "v", voiceName: "V", why: "" } },
      lines: [{ ...line, text, hash: "h", file: "audio/voice/h.ogg", durationS: 3.21, measured: true, cues: [{ startS: 0, endS: 3.21, text }] }],
    });
    voice.setManifest(manifest(line.text));
    expect(voice.item(line, "g")).toMatchObject({ url: "audio/voice/h.ogg", durationS: 3.21 });
    voice.setManifest(manifest("an older wording"));
    const stale = voice.item(line, "g");
    expect(stale.url).toBeNull();
    expect(stale.cues.map((c) => c.text).join(" ")).toBe(line.text);
    // The mission's own cast name labels the subtitle.
    expect(stale.speakerName).toBe("Your cofounder");
  });
});
