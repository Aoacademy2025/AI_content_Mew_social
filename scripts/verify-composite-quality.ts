// Run: npx tsx scripts/verify-composite-quality.ts
//
// Verifies the chroma-keying rework (lib/chroma-key.ts): sanitizers, the legacy-default-triple
// auto-detect rule, green auto-detection on BOTH shades (0x12FF05 and 0x00FF00), and that the
// shared composite chain (a) upscales to 1080x1920, (b) applies the CRF/preset encode, and
// (c) leaves NO residual green along the subject boundary. Dumps before/after PNGs for eyeballing.
//
// Uses ONLY the bundled ffmpeg (the exact binary the routes call via getFfmpegPath) so the filter
// syntax is validated against the same build that runs in production.
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  sanitizeChromaColor,
  clampSimilarity,
  clampBlend,
  resolveChromaParams,
  detectChromaColor,
  buildCompositeFilter,
  buildKeyChain,
  resolveCompositeEncode,
  featherSupported,
  _detectCacheSizeForTest,
  DEFAULT_CHROMA_COLOR,
} from "../src/lib/chroma-key";
import { clampAvatarLayout } from "../src/lib/avatar-layout";

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("❌ " + msg); process.exit(1); }
  console.log("✓ " + msg);
  passed++;
}

function ffmpegPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(process.cwd(), "node_modules", "@ffmpeg-installer", `${process.platform}-${process.arch}`, `ffmpeg${ext}`);
}
const FF = ffmpegPath();
if (!fs.existsSync(FF)) { console.error("❌ bundled ffmpeg not found at " + FF); process.exit(1); }

function run(args: string[]): void {
  execFileSync(FF, args, { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}
function runRaw(args: string[]): Buffer {
  return execFileSync(FF, args, { maxBuffer: 64 * 1024 * 1024 });
}
// Probe WxH from ffmpeg -i stderr (avoids a separate ffprobe dependency; bundled build has none).
function probeDims(file: string): { w: number; h: number; codec: string } {
  let stderr = "";
  try { execFileSync(FF, ["-i", file], { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) { stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? ""; }
  const m = stderr.match(/Video:\s*([a-z0-9]+).*?,\s*(\d{2,5})x(\d{2,5})/i);
  return m ? { codec: m[1], w: parseInt(m[2]), h: parseInt(m[3]) } : { codec: "?", w: 0, h: 0 };
}

// Count pixels where green clearly dominates (g - max(r,b) > thr) in a raw rgb24 buffer.
function greenPixels(buf: Buffer, thr = 40): { count: number; maxDom: number } {
  let count = 0, maxDom = 0;
  for (let i = 0; i < buf.length; i += 3) {
    const dom = buf[i + 1] - Math.max(buf[i], buf[i + 2]);
    if (dom > maxDom) maxDom = dom;
    if (dom > thr) count++;
  }
  return { count, maxDom };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "composite-quality-"));
console.log("tmp dir:", tmp);

// ── Synthesize green-screen sources on BOTH shades: skin-tone block (subject) + colored box,
//    encoded yuv420p so keying faces realistic 4:2:0 half-res chroma edges. ──
function makeGreen(color: string, out: string) {
  run([
    "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `color=c=${color}:s=720x1280:d=1:r=15`,
    "-vf", "drawbox=x=210:y=440:w=300:h=560:color=0xC98A6B@1.0:t=fill,drawbox=x=300:y=560:w=120:h=120:color=0x3050C0@1.0:t=fill,format=yuv420p",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
  ]);
}
const green12 = path.join(tmp, "green12.mp4");
const green00 = path.join(tmp, "green00.mp4");
makeGreen("0x12FF05", green12);
makeGreen("0x00FF00", green00);
// magenta bg → any residual green is unambiguously a keying artifact; testsrc2 → human eyeball
const mag = path.join(tmp, "mag.mp4");
const bg = path.join(tmp, "bg.mp4");
run(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0xFF00FF:s=1080x1920:d=1:r=15", "-c:v", "libx264", "-pix_fmt", "yuv420p", mag]);
run(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:d=1:r=15", "-c:v", "libx264", "-pix_fmt", "yuv420p", bg]);

// ── 1. Sanitizers (injection surface) ──
assert(sanitizeChromaColor("0x12ff05") === "0x12FF05", "color sanitizer normalizes valid hex to uppercase");
assert(sanitizeChromaColor("green") === DEFAULT_CHROMA_COLOR, "color sanitizer rejects non-hex → default");
assert(sanitizeChromaColor("0x12FF05; rm -rf /") === DEFAULT_CHROMA_COLOR, "color sanitizer rejects injection payload → default");
assert(sanitizeChromaColor("0xGGGGGG") === DEFAULT_CHROMA_COLOR, "color sanitizer rejects non-hex digits → default");
assert(clampSimilarity(5) === 0.6 && clampSimilarity(0) === 0.01, "similarity clamped to [0.01, 0.6]");
assert(clampSimilarity("x") === 0.28, "similarity non-numeric → default 0.28");
assert(clampBlend(5) === 0.3 && clampBlend(-1) === 0, "blend clamped to [0, 0.3]");
assert(clampBlend("x") === 0.1, "blend non-numeric → default 0.10");

// ── 2. Legacy-default-triple rule ──
assert(resolveChromaParams({}).autoDetect === true, "omitted params → auto-detect");
assert(resolveChromaParams({ chromaColor: "0x12FF05", chromaSimilarity: 0.28, chromaBlend: 0.04 }).autoDetect === true, "legacy triple (0x12FF05/0.28/0.04) → auto-detect");
assert(resolveChromaParams({ chromaColor: "0x00FF00", chromaSimilarity: 0.28, chromaBlend: 0.04 }).autoDetect === true, "legacy triple (0x00FF00/0.28/0.04) → auto-detect");
{
  const r = resolveChromaParams({});
  assert(r.blend === 0.1 && r.similarity === 0.28, "auto-detect path uses blend 0.10 (raised from 0.04) + similarity 0.28");
}
{
  const r = resolveChromaParams({ chromaColor: "0x00AAFF", chromaSimilarity: 0.35, chromaBlend: 0.12 });
  assert(r.autoDetect === false && r.color === "0x00AAFF" && r.similarity === 0.35 && r.blend === 0.12, "deliberate slider values honored verbatim (no auto-detect)");
}
assert(resolveChromaParams({ chromaColor: "0x12FF05", chromaSimilarity: 0.35, chromaBlend: 0.04 }).autoDetect === false, "tuned similarity (0.35) breaks the triple → honor verbatim");
{
  // Fix: custom color with OMITTED similarity/blend must fall back to the LEGACY values (0.28/0.04),
  // not the auto-detect-only blend default (0.10) — "honor verbatim" must actually be verbatim.
  const r = resolveChromaParams({ chromaColor: "0x00CC00" });
  assert(
    r.autoDetect === false && r.color === "0x00CC00" && r.similarity === 0.28 && r.blend === 0.04,
    "custom color + omitted similarity/blend → legacy fallback (0.28/0.04), no auto-detect",
  );
}

// ── 3. Auto-detection on both shades + non-green fallback ──
async function main() {
  const c12 = await detectChromaColor(green12, FF);
  const c00 = await detectChromaColor(green00, FF);
  const cbg = await detectChromaColor(bg, FF); // testsrc2 border is not clearly green
  assert(/^0x[0-9A-F]{6}$/.test(c12) && c12 !== DEFAULT_CHROMA_COLOR, `detect 0x12FF05 clip → green ${c12}`);
  assert(/^0x[0-9A-F]{6}$/.test(c00) && c00 !== DEFAULT_CHROMA_COLOR, `detect 0x00FF00 clip → green ${c00}`);
  assert(cbg === DEFAULT_CHROMA_COLOR, "non-green source → fallback to default");
  // cache: second call returns identical result
  assert((await detectChromaColor(green12, FF)) === c12, "detection cached (stable across calls)");

  // cache cap: 32 entries max, oldest-eviction. Exercise with >32 DISTINCT cache keys (path+mtime+
  // size) by copying the same tiny clip to many filenames — no re-encode needed, just a file copy —
  // then assert the internal cache never grows past the cap.
  const CACHE_PROBE_N = 40;
  for (let i = 0; i < CACHE_PROBE_N; i++) {
    const copyPath = path.join(tmp, `cache-probe-${i}.mp4`);
    fs.copyFileSync(green12, copyPath);
    await detectChromaColor(copyPath, FF);
  }
  assert(_detectCacheSizeForTest() <= 32, `detect cache capped at 32 (size=${_detectCacheSizeForTest()} after ${CACHE_PROBE_N} distinct keys)`);

  // ── 4. Composite over magenta → assert NO residual green, both shades ──
  for (const [label, src, color] of [["12", green12, c12], ["00", green00, c00]] as const) {
    const params = { color, similarity: 0.28, blend: 0.1 };
    const filter = buildCompositeFilter(params, null);
    const rgb = runRaw([
      "-hide_banner", "-loglevel", "error", "-y", "-i", mag, "-i", src,
      "-filter_complex", filter, "-map", "[out]", "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]);
    const g = greenPixels(rgb);
    assert(g.count === 0, `shade ${label}: 0 residual green over magenta (count=${g.count}, maxDominance=${g.maxDom})`);
  }

  // sanity: the measurement HAS teeth — a bad chain (no despill, source-res key) leaves green
  {
    const badFilter = "[0:v]scale=1080:1920:flags=lanczos,setsar=1[bg];[1:v]chromakey=color=0x12FF05:similarity=0.10:blend=0.0[k];[k][bg]scale2ref=iw:ih[fg][bg2];[bg2][fg]overlay=0:0:format=auto[out]";
    const rgb = runRaw(["-hide_banner", "-loglevel", "error", "-y", "-i", mag, "-i", green12, "-filter_complex", badFilter, "-map", "[out]", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    assert(greenPixels(rgb).count > 100, "green-detector has teeth (a deliberately-bad chain DOES leave residual green)");
  }

  // ── 5. Production encode: 1080x1920 h264, CRF/preset applied ── (over complex testsrc2 bg so
  //    the encoded file has a realistic, non-trivial size for the bitrate-sanity check)
  //
  // These assertions call the REAL resolveCompositeEncode() from lib/chroma-key — the exact helper
  // the composite route imports — instead of a hand-built literal args array, so the check actually
  // exercises the env-knob plumbing (COMPOSITE_CRF / COMPOSITE_PRESET) rather than being tautological.
  {
    const def = resolveCompositeEncode();
    assert(def.crf === 18 && def.preset === "veryfast", `default encode = crf 18 / preset veryfast (got ${def.crf}/${def.preset})`);

    process.env.COMPOSITE_CRF = "23";
    assert(resolveCompositeEncode().crf === 23, "COMPOSITE_CRF=23 honored");
    delete process.env.COMPOSITE_CRF;

    process.env.COMPOSITE_CRF = "99";
    assert(resolveCompositeEncode().crf === 18, "COMPOSITE_CRF=99 (out of [0,51]) → falls back to 18");
    delete process.env.COMPOSITE_CRF;

    process.env.COMPOSITE_PRESET = "fast";
    assert(resolveCompositeEncode().preset === "fast", "COMPOSITE_PRESET=fast honored");
    delete process.env.COMPOSITE_PRESET;

    process.env.COMPOSITE_PRESET = "ultrafast -evil";
    assert(resolveCompositeEncode().preset === "veryfast", "COMPOSITE_PRESET with injection payload → falls back to veryfast");
    delete process.env.COMPOSITE_PRESET;

    assert(resolveCompositeEncode().crf === 18 && resolveCompositeEncode().preset === "veryfast", "env restored to defaults after probing");
  }

  const { crf: prodCrf, preset: prodPreset } = resolveCompositeEncode();
  const encArgs = [
    "-hide_banner", "-loglevel", "error", "-y", "-i", bg, "-i", green12,
    "-filter_complex", buildCompositeFilter({ color: c12, similarity: 0.28, blend: 0.1 }, null),
    "-map", "[out]",
    "-c:v", "libx264", "-preset", prodPreset, "-crf", String(prodCrf),
    "-threads", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    path.join(tmp, "final.mp4"),
  ];
  run(encArgs);
  const finalSize = fs.statSync(path.join(tmp, "final.mp4")).size;
  const dims = probeDims(path.join(tmp, "final.mp4"));
  assert(dims.w === 1080 && dims.h === 1920, `composite output upscaled to 1080x1920 (got ${dims.w}x${dims.h})`);
  assert(dims.codec === "h264", `composite output is h264 (got ${dims.codec})`);
  assert(finalSize > 10000, `composite output is a non-trivial file (bitrate sanity, ${finalSize} bytes)`);

  // ── 6. Layout path builds + runs (keys at layout display resolution) ──
  const layout = clampAvatarLayout({ scale: 0.6, offsetX: 100, offsetY: -50 });
  assert(layout !== null, "layout clamps to a non-null geometry");
  const layoutFilter = buildCompositeFilter({ color: c12, similarity: 0.28, blend: 0.1 }, layout);
  run([
    "-hide_banner", "-loglevel", "error", "-y", "-i", bg, "-i", green12,
    "-filter_complex", layoutFilter, "-map", "[out]", "-frames:v", "1",
    path.join(tmp, "layout.png"),
  ]);
  assert(fs.existsSync(path.join(tmp, "layout.png")), "layout composite renders a frame");

  // Canary optimization: keep the exact full-size scale, but crop pixels outside the canvas
  // before chromakey/despill/feather. The final visible frame must remain materially identical.
  const zoomedLayout = clampAvatarLayout({ scale: 2.4, offsetX: 42, offsetY: -80 });
  assert(zoomedLayout !== null, "zoomed canary layout clamps to a non-null geometry");
  const legacyZoomFilter = buildCompositeFilter(
    { color: c12, similarity: 0.28, blend: 0.1 },
    zoomedLayout,
    true,
    [],
    false,
  );
  const croppedZoomFilter = buildCompositeFilter(
    { color: c12, similarity: 0.28, blend: 0.1 },
    zoomedLayout,
    true,
    [],
    true,
  );
  assert(/crop=/.test(croppedZoomFilter), "canary layout crops off-canvas pixels before the key chain");
  assert(!/crop=/.test(legacyZoomFilter), "non-canary layout keeps the legacy filter graph");
  const legacyFrame = runRaw([
    "-hide_banner", "-loglevel", "error", "-y", "-i", bg, "-i", green12,
    "-filter_complex", legacyZoomFilter, "-map", "[out]", "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  const croppedFrame = runRaw([
    "-hide_banner", "-loglevel", "error", "-y", "-i", bg, "-i", green12,
    "-filter_complex", croppedZoomFilter, "-map", "[out]", "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  assert(legacyFrame.length === croppedFrame.length, "canary and legacy frames have identical dimensions");
  let absoluteError = 0;
  for (let i = 0; i < legacyFrame.length; i++) absoluteError += Math.abs(legacyFrame[i] - croppedFrame[i]);
  const meanAbsoluteError = absoluteError / legacyFrame.length;
  assert(meanAbsoluteError <= 0.5, `canary crop is visually equivalent (mean absolute RGB error=${meanAbsoluteError.toFixed(4)})`);

  // key chain is self-sanitizing even if handed garbage
  assert(!buildKeyChain({ color: "evil; rm", similarity: 99, blend: -5 }).includes("evil"), "buildKeyChain re-sanitizes an unsafe color");

  // ── 7. featherSupported() guard — the composite ffmpeg call errors (not fail-open) if the
  //    binary lacks erosion/gblur (dev=darwin-arm64, prod=linux-x64 peer build), so callers must
  //    probe first and drop feathering when unsupported. ──
  {
    const supported = await featherSupported(FF);
    assert(supported === true, `featherSupported(bundled ffmpeg) === true (this machine's build ships erosion+gblur)`);

    const noFeatherChain = buildKeyChain({ color: c12, similarity: 0.28, blend: 0.1 }, false);
    assert(!/erosion|gblur/.test(noFeatherChain), "feather:false chain contains no erosion/gblur");

    const noFeatherFilter = buildCompositeFilter({ color: c12, similarity: 0.28, blend: 0.1 }, null, false);
    const rgbNoFeather = runRaw([
      "-hide_banner", "-loglevel", "error", "-y", "-i", mag, "-i", green12,
      "-filter_complex", noFeatherFilter, "-map", "[out]", "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]);
    assert(greenPixels(rgbNoFeather).count === 0, `feather:false chain still keys with 0 residual green (count=${greenPixels(rgbNoFeather).count})`);

    const bogusSupported = await featherSupported("/no/such/ffmpeg-binary-xyz");
    assert(bogusSupported === false, "featherSupported(bogus path) → false, fail-open, no throw");
  }

  // ── 8. Before/after PNG dumps over testsrc2 for human eyeball ──
  const dumps: string[] = [];
  for (const [label, src, color] of [["12", green12, c12], ["00", green00, c00]] as const) {
    const before = path.join(tmp, `before_${label}_greenscreen.png`);
    const after = path.join(tmp, `after_${label}_composited.png`);
    run(["-hide_banner", "-loglevel", "error", "-y", "-ss", "0.3", "-i", src, "-frames:v", "1", before]);
    run([
      "-hide_banner", "-loglevel", "error", "-y", "-i", bg, "-i", src,
      "-filter_complex", buildCompositeFilter({ color, similarity: 0.28, blend: 0.1 }, null),
      "-map", "[out]", "-frames:v", "1", after,
    ]);
    dumps.push(before, after);
  }

  console.log(`\n${passed} checks passed`);
  console.log("\nPNG dumps for human eyeball:");
  for (const d of dumps) console.log("  " + d);
  console.log("  " + path.join(tmp, "layout.png") + "  (layout path)");
  console.log("  " + path.join(tmp, "final.mp4") + "  (encoded composite)");
}

main().catch((e) => { console.error("❌ unexpected error:", e); process.exit(1); });
