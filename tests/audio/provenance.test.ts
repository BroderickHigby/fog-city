// Soundtrack and voice provenance: every music file is CC0 with its source, author and licence
// recorded; the encodes are real Ogg Opus / MP3 at the documented length and loudness; the voice
// manifest matches the mission content and the casting, and states why voices are held.
import { MPEGDecoder } from "mpg123-decoder";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, readJson } from "../helpers.ts";
import { MISSIONS } from "../../src/content/catalog.ts";
import { missionVoiceLines, subtitleCues, estimateDurationS, splitCueText, MAX_CUE_CHARS, type VoiceManifest } from "../../src/audio/voice-lines.ts";
import type { MusicManifest, MusicSource } from "../../scripts/audio/build-music.ts";
import { BUDGET_CAP, buildManifest, characterBudget, commercialTier, fileFor, lineHash, plan, type Casting } from "../../scripts/audio/generate-voices.ts";

const sources = readJson<{ policy: string; tracks: MusicSource[] }>("assets/audio/music-sources.json");
const music = readJson<MusicManifest>("public/audio/music/manifest.json");
const voice = readJson<VoiceManifest>("public/audio/voice/manifest.json");
const casting = readJson<Casting>("assets/audio/voices.json");
const readme = readFileSync(join(ROOT, "assets/audio/README.md"), "utf8");
const CONTEXTS = ["driving", "foot", "mission", "combat", "menu"];
/** The static build's per-file limit (scripts/build-web.ts HOST_LIMITS). */
const HOST_FILE_LIMIT = 15_000_000;
/** This stream's share of the 240 MB build budget, kept frugal. */
const AUDIO_BUDGET_BYTES = 20_000_000;

/** Ogg pages to the Opus stream's channel count, pre-skip and duration (last granule). */
function opusInfo(bytes: Uint8Array): { channels: number; preSkip: number; inputRate: number; durationS: number; pages: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0, pages = 0, lastGranule = 0n, head: Uint8Array | null = null;
  while (offset + 27 <= bytes.length) {
    expect(String.fromCharCode(...bytes.subarray(offset, offset + 4))).toBe("OggS");
    const granule = view.getBigInt64(offset + 6, true);
    const segments = bytes[offset + 26]!;
    let body = 0;
    for (let i = 0; i < segments; i++) body += bytes[offset + 27 + i]!;
    const start = offset + 27 + segments;
    if (pages === 0) head = bytes.subarray(start, start + body);
    if (granule >= 0n) lastGranule = granule;
    offset = start + body;
    pages++;
  }
  expect(offset).toBe(bytes.length);
  expect(head && String.fromCharCode(...head.subarray(0, 8))).toBe("OpusHead");
  const h = new DataView(head!.buffer, head!.byteOffset, head!.byteLength);
  const preSkip = h.getUint16(10, true);
  return { channels: head![9]!, preSkip, inputRate: h.getUint32(12, true), durationS: Number(lastGranule - BigInt(preSkip)) / 48_000, pages };
}

const mp3 = new MPEGDecoder();
beforeAll(async () => { await mp3.ready; });
afterAll(() => mp3.free());

describe("music sources", () => {
  it("are all CC0, each with a source page, file, checksum, author and licence", () => {
    expect(sources.policy).toMatch(/CC0 only/);
    expect(sources.tracks.map((t) => t.context).sort()).toEqual([...CONTEXTS].sort());
    for (const t of sources.tracks) {
      expect(t.licence, t.id).toBe("CC0 1.0");
      expect(t.licenceUrl, t.id).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
      expect(t.pageLicences, t.id).toContain("CC0");
      expect(t.page, t.id).toMatch(/^https:\/\/opengameart\.org\/content\/[a-z0-9-]+$/);
      expect(t.source, t.id).toMatch(/^https:\/\/opengameart\.org\/sites\/default\/files\/\S+\.(mp3|ogg|wav)$/);
      expect(t.sourceSha256, t.id).toMatch(/^[0-9a-f]{64}$/);
      expect(t.author.length, t.id).toBeGreaterThan(1);
      expect(t.authorUrl, t.id).toMatch(/^https:\/\/opengameart\.org\/users\//);
      // Recorded in the README too, per file.
      for (const field of [t.title, t.author, t.page, `music/${t.id}.ogg`]) expect(readme, `${t.id}: README lists ${field}`).toContain(field);
    }
  });
});

describe("public/audio/music", () => {
  it("has exactly one track per context, each manifest entry matching its source record", () => {
    expect(music.tracks.map((t) => t.context).sort()).toEqual([...CONTEXTS].sort());
    for (const t of music.tracks) {
      const s = sources.tracks.find((x) => x.id === t.id)!;
      expect(s, t.id).toBeTruthy();
      expect({ title: t.title, author: t.author, page: t.page, licence: t.licence, context: t.context }).toEqual({ title: s.title, author: s.author, page: s.page, licence: s.licence, context: s.context });
      expect(t.files).toEqual({ ogg: `audio/music/${t.id}.ogg`, mp3: `audio/music/${t.id}.mp3` });
      expect(t.loop).toBe(true);
    }
    const files = readdirSync(join(ROOT, "public/audio/music")).sort();
    expect(files).toEqual(["manifest.json", ...music.tracks.flatMap((t) => [`${t.id}.mp3`, `${t.id}.ogg`])].sort());
  });

  it("stays within the build budgets", () => {
    let total = 0;
    for (const t of music.tracks) for (const fmt of ["ogg", "mp3"] as const) {
      const size = statSync(join(ROOT, "public", t.files[fmt])).size;
      expect(size, t.files[fmt]).toBe(t.bytes[fmt]);
      expect(size, t.files[fmt]).toBeLessThan(HOST_FILE_LIMIT);
      total += size;
    }
    for (const f of readdirSync(join(ROOT, "public/audio/voice"))) total += statSync(join(ROOT, "public/audio/voice", f)).size;
    expect(total).toBeLessThan(AUDIO_BUDGET_BYTES);
  });

  it.each(music.tracks.map((t) => [t.id, t] as const))("%s is real stereo Ogg Opus at its documented length", (_id, t) => {
    const info = opusInfo(new Uint8Array(readFileSync(join(ROOT, "public", t.files.ogg))));
    expect(info.channels).toBe(2);
    expect(info.pages).toBeGreaterThan(10);
    expect(Math.abs(info.durationS - t.durationS)).toBeLessThan(0.05);
    expect(t.durationS).toBeGreaterThan(20);
  });

  it.each(music.tracks.map((t) => [t.id, t] as const))("%s MP3 fallback decodes at the same length, loud enough and not clipped", async (_id, t) => {
    await mp3.reset();
    const r = mp3.decode(new Uint8Array(readFileSync(join(ROOT, "public", t.files.mp3))));
    expect(r.errors).toEqual([]);
    expect(r.sampleRate).toBe(48_000);
    expect(r.channelData).toHaveLength(2);
    const x = r.channelData[0]!.subarray(0, r.samplesDecoded);
    expect(Math.abs(x.length / r.sampleRate - t.durationS)).toBeLessThan(0.1);
    let peak = 0, sum = 0;
    for (const v of x) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
    const rmsDb = 10 * Math.log10(sum / x.length);
    // Normalised to -18 LUFS with a -1.5 dBTP ceiling: RMS lands in a narrow band.
    expect(rmsDb).toBeGreaterThan(-26);
    expect(rmsDb).toBeLessThan(-12);
    expect(peak).toBeLessThanOrEqual(1);
  });
});

describe("mission voice manifest", () => {
  const lines = missionVoiceLines(MISSIONS);

  it("lists every mission line, in content order, with the current text", () => {
    expect(voice.lines.map((l) => l.id)).toEqual(lines.map((l) => l.id));
    for (const [i, l] of voice.lines.entries()) {
      const src = lines[i]!;
      expect({ missionId: l.missionId, stepId: l.stepId, kind: l.kind, speaker: l.speaker, text: l.text }).toEqual({ missionId: src.missionId, stepId: src.stepId, kind: src.kind, speaker: src.speaker, text: src.text });
    }
  });

  it("is exactly what the generator writes now (rerun scripts/audio/generate-voices.ts after a content change)", () => {
    expect(JSON.parse(JSON.stringify(buildManifest(casting)))).toEqual(voice);
  });

  it("casts every speaker; each voiced speaker has a distinct premade voice, and the player is silent", () => {
    const speakers = new Set(lines.map((l) => l.speaker));
    for (const s of speakers) expect(casting.speakers[s], s).toBeTruthy();
    const voiced = Object.values(casting.speakers).filter((s) => s.voiced);
    expect(new Set(voiced.map((s) => s.voiceId)).size).toBe(voiced.length);
    for (const s of voiced) expect(s.voiceId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(casting.speakers.player).toMatchObject({ voiced: false, voiceId: null });
    expect(voice.lines.filter((l) => l.speaker === "player").every((l) => l.hash === "" && l.file === null)).toBe(true);
  });

  it("names its files by a hash of text, voice and settings, so an edit regenerates only that line", () => {
    const p = plan(casting);
    const a = p.find((x) => x.line.speaker === "cofounder")!;
    expect(a.hash).toBe(lineHash(a.line, a.voice.voiceId!, casting.settings));
    expect(a.file).toBe(fileFor(a.hash));
    expect(lineHash({ text: a.line.text + "!" }, a.voice.voiceId!, casting.settings)).not.toBe(a.hash);
    expect(lineHash(a.line, "otherVoice0000000000", casting.settings)).not.toBe(a.hash);
    expect(lineHash(a.line, a.voice.voiceId!, { ...casting.settings, stability: 0.9 })).not.toBe(a.hash);
    for (const l of voice.lines) if (l.file) expect(l.file).toBe(fileFor(l.hash));
  });

  it("every listed file exists and every file in public/audio/voice is listed", () => {
    const listed = new Set(voice.lines.flatMap((l) => (l.file ? [l.file.replace("audio/voice/", "")] : [])));
    const onDisk = readdirSync(join(ROOT, "public/audio/voice")).filter((f) => f !== "manifest.json");
    expect(onDisk.sort()).toEqual([...listed].sort());
    for (const f of onDisk) expect(opusInfo(new Uint8Array(readFileSync(join(ROOT, "public/audio/voice", f)))).channels).toBe(1);
  });

  it("records the account check and holds generation on a tier without a commercial licence", () => {
    expect(casting.account.tier).toBeTruthy();
    expect(casting.account.basis).toMatch(/elevenlabs/i);
    expect(casting.account.commercialUse).toBe(commercialTier(casting.account.tier));
    if (!casting.account.commercialUse) {
      expect(voice.status).not.toBe("generated");
      expect(voice.lines.every((l) => l.file === null)).toBe(true);
      expect(voice.hold).toMatch(/commercial licence/);
    }
    expect(readme).toContain(`tier: ${casting.account.tier}`);
    expect(readme).toMatch(/commercial/i);
  });

  it("has subtitle cues that cover each line, in order, readable in size", () => {
    for (const l of voice.lines) {
      expect(l.cues.length, l.id).toBeGreaterThan(0);
      expect(l.cues[0]!.startS).toBe(0);
      expect(l.cues[l.cues.length - 1]!.endS).toBeCloseTo(l.durationS, 5);
      for (let i = 1; i < l.cues.length; i++) expect(l.cues[i]!.startS).toBeCloseTo(l.cues[i - 1]!.endS, 5);
      for (const c of l.cues) expect(c.text.length, l.id).toBeLessThanOrEqual(MAX_CUE_CHARS);
      expect(l.cues.map((c) => c.text).join(" ").replace(/\s+/g, " ")).toBe(l.text.trim().replace(/\s+/g, " "));
      if (!l.measured) expect(l.durationS).toBe(estimateDurationS(l.text));
    }
  });
});

describe("generator gates", () => {
  it("allows only paid tiers (commercial licence) and refuses unknown ones", () => {
    expect(commercialTier("free")).toBe(false);
    expect(commercialTier("mystery")).toBe(false);
    for (const t of ["starter", "creator", "pro", "scale", "business"]) expect(commercialTier(t)).toBe(true);
  });

  it("spends at most 25 % of the remaining characters, capped at 100,000", () => {
    expect(characterBudget({ tier: "free", characterCount: 5975, characterLimit: 10_000 })).toBe(1006);
    expect(characterBudget({ tier: "pro", characterCount: 0, characterLimit: 500_000 })).toBe(100_000);
    expect(characterBudget({ tier: "pro", characterCount: 600_000, characterLimit: 500_000 })).toBe(0);
    expect(BUDGET_CAP).toBe(100_000);
  });
});

describe("subtitle timing", () => {
  it("estimates a brisk read with bounds, and splits long text at sentences and words", () => {
    expect(estimateDurationS("ok")).toBe(1.8);
    expect(estimateDurationS("word ".repeat(200))).toBe(12);
    const text = "one two three. " + "long ".repeat(40).trim() + ".";
    const chunks = splitCueText(text);
    expect(chunks.every((c) => c.length <= MAX_CUE_CHARS)).toBe(true);
    expect(chunks.join(" ")).toBe(text.trim());
    const cues = subtitleCues(text, 10);
    expect(cues[cues.length - 1]!.endS).toBe(10);
  });
});
