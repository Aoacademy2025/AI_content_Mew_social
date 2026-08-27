// Run with: npm run verify:story-film-media
import assert from "node:assert/strict";
import {
  parseFfmpegVideoMetadata,
  parseFfprobeVideoMetadata,
} from "../src/lib/video-media-probe.server";

const portrait = parseFfprobeVideoMetadata(JSON.stringify({
  format: { duration: "179.875" },
  streams: [{ codec_type: "video", width: 1080, height: 1920 }],
}));
assert.deepEqual(portrait, { width: 1080, height: 1920, durationMs: 179_875 });
console.log("ok: ffprobe metadata preserves portrait dimensions and millisecond duration");

const rotated = parseFfprobeVideoMetadata(JSON.stringify({
  format: { duration: "42" },
  streams: [{
    codec_type: "video",
    width: 1920,
    height: 1080,
    side_data_list: [{ rotation: -90 }],
  }],
}));
assert.deepEqual(rotated, { width: 1080, height: 1920, durationMs: 42_000 });
console.log("ok: phone rotation metadata is applied before the 9:16 policy check");

const fallback = parseFfmpegVideoMetadata(`
  Duration: 00:02:59.50, start: 0.000000, bitrate: 5000 kb/s
  Stream #0:0: Video: h264, yuv420p(progressive), 1080x1920, 30 fps
`);
assert.deepEqual(fallback, { width: 1080, height: 1920, durationMs: 179_500 });
console.log("ok: ffmpeg fallback reads duration and dimensions when ffprobe is unavailable");

assert.equal(parseFfprobeVideoMetadata("{}"), null);
assert.equal(parseFfmpegVideoMetadata("not media"), null);
console.log("ok: unreadable media fails closed");
