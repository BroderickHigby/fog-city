// node scripts/audio/generate-voices.ts [--generate] [--dry-run]
//
// Mission voices: writes public/audio/voice/manifest.json (every mission line with its id,
// speaker, text, subtitle cues and file) and, with --generate, synthesises missing lines with
// ElevenLabs. Build-time only: the API key never reaches the page, dist/ or a log.
//
// Without --generate (the default) nothing touches the network: the manifest is rebuilt from
// the content and whatever files are already in public/audio/voice/ (the cache).
//
// --generate, in order, stopping at the first gate that fails:
//  1. Account: GET /v1/user/subscription. Logs only the tier and character counts, and records
//     them in assets/audio/voices.json. A tier that grants no commercial licence (free, or a
//     tier this script does not know) stops generation: the manifest stays subtitles-only.
//  2. Budget: at most 25 % of the remaining characters, or 100,000, whichever is lower. Lines
//     are generated in mission order until the next one would cross it; the rest stay text.
//  3. Cache: each file is named by sha256(text, voice, every setting). A line whose file exists
//     is never regenerated, so a rerun only pays for new or edited lines.
// Each line is requested as MP3, loudness-normalised and transcoded to mono Ogg Opus with
// ffmpeg, then measured: the manifest's subtitle cues use the real duration.
//
// --dry-run with --generate: checks the account and prints the plan without generating.
//
// Needs ELEVENLABS_API_KEY in the environment (the owner's Doppler project). ffmpeg with
// libopus. Never prints, logs or writes the key.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MISSIONS } from "../../src/content/catalog.ts";
import {
  estimateDurationS, missionVoiceLines, subtitleCues, voiceHashInput,
  type SpeakerVoice, type VoiceLine, type VoiceManifest, type VoiceManifestLine, type VoiceSettings,
} from "../../src/audio/voice-lines.ts";

export const ROOT = join(import.meta.dirname, "..", "..");
export const CASTING = join(ROOT, "assets", "audio", "voices.json");
export const VOICE_DIR = join(ROOT, "public", "audio", "voice");
export const MANIFEST = join(VOICE_DIR, "manifest.json");
const API = "https://api.elevenlabs.io";

/** Tiers whose plans include a commercial licence (ElevenLabs: every paid plan). */
export const COMMERCIAL_TIERS: readonly string[] = ["starter", "creator", "pro", "independent_publisher", "scale", "growing_business", "business", "enterprise"];
export const BUDGET_SHARE = 0.25;
export const BUDGET_CAP = 100_000;
export const VOICE_OPUS_KBPS = 40;
export const VOICE_LUFS = -16;

export interface Casting {
  version: 1;
  note: string;
  account: { checked: string; tier: string; characterCount: number; characterLimit: number; commercialUse: boolean; basis: string };
  hold: string | null;
  settings: VoiceSettings;
  speakers: Record<string, SpeakerVoice>;
  unused?: Record<string, string>;
}

export interface Subscription { tier: string; characterCount: number; characterLimit: number }

/** The character budget for one run. */
export function characterBudget(sub: Subscription): number {
  const remaining = Math.max(0, sub.characterLimit - sub.characterCount);
  return Math.max(0, Math.min(Math.floor(remaining * BUDGET_SHARE), BUDGET_CAP));
}

/** Whether a tier's plan includes a commercial licence. Unknown tiers are refused. */
export function commercialTier(tier: string): boolean {
  return COMMERCIAL_TIERS.includes(tier.toLowerCase());
}

export const lineHash = (line: Pick<VoiceLine, "text">, voiceId: string, settings: VoiceSettings): string =>
  createHash("sha256").update(voiceHashInput(line.text, voiceId, settings)).digest("hex");

export const fileFor = (hash: string): string => `audio/voice/${hash.slice(0, 20)}.ogg`;

/** Lines in order, each with the hash and file it would have; silent speakers have no hash. */
export function plan(casting: Casting, lines: readonly VoiceLine[] = missionVoiceLines(MISSIONS)): Array<{ line: VoiceLine; hash: string; file: string | null; voice: SpeakerVoice }> {
  return lines.map((line) => {
    const voice = casting.speakers[line.speaker];
    if (!voice) throw new Error(`${line.id}: speaker "${line.speaker}" has no casting in assets/audio/voices.json`);
    if (!voice.voiced || !voice.voiceId) return { line, hash: "", file: null, voice };
    const hash = lineHash(line, voice.voiceId, casting.settings);
    return { line, hash, file: fileFor(hash), voice };
  });
}

function probeDurationS(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return Math.round(Number(out.trim()) * 100) / 100;
}

/** The manifest from the casting and the files on disk. Pure but for reading file durations. */
export function buildManifest(casting: Casting, root = ROOT): VoiceManifest {
  const lines: VoiceManifestLine[] = plan(casting).map(({ line, hash, file }) => {
    const path = file ? join(root, "public", file) : "";
    const present = !!file && existsSync(path);
    const durationS = present ? probeDurationS(path) : estimateDurationS(line.text);
    return { ...line, hash, file: present ? file : null, durationS, measured: present, cues: subtitleCues(line.text, durationS) };
  });
  const voiced = lines.filter((l) => l.hash);
  const done = voiced.filter((l) => l.file).length;
  const status = done === 0 ? "subtitles-only" : done === voiced.length ? "generated" : "partial";
  return {
    version: 1,
    status,
    ...(casting.hold && status !== "generated" ? { hold: casting.hold } : {}),
    settings: casting.settings,
    speakers: casting.speakers,
    lines,
  };
}

/** Removes anything that looks like an ElevenLabs key from text bound for a log or an error. */
export function redact(text: string): string {
  const key = process.env.ELEVENLABS_API_KEY;
  let out = text.replace(/sk_[A-Za-z0-9]{8,}/g, "[redacted]");
  if (key) out = out.split(key).join("[redacted]");
  return out;
}

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set (the owner's Doppler project provides it)");
  return key;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "xi-api-key": apiKey() } });
    if (r.ok) return r;
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt >= 3) throw new Error(`${path}: HTTP ${r.status} ${redact((await r.text()).slice(0, 300))}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
  }
}

export async function subscription(): Promise<Subscription> {
  const j = (await (await api("/v1/user/subscription")).json()) as { tier?: string; character_count?: number; character_limit?: number };
  return { tier: String(j.tier ?? "unknown"), characterCount: Number(j.character_count ?? 0), characterLimit: Number(j.character_limit ?? 0) };
}

async function synthesise(text: string, voiceId: string, settings: VoiceSettings, out: string): Promise<void> {
  const r = await api(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(settings.outputFormat)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: settings.modelId,
      voice_settings: { stability: settings.stability, similarity_boost: settings.similarityBoost, style: settings.style, use_speaker_boost: settings.useSpeakerBoost },
    }),
  });
  const mp3 = new Uint8Array(await r.arrayBuffer());
  const run = spawnSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-y", "-f", "mp3", "-i", "pipe:0", "-map_metadata", "-1",
    "-af", `loudnorm=I=${VOICE_LUFS}:TP=-1.5:LRA=7,aresample=48000`, "-ac", "1",
    "-fflags", "+bitexact", "-flags:a", "+bitexact", "-c:a", "libopus", "-b:a", `${VOICE_OPUS_KBPS}k`, "-application", "voip", out,
  ], { input: mp3, maxBuffer: 64 << 20 });
  if (run.status !== 0) throw new Error(`ffmpeg failed for ${out}: ${String(run.stderr).slice(-300)}`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const casting = JSON.parse(readFileSync(CASTING, "utf8")) as Casting;
  mkdirSync(VOICE_DIR, { recursive: true });
  if (argv.includes("--generate")) {
    const sub = await subscription();
    console.log(`ElevenLabs account: tier ${sub.tier}, ${sub.characterCount} of ${sub.characterLimit} characters used`);
    const commercial = commercialTier(sub.tier);
    casting.account = { ...casting.account, checked: new Date().toISOString().slice(0, 10), tier: sub.tier, characterCount: sub.characterCount, characterLimit: sub.characterLimit, commercialUse: commercial };
    if (!commercial) {
      casting.hold = `Voice generation is held: the ElevenLabs account is on the ${sub.tier} tier, which grants no commercial licence, so its output cannot ship in a distributed game. Upgrade to any paid tier, then run \`node scripts/audio/generate-voices.ts --generate\`. Until then every mission line plays as timed subtitles.`;
      console.log("Stopping: this tier grants no commercial licence. Mission lines stay subtitles-only.");
    } else {
      casting.hold = null;
      const budget = characterBudget(sub);
      const todo = plan(casting).filter((p) => p.file && !existsSync(join(ROOT, "public", p.file)));
      const seen = new Set<string>();
      let spent = 0, made = 0, skipped = 0;
      console.log(`Budget ${budget} characters; ${todo.length} lines to generate (${todo.reduce((s, p) => s + p.line.text.length, 0)} characters).`);
      for (const p of todo) {
        if (seen.has(p.hash)) continue;
        seen.add(p.hash);
        if (spent + p.line.text.length > budget) { skipped++; continue; }
        if (argv.includes("--dry-run")) { spent += p.line.text.length; made++; continue; }
        await synthesise(p.line.text, p.voice.voiceId!, casting.settings, join(ROOT, "public", p.file!));
        spent += p.line.text.length;
        made++;
        console.log(`  ${p.line.id} (${p.voice.voiceName}, ${p.line.text.length} chars)`);
      }
      console.log(`${argv.includes("--dry-run") ? "Would generate" : "Generated"} ${made} lines, ${spent} characters; ${skipped} over budget.`);
      if (skipped > 0) casting.hold = `Partly generated: ${skipped} lines did not fit this run's character budget (25 % of the remaining characters, at most 100,000). Rerun later; cached lines are never regenerated.`;
    }
    if (!argv.includes("--dry-run")) writeFileSync(CASTING, JSON.stringify(casting, null, 2) + "\n");
  }
  const manifest = buildManifest(casting);
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + "\n");
  const voiced = manifest.lines.filter((l) => l.hash);
  console.log(`${MANIFEST}: ${manifest.lines.length} lines, ${voiced.filter((l) => l.file).length}/${voiced.length} voiced files, status ${manifest.status}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(redact(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
