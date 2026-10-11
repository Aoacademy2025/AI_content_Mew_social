import type { FfmpegOverrideFn } from "@remotion/renderer";

// Remotion encodes a render's audio with libfdk_aac into a raw ADTS file, then stream-copies it
// into the MP4 (`-i audio.aac -c:a copy`). ADTS has no field for the encoder's priming, so the MP4
// gets no audio edit list and every player plays those 2048 samples of encoder warm-up as if they
// were the start of the voice: the voice lands 42.7 ms (at 48 kHz) after the picture and captions.
// A burn renders the preview again, decodes that late voice and adds its own 2048 → 85.3 ms.
//
// Shifting the copied audio input back by the priming makes ffmpeg's MP4 muxer write the standard
// audio edit list (elst media_time = 2048) — the same thing ffmpeg writes for its own AAC encoder
// (media_time = 1024), which our composite and low-res preview MP4s already carry. Players and the
// next render's decode skip the priming, so the voice starts on time and the lag no longer stacks.
// The audio bytes are untouched: no re-encode, no extra pass.
//
// Fixed values, not probed: Remotion always picks libfdk_aac (AAC-LC, 2048-sample delay) and
// renders audio at 48 kHz unless `sampleRate` is passed, which run-render never does.
// scripts/verify-export-audio-sync.ts measures the real chain and fails if either changes.
const REMOTION_AAC_PRIMING_SAMPLES = 2048;
const REMOTION_AUDIO_SAMPLE_RATE = 48_000;
const PRIMING_OFFSET = (-REMOTION_AAC_PRIMING_SAMPLES / REMOTION_AUDIO_SAMPLE_RATE).toFixed(6); // "-0.042667"

/** renderMedia `ffmpegOverride`: signal the AAC priming of the stitched audio in the MP4 edit list. */
export const signalRemotionAacPriming: FfmpegOverrideFn = ({ type, args }) => {
  if (type !== "stitcher") return args;
  const copy = args.findIndex((arg, i) => arg === "-c:a" && args[i + 1] === "copy");
  if (copy < 0) return args; // no audio in this render
  if (args[copy - 2] !== "-i" || !args[copy - 1]?.endsWith(".aac")) {
    // Remotion changed how it muxes audio. Keep the render working (status-quo lag);
    // verify-export-audio-sync fails in CI on the same change.
    console.warn("[render] unexpected Remotion stitcher audio args — AAC priming left unsignalled");
    return args;
  }
  return [...args.slice(0, copy - 2), "-itsoffset", PRIMING_OFFSET, ...args.slice(copy - 2)];
};
