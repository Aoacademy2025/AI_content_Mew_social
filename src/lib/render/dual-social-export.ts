import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegPath } from "@/lib/ffmpeg-path";
import { normalizeFinalAudioLoudness } from "@/lib/render/loudness-normalize";
import { planStoryOverlaySfxCues, type StoryOverlayItem } from "@/lib/story-overlays";
import {
  effectiveSfxMode,
  planTransitionSfxCues,
  synthesizeTransitionSfxWavBytes,
  type SfxMode,
  type TransitionSfxCue,
  type TransitionSfxKind,
} from "@/lib/transition-sfx";

const execFileAsync = promisify(execFile);

/**
 * Dual Social Export (`_withMusic` + `_forTikTokSound`):
 *
 * Renders video pixels ONCE in Remotion, then produces a companion `_tiktok-nobgm.mp4`
 * (`-c:v copy`, zero video re-encoding, < 1 second wall-clock) containing ONLY:
 *   1. Voiceover (`voiceFile`)
 *   2. Selective native clip audio (`bgVideos[]` where `keepClipAudio === true`)
 *   3. Transition & Story Overlay SFX cues (`shutter`, `ding`, `pop`, `whoosh`, `record-scratch`, etc.)
 *   4. Normalized to `-14 LUFS` (`normalizeFinalAudioLoudness`) — with ZERO background music!
 *
 * Creators can post the primary MP4 directly to IG Reels / Facebook / YouTube Shorts (full BGM)
 * and upload the companion MP4 to TikTok to attach trending commercial/viral sounds inside TikTok
 * without double-music clash or copyright mutes.
 */

export type DualExportClipAudioSource = {
  src: string;
  startSec: number;
  endSec: number;
  clipOffsetSec?: number;
  volume?: number;
  playbackRate?: number;
};

export type BuildDualTikTokExportInput = {
  /** Already-rendered master MP4 (`_withMusic.mp4`). Video stream is copied losslessly (`-c:v copy`). */
  masterMp4Path: string;
  /** Output path for the BGM-free TikTok companion MP4. */
  outputMp4Path: string;
  /** Total video duration in seconds. */
  durationSec: number;
  /** Local filesystem path or HTTP URL to the clean voiceover audio (optional when clip-only). */
  voiceSource?: string | null;
  voiceVolume?: number;
  /** Optional native-audio B-roll clips (`keepClipAudio: true`). */
  clipAudioSources?: readonly DualExportClipAudioSource[];
  /** Explicit or planned SFX cues. */
  sfxCues?: readonly TransitionSfxCue[];
  sfxMode?: SfxMode;
  storyOverlays?: readonly StoryOverlayItem[];
  /** Resolve a `/api/renders/...`, `/api/stocks/...`, or `http://127.0.0.1:...` media ref to a local path or URL ffmpeg can open. */
  resolveMediaRef?: (src: string) => string | null;
};

export type DualTikTokExportResult =
  | { ok: true; outputMp4Path: string; loudnessApplied: boolean }
  | { ok: false; reason: string };

function defaultResolveLocalMedia(src: string): string | null {
  if (!src) return null;
  if (fs.existsSync(src)) return src;
  const clean = src.split("?")[0] ?? "";
  // Map /api/renders/<f>, /renders/<f>, /api/stocks/<f>, /stocks/<f> under root or public/
  const renderMatch = /(?:^|\/)(?:api\/)?renders\/([^/\\]+)$/.exec(clean);
  if (renderMatch?.[1]) {
    const f = decodeURIComponent(renderMatch[1]);
    const p1 = path.join(process.cwd(), "public", "renders", f);
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(process.cwd(), "renders", f);
    if (fs.existsSync(p2)) return p2;
  }
  const stockMatch = /(?:^|\/)(?:api\/)?stocks\/([^/\\]+)$/.exec(clean);
  if (stockMatch?.[1]) {
    const f = decodeURIComponent(stockMatch[1]);
    const p1 = path.join(process.cwd(), "stocks", f);
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(process.cwd(), "public", "stocks", f);
    if (fs.existsSync(p2)) return p2;
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(src)) {
    return src;
  }
  return null;
}

export async function createDualTikTokSoundMp4(
  input: BuildDualTikTokExportInput,
): Promise<DualTikTokExportResult> {
  const resolveRef = input.resolveMediaRef ?? defaultResolveLocalMedia;
  if (!fs.existsSync(input.masterMp4Path)) {
    return { ok: false, reason: "master_mp4_missing" };
  }
  const durationSec = Math.max(0.5, Number(input.durationSec) || 1);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-tiktok-export-"));

  try {
    const ffmpeg = getFfmpegPath();
    const inputArgs: string[] = ["-i", input.masterMp4Path]; // Input 0 = master video
    const filterParts: string[] = [];
    const mixLabels: string[] = [];
    let nextInputIdx = 1;

    // Base silent stereo bed spanning exact `durationSec` so output audio duration always matches video
    inputArgs.push("-f", "lavfi", "-t", durationSec.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
    const bedIdx = nextInputIdx++;
    filterParts.push(`[${bedIdx}:a]volume=0.0[bed]`);
    mixLabels.push("[bed]");

    // 1. Voice track (if present)
    const resolvedVoice = input.voiceSource ? resolveRef(input.voiceSource) : null;
    if (resolvedVoice) {
      inputArgs.push("-i", resolvedVoice);
      const idx = nextInputIdx++;
      const vol = typeof input.voiceVolume === "number" && Number.isFinite(input.voiceVolume)
        ? Math.max(0, Math.min(2, input.voiceVolume))
        : 1;
      filterParts.push(
        `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${vol.toFixed(4)}[voice]`,
      );
      mixLabels.push("[voice]");
    }

    // 2. Native clip audio windows (`keepClipAudio: true`)
    const clipSources = input.clipAudioSources ?? [];
    for (let c = 0; c < clipSources.length; c += 1) {
      const clip = clipSources[c]!;
      const resolvedClip = resolveRef(clip.src);
      if (!resolvedClip) continue;
      const segDur = Math.max(0.1, clip.endSec - clip.startSec);
      const rate = clip.playbackRate && clip.playbackRate > 0.25 && clip.playbackRate <= 2
        ? clip.playbackRate
        : 1;
      const sourceReadDur = segDur * rate;
      const offsetSec = Math.max(0, clip.clipOffsetSec ?? 0);
      const delayMs = Math.max(0, Math.round(clip.startSec * 1000));
      const vol = typeof clip.volume === "number" && Number.isFinite(clip.volume)
        ? Math.max(0, Math.min(1.5, clip.volume))
        : 1.0;

      inputArgs.push("-ss", offsetSec.toFixed(3), "-t", sourceReadDur.toFixed(3), "-i", resolvedClip);
      const idx = nextInputIdx++;
      const atempoFilter = Math.abs(rate - 1) > 0.02
        ? `,atempo=${Math.max(0.5, Math.min(2.0, rate)).toFixed(3)}`
        : "";
      const fadeOutStart = Math.max(0, segDur - 0.08);
      filterParts.push(
        `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${atempoFilter},afade=t=in:st=0:d=0.06,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.08,volume=${vol.toFixed(4)},adelay=${delayMs}|${delayMs}[clipa${c}]`,
      );
      mixLabels.push(`[clipa${c}]`);
    }

    // 3. Transition & Story Overlay SFX cues
    const baseSfx = input.sfxCues && input.sfxCues.length > 0
      ? [...input.sfxCues]
      : effectiveSfxMode(input.sfxMode) === "subtle"
        ? planTransitionSfxCues({ sfxMode: "subtle", totalDurationSec: durationSec })
        : [];
    const storySfx = planStoryOverlaySfxCues(input.storyOverlays, durationSec);
    const allCues = [...baseSfx, ...storySfx].filter(
      (cue) => cue.timeSec >= 0 && cue.timeSec < durationSec,
    );

    const writtenWavByKind = new Map<TransitionSfxKind, string>();
    for (let s = 0; s < Math.min(28, allCues.length); s += 1) {
      const cue = allCues[s]!;
      let wavPath = writtenWavByKind.get(cue.kind);
      if (!wavPath) {
        wavPath = path.join(tmpDir, `sfx-${cue.kind}.wav`);
        fs.writeFileSync(wavPath, synthesizeTransitionSfxWavBytes(cue.kind));
        writtenWavByKind.set(cue.kind, wavPath);
      }
      const delayMs = Math.max(0, Math.round(cue.timeSec * 1000));
      inputArgs.push("-i", wavPath);
      const idx = nextInputIdx++;
      filterParts.push(
        `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${cue.volumeLinear.toFixed(4)},adelay=${delayMs}|${delayMs}[sfx${s}]`,
      );
      mixLabels.push(`[sfx${s}]`);
    }

    // Mix without amix's 1/N attenuation (`normalize=0` on newer ffmpeg, or compensate `volume=${mixLabels.length}` on 4.4)
    filterParts.push(
      `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0,volume=${mixLabels.length},alimiter=limit=0.95[aout]`,
    );

    const tmpOut = `${input.outputMp4Path}.part.mp4`;
    await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        ...inputArgs,
        "-filter_complex",
        filterParts.join(";"),
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-shortest",
        "-movflags",
        "+faststart",
        tmpOut,
      ],
      { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
    );

    if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 1024) {
      try { fs.rmSync(tmpOut, { force: true }); } catch {}
      return { ok: false, reason: "mux_empty_output" };
    }

    fs.renameSync(tmpOut, input.outputMp4Path);
    const loudnorm = await normalizeFinalAudioLoudness(input.outputMp4Path).catch(() => ({
      applied: false as const,
      reason: "loudnorm_threw",
    }));

    return {
      ok: true,
      outputMp4Path: input.outputMp4Path,
      loudnessApplied: loudnorm.applied,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}
