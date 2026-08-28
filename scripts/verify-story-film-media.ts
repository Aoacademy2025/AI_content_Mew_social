// Run with: npm run verify:story-film-media
import assert from "node:assert/strict";
import {
  parseFfmpegVideoMetadata,
  parseFfprobeVideoMetadata,
} from "../src/lib/video-media-probe.server";

const portrait = parseFfprobeVideoMetadata(JSON.stringify({
  format: { duration: "179.875" },
  streams: [
    { codec_type: "video", width: 1080, height: 1920 },
    { codec_type: "audio" },
  ],
}));
assert.deepEqual(portrait, { width: 1080, height: 1920, durationMs: 179_875, hasAudio: true });
console.log("ok: ffprobe metadata preserves portrait dimensions, duration, and narration audio");

const rotated = parseFfprobeVideoMetadata(JSON.stringify({
  format: { duration: "42" },
  streams: [{
    codec_type: "video",
    width: 1920,
    height: 1080,
    side_data_list: [{ rotation: -90 }],
  }, { codec_type: "audio" }],
}));
assert.deepEqual(rotated, { width: 1080, height: 1920, durationMs: 42_000, hasAudio: true });
console.log("ok: phone rotation metadata is applied before the 9:16 policy check");

const fallback = parseFfmpegVideoMetadata(`
  Duration: 00:02:59.50, start: 0.000000, bitrate: 5000 kb/s
  Stream #0:0: Video: h264, yuv420p(progressive), 1080x1920, 30 fps
  Stream #0:1: Audio: aac, 48000 Hz, stereo, fltp
`);
assert.deepEqual(fallback, { width: 1080, height: 1920, durationMs: 179_500, hasAudio: true });
console.log("ok: ffmpeg fallback reads duration, dimensions, and audio when ffprobe is unavailable");

const silent = parseFfprobeVideoMetadata(JSON.stringify({
  format: { duration: "30" },
  streams: [{ codec_type: "video", width: 1080, height: 1920 }],
}));
assert.deepEqual(silent, { width: 1080, height: 1920, durationMs: 30_000, hasAudio: false });
console.log("ok: a silent presenter file is distinguishable before Story Film registration");

assert.equal(parseFfprobeVideoMetadata("{}"), null);
assert.equal(parseFfmpegVideoMetadata("not media"), null);
console.log("ok: unreadable media fails closed");
