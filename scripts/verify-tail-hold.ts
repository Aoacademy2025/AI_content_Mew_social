// EP5 backlog #14: `tailHoldMs` — hold the last video frame for N ms after the voice ends.
//
// Three layers:
//  1. clampTailHoldMs bounds (unit).
//  2. buildV2BurnConfig math: default (no tailHoldMs arg) produces byte-identical output to
//     today, including OMITTING the `tailHoldFrames` key — the "defaults must not change
//     existing videos" rule from wave2-common.md (unit).
//  3. parsePendingEditDraft / seedPendingEditDraft / toBurnConfig round-trip the field, and a
//     legacy draft/snapshot with no `tailHoldMs` at all reads as 0 (unit).
//  4. A REAL Remotion render of the actual SubtitleOverlayComposition proves the Freeze wrap
//     holds the last base frame during the hold instead of letting the source video play
//     through — the one part no amount of unit testing can stand in for.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { clampTailHoldMs, TAIL_HOLD_MS_MAX, TAIL_HOLD_MS_MIN } from "../src/lib/tail-hold";
import { buildV2BurnConfig, DEFAULT_V2_SUB, type V2Caption } from "../src/app/(dashboard)/video-editor/_v2/subtitle-style";
import { normalizeEditorExportDraft } from "../src/lib/editor-export-snapshot";

const FPS = 30;

function verifyClamp() {
  assert.equal(clampTailHoldMs(undefined), 0);
  assert.equal(clampTailHoldMs(null), 0);
  assert.equal(clampTailHoldMs(-500), TAIL_HOLD_MS_MIN);
  assert.equal(clampTailHoldMs(500_000), TAIL_HOLD_MS_MAX);
  assert.equal(clampTailHoldMs(1234.6), 1235);
  assert.equal(clampTailHoldMs("not a number" as unknown), 0);
  console.log("✓ clampTailHoldMs clamps to 0-3000, defaults non-numbers to 0");
}

function verifyBurnConfigMath() {
  const captions: V2Caption[] = [{ text: "สวัสดี", startMs: 0, endMs: 2_000 }];
  const withoutArg = buildV2BurnConfig("v.mp4", captions, 2_000, DEFAULT_V2_SUB, FPS, {});
  const explicitZero = buildV2BurnConfig("v.mp4", captions, 2_000, DEFAULT_V2_SUB, FPS, {}, undefined, undefined, undefined, 0);
  assert.deepEqual(withoutArg, explicitZero, "omitting tailHoldMs must equal passing 0 explicitly");
  assert.equal("tailHoldFrames" in withoutArg, false, "0 must omit tailHoldFrames (today's exact shape)");
  console.log("✓ buildV2BurnConfig: tailHoldMs omitted/0 reproduces today's exact output shape");

  const held = buildV2BurnConfig("v.mp4", captions, 2_000, DEFAULT_V2_SUB, FPS, {}, undefined, undefined, undefined, 1_000);
  assert.equal(held.tailHoldFrames, 30, "1000ms @30fps = 30 extra frames");
  assert.equal(held.durationInFrames, withoutArg.durationInFrames + 30);
  console.log("✓ buildV2BurnConfig: tailHoldMs=1000 adds exactly 30 frames (fps=30) to durationInFrames");

  // Out-of-range input is clamped, not passed through raw.
  const clamped = buildV2BurnConfig("v.mp4", captions, 2_000, DEFAULT_V2_SUB, FPS, {}, undefined, undefined, undefined, 999_999);
  assert.equal(clamped.tailHoldFrames, Math.round((TAIL_HOLD_MS_MAX / 1000) * FPS));
  console.log("✓ buildV2BurnConfig clamps an out-of-range tailHoldMs before converting to frames");
}

function verifyEditorExportDraftLegacy() {
  const basePreview = {
    videoUrl: "v.mp4",
    audioDurationMs: 2_000,
    captions: [{ text: "hi", startMs: 0, endMs: 2_000 }],
    config: {},
    voiceUrl: "a.mp3",
  };
  // EditorExportDraft: a legacy snapshot object with no tailHoldMs normalizes fine (absent),
  // and a present value normalizes too.
  const legacyEditorDraft = normalizeEditorExportDraft({
    version: 1,
    captions: basePreview.captions,
    originalCaptions: basePreview.captions,
    subtitleConfig: DEFAULT_V2_SUB,
    cardLen: "sentence",
    captionOverrides: {},
  });
  assert.ok(legacyEditorDraft);
  assert.equal(legacyEditorDraft!.tailHoldMs, undefined, "a legacy snapshot has no tailHoldMs field at all");
  const editorDraftWithHold = normalizeEditorExportDraft({ ...legacyEditorDraft, tailHoldMs: 900 });
  assert.equal(editorDraftWithHold?.tailHoldMs, 900);
  console.log("✓ normalizeEditorExportDraft: absent tailHoldMs stays absent; a present value normalizes");
}

function ffmpeg(args: string[]): Buffer {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")} exited ${result.status}: ${result.stderr.toString().slice(-800)}`);
  }
  return result.stdout;
}

/** All decoded frames' (pts_time, YAVG) pairs, in order. */
function lumaSeries(file: string, workDir: string): Array<{ ptsTime: number; yavg: number }> {
  const stats = path.join(workDir, `${path.basename(file)}.yavg.txt`);
  ffmpeg([
    "-i", file,
    "-map", "0:v:0",
    "-vf", `signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file='${stats}'`,
    "-f", "null", "-",
  ]);
  const series: Array<{ ptsTime: number; yavg: number }> = [];
  let ptsTime: number | null = null;
  for (const line of readFileSync(stats, "utf8").split("\n")) {
    const frame = line.match(/pts_time:(-?[0-9.]+)/);
    if (frame) {
      ptsTime = Number(frame[1]);
      continue;
    }
    const yavg = line.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
    if (yavg && ptsTime !== null) series.push({ ptsTime, yavg: Number(yavg[1]) });
  }
  return series;
}

function lumaNear(series: Array<{ ptsTime: number; yavg: number }>, timeSec: number): number {
  let best = series[0];
  for (const entry of series) {
    if (Math.abs(entry.ptsTime - timeSec) < Math.abs(best.ptsTime - timeSec)) best = entry;
  }
  return best.yavg;
}

function serve(dir: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    const file = path.join(dir, name);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size, "Access-Control-Allow-Origin": "*" });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// BT.601 luma for pure red/green/blue is ~76 / ~150 / ~29 — far enough apart that signalstats'
// YAVG alone (no chroma decode needed) tells the three segments apart.
const RED_Y = 76;
const GREEN_Y = 150;
const BLUE_Y = 29;
const BUCKET_TOLERANCE = 15;

async function verifyRealRender() {
  const work = mkdtempSync(path.join(tmpdir(), "tail-hold-"));
  const publicDir = mkdtempSync(path.join(tmpdir(), "tail-hold-public-"));
  let server: http.Server | null = null;
  let serveUrl: string | null = null;
  try {
    // 90 frames @30fps = 3s: red (0-29), green (30-59), blue (60-89). Luma-only is enough to
    // tell them apart (see constants above), so cb/cr stay at neutral grey.
    const segments = path.join(work, "segments.mp4");
    ffmpeg([
      "-y", "-f", "lavfi",
      "-i", `color=c=black:s=180x320:r=${FPS}:d=3,format=yuv420p,` +
        `geq=lum='if(lt(N\\,30)\\,${RED_Y}\\,if(lt(N\\,60)\\,${GREEN_Y}\\,${BLUE_Y}))':cb=128:cr=128`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-bf", "0", segments,
    ]);

    server = await serve(work);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    serveUrl = await bundle({
      entryPoint: path.resolve("scripts/fixtures/tail-hold-remotion.tsx"),
      publicDir,
      webpackOverride: (config) => config,
    });

    const render = async (id: string, output: string) => {
      const inputProps = { videoUrl: `${base}/segments.mp4` };
      const composition = await selectComposition({ serveUrl: serveUrl!, id, inputProps });
      await renderMedia({ composition, serveUrl: serveUrl!, codec: "h264", outputLocation: output, inputProps, logLevel: "error" });
      return output;
    };

    const off = await render("TailHoldOff", path.join(work, "off.mp4"));
    const on = await render("TailHoldOn", path.join(work, "on.mp4"));

    const offSeries = lumaSeries(off, work);
    const offLast = lumaNear(offSeries, 59 / FPS);
    assert.ok(Math.abs(offLast - GREEN_Y) < BUCKET_TOLERANCE, `tailHoldFrames=0: last frame should be green (got Y=${offLast})`);
    console.log(`✓ TailHoldOff (today's behaviour): composition ends at its own last frame (Y=${offLast.toFixed(0)} ≈ green)`);

    const onSeries = lumaSeries(on, work);
    const onAtHold = lumaNear(onSeries, 75 / FPS); // deep inside the 30-frame hold window
    assert.ok(
      Math.abs(onAtHold - GREEN_Y) < BUCKET_TOLERANCE,
      `tailHoldFrames=30: frame 75 must be FROZEN on the last base frame (green, Y≈${GREEN_Y}), not the source's own blue segment (Y≈${BLUE_Y}) — got Y=${onAtHold}`,
    );
    assert.ok(
      Math.abs(onAtHold - BLUE_Y) > BUCKET_TOLERANCE,
      "frame 75 must NOT show the source's blue segment — the Freeze wrap did not hold",
    );
    console.log(`✓ TailHoldOn: frame 75 (inside the hold) is frozen on the last base frame (Y=${onAtHold.toFixed(0)} ≈ green), not the source's own blue segment`);

    const offDurationMs = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", off]).stdout.toString().trim()) * 1000;
    const onDurationMs = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", on]).stdout.toString().trim()) * 1000;
    assert.ok(onDurationMs - offDurationMs > 900, `the held export must be ~1s (30 frames @30fps) longer: off=${offDurationMs}ms on=${onDurationMs}ms`);
    console.log(`✓ the held export's container duration is ~1s longer (off=${offDurationMs.toFixed(0)}ms, on=${onDurationMs.toFixed(0)}ms) — video/BGM both extend to cover the hold`);
  } finally {
    server?.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(publicDir, { recursive: true, force: true });
    if (serveUrl) rmSync(serveUrl, { recursive: true, force: true });
  }
}

async function main() {
  verifyClamp();
  verifyBurnConfigMath();
  verifyEditorExportDraftLegacy();
  await verifyRealRender();
  console.log("\n✅ TAIL HOLD CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
