// node scripts/audio/build-music.ts [--offline] [id ...]
//
// Builds the contextual soundtrack in public/audio/music/ from the CC0 sources listed in
// assets/audio/music-sources.json, and writes public/audio/music/manifest.json.
//
//  1. Each source is downloaded once into assets/audio/.cache/ (gitignored) and checked
//     against the SHA-256 recorded in music-sources.json: a changed upload stops the build
//     rather than silently shipping different audio under the recorded licence.
//  2. Two-pass EBU R128 loudness normalisation (ffmpeg loudnorm, linear) to MUSIC_LUFS, so
//     every context sits at the same level under the effects and voices.
//  3. Encoded twice, stereo 48 kHz: Ogg Opus (primary, MUSIC_OPUS_KBPS) and MP3 (fallback for a
//     browser without Ogg Opus, MUSIC_MP3_KBPS). Both formats are served as plain files and
//     streamed by an <audio> element, never preloaded.
//
// --offline uses only the cache (fails if a source is missing). Needs ffmpeg with libopus and
// libmp3lame. Outputs are committed; rerun only when a source or a setting changes.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(import.meta.dirname, "..", "..");
export const SOURCES = join(ROOT, "assets", "audio", "music-sources.json");
export const CACHE = join(ROOT, "assets", "audio", ".cache");
export const OUT = join(ROOT, "public", "audio", "music");
export const MUSIC_LUFS = -18;
export const MUSIC_TRUE_PEAK = -1.5;
export const MUSIC_OPUS_KBPS = 80;
export const MUSIC_MP3_KBPS = 96;

export interface MusicSource {
  id: string;
  context: "driving" | "foot" | "mission" | "combat" | "menu";
  title: string;
  author: string;
  authorUrl: string;
  page: string;
  source: string;
  sourceSha256: string;
  licence: string;
  licenceUrl: string;
  pageLicences: string[];
  why: string;
}

export interface MusicManifestTrack {
  id: string;
  context: MusicSource["context"];
  title: string;
  author: string;
  page: string;
  licence: string;
  files: { ogg: string; mp3: string };
  bytes: { ogg: number; mp3: number };
  durationS: number;
  loop: true;
}

export interface MusicManifest {
  version: 1;
  loudnessLufs: number;
  tracks: MusicManifestTrack[];
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function fetchSource(track: MusicSource, offline: boolean): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${track.id}-${track.sourceSha256.slice(0, 12)}${track.source.slice(track.source.lastIndexOf("."))}`);
  if (!existsSync(file)) {
    if (offline) throw new Error(`${track.id}: ${file} is not cached (run without --offline)`);
    const r = await fetch(track.source);
    if (!r.ok) throw new Error(`${track.id}: ${track.source}: HTTP ${r.status}`);
    writeFileSync(file, new Uint8Array(await r.arrayBuffer()));
  }
  const got = sha256(readFileSync(file));
  if (got !== track.sourceSha256) throw new Error(`${track.id}: source SHA-256 ${got} does not match the recorded ${track.sourceSha256}`);
  return file;
}

function ffmpeg(args: string[]): string {
  return execFileSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
}

/** Pass one of loudnorm: the measured values pass two needs for a linear gain. */
function measure(input: string): Record<string, string> {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-i", input, "-af", `loudnorm=I=${MUSIC_LUFS}:TP=${MUSIC_TRUE_PEAK}:LRA=11:print_format=json`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (run.status !== 0) throw new Error(`loudnorm measure failed for ${input}: ${run.stderr.slice(-400)}`);
  const log = run.stderr;
  return JSON.parse(log.slice(log.lastIndexOf("{"), log.lastIndexOf("}") + 1)) as Record<string, string>;
}

function durationS(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return Math.round(Number(out.trim()) * 100) / 100;
}

export async function buildMusic(ids: readonly string[], offline: boolean): Promise<MusicManifest> {
  const sources = (JSON.parse(readFileSync(SOURCES, "utf8")) as { tracks: MusicSource[] }).tracks;
  mkdirSync(OUT, { recursive: true });
  const tracks: MusicManifestTrack[] = [];
  for (const track of sources) {
    const ogg = join(OUT, `${track.id}.ogg`), mp3 = join(OUT, `${track.id}.mp3`);
    if (ids.length === 0 || ids.includes(track.id)) {
      const input = await fetchSource(track, offline);
      const m = measure(input);
      const norm = `loudnorm=I=${MUSIC_LUFS}:TP=${MUSIC_TRUE_PEAK}:LRA=11:linear=true:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
      const common = ["-y", "-i", input, "-map_metadata", "-1", "-af", `${norm},aresample=48000`, "-ac", "2", "-fflags", "+bitexact", "-flags:a", "+bitexact"];
      ffmpeg([...common, "-c:a", "libopus", "-b:a", `${MUSIC_OPUS_KBPS}k`, "-vbr", "on", "-application", "audio", ogg]);
      ffmpeg([...common, "-c:a", "libmp3lame", "-b:a", `${MUSIC_MP3_KBPS}k`, "-id3v2_version", "0", "-write_xing", "1", mp3]);
      console.log(`${track.id}: ${track.title} by ${track.author} (${track.licence}) -> ${statSync(ogg).size} B ogg, ${statSync(mp3).size} B mp3`);
    }
    if (!existsSync(ogg) || !existsSync(mp3)) throw new Error(`${track.id}: outputs missing; build it`);
    tracks.push({
      id: track.id, context: track.context, title: track.title, author: track.author, page: track.page, licence: track.licence,
      files: { ogg: `audio/music/${track.id}.ogg`, mp3: `audio/music/${track.id}.mp3` },
      bytes: { ogg: statSync(ogg).size, mp3: statSync(mp3).size },
      durationS: durationS(ogg),
      loop: true,
    });
  }
  const manifest: MusicManifest = { version: 1, loudnessLufs: MUSIC_LUFS, tracks };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  await buildMusic(args.filter((a) => !a.startsWith("--")), args.includes("--offline"));
}
